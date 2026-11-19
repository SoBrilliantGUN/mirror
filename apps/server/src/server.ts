// 实时通话服务：HTTP 信令（/rtc/offer）+ 串 ASR → L3 大脑 → TTS → WebRTC。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DependenceSignals, MoodState, Persona, VocalizationEvent, MemoryKind } from '@mirror/contracts';
import { loadConfig, loadDotEnv } from './config';
import { createRtcPeer } from './rtc/webrtc';
import { ParaformerRealtimeASR } from './speech/paraformerRealtime';
import { streamTTS, isNetworkError, isRateLimitError, type RealtimeTTSInput } from './speech/cosyvoiceRealtime';
import { AcousticFeatureExtractor } from './speech/acousticFeatures';
import { NlsSoundEventDetector } from './speech/nlsSoundEvent';
import { normalizePersonaName } from './speech/nameNormalizer';
import { VocalEventAggregator, type DominantVocal } from './speech/vocalEvents';
import { buildInstruction, EMOTION_PROSODY, tailHint } from './speech/emotionInstruction';
import { BackchannelEngine, BACKCHANNEL_PHRASES, concatPcm, hasVoicePcm } from './speech/backchannel';
import { DeepSeek, type ChatMessage, type ToolCall } from './llm/deepseek';
import { createEmbedder } from './llm/embedding';
import { PERSONAS, resolvePersona, resolvePersonaDetails, resolveVoice } from './persona';
import { GREETINGS, GREETINGS_EN } from './persona/greetings';
import { createPersonaMatcher, type PersonaDetail } from './persona/loadPersona';
import { ModeTracker } from './brain/modeTracker';
import { CoachTracker } from './brain/coach';
import { createTimeAware, shanghaiParts } from './brain/timeAware';
import { loadHolidayMap } from './brain/holiday';
import { planTurn } from './brain/turn';
import { evaluateDisinterest, evaluatePerfunctory } from './brain/interest';
import { SEARCH_TOOL, pickFiller } from './brain/search';
import { bochaSearch } from './search/bocha';
import { streamMessages, streamMessagesWithTools, generateProactiveText, extractAwaits } from './brain/generate';
import { recallContext, buildTurnMessages } from './brain/assemble';
import { consolidateTurn, prefetchNextTurn, createPrefetchCache } from './brain/consolidate';
import { consolidateGoal } from './brain/goalConsolidate';
import { consolidateSelfAdded, touchSelfAdded, SELF_ADDED_TTL_DAYS } from './brain/selfAdd';
import { classifyMemory } from './brain/memoryClassifier';
import { dreamOnMemory } from './brain/dream';
import { classifySegmentEmotion } from './brain/segmentEmotion';
import { createSummarizer, compressHistory } from './brain/compress';
import { summarizeCall, compressSummaries } from './brain/recentSummary';
import { buildProactiveSystemPrompt } from './brain/prompts';
import { buildCuriosityHint } from './brain/ontology';
import { buildGoalFollowUpHint, type HistoryEntry } from './brain/context';
import { createContactsStore } from './store/contacts';
import { createMemoryStore } from './store/memory';
import { createAskedQuestionsStore } from './store/askedQuestions';
import { createConversationSummariesStore } from './store/conversationSummaries';
import { createSelfAddedStore } from './store/selfAdded';
import { createGoalsStore } from './store/goals';
import { createPool, ensureSchema } from './store/db';
import { EmptyContextProvider, neutralAcoustic } from './stubs';
import { SafetyGuard } from './brain/safety';
import { CRISIS_RESOURCES } from './brain/crisisResources';
import { createSessionsStore } from './store/sessions';
import { createTranscriptStore } from './store/transcript';
import { createObs } from './obs/langfuse';

// 语气词附和（「嗯/哦/啊/好/对/是/唔」及其重复）：抢话语境下判定为附和、不算真实打断。
function isFillerText(text: string): boolean {
  const t = text.replace(/[。，！？!?,\s]/g, '');
  if (!t) return false;
  return /^[嗯哦啊好对是唔]+$/.test(t);
}

// 英文模式：按语言在系统提示词尾部追加语言要求（沉浸式 / 纠错教学）。
function buildLanguagePrompt(base: string, lang: 'zh' | 'en', englishMode: 'immersion' | 'coach'): string {
  if (lang !== 'en') return base;
  const mode = englishMode === 'coach'
    ? '用户练英语，若其语法/用词明显有误，请温和自然地顺带点出更地道的表达，但别频繁打断，优先保证对话流畅。'
    : '自然流畅地陪用户用英文聊天即可，不要刻意纠错。';
  return `${base}\n\n[语言要求] 本轮请全程用英文交流（自然、口语化的 English，不要用中文）。用户正在练习英语。${mode}`;
}

export async function main() {
  // 桌面版由 Electron 主进程注入 env（不读 .env）；`npm start` 仍读 .env。
  if (process.env.MIRROR_SKIP_DOTENV !== '1') loadDotEnv();
  const cfg = loadConfig();
  console.log(cfg.bochaApiKey ? '[search] 联网搜索已启用（BOCHA_API_KEY 已配）' : '[search] 联网搜索关闭（未配 BOCHA_API_KEY，模型不会调用 search_web）');

  // 通讯录持久化：Postgres（见 infra/postgres）。连不上则明确报错，避免带病跑。
  const pool = createPool(cfg.databaseUrl);
  try {
    await ensureSchema(pool);
  } catch (e) {
    console.error('⚠️ 连不上 Postgres（' + cfg.databaseUrl + '）。先跑：cd infra/postgres && docker compose up -d');
    throw e;
  }
  const contacts = createContactsStore(pool);
  await contacts.seedDefaults(); // 新库首次启动预置默认伙伴（苏明悦），见 store/contacts.ts
  const sessions = createSessionsStore(pool); // 通话会话记录（L4 过度依赖的行为信号来源）
  const transcript = createTranscriptStore(pool); // 逐轮聊天记录（导出/优化用）

  // 可观测：包装 LLM/embedding，运行时通话埋点（无 LANGFUSE key 时整体 no-op）。
  const obs = createObs({ publicKey: cfg.langfusePublicKey, secretKey: cfg.langfuseSecretKey, baseUrl: cfg.langfuseBaseUrl });
  const llm = obs.wrapLlm(new DeepSeek({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl }), 'deepseek');
  // L4 安全红线小模型（阿里云百炼 qwen，OpenAI 兼容端点，复用 DashScope key）。
  const safetyLlm = obs.wrapLlm(new DeepSeek({ apiKey: cfg.dashscopeApiKey, baseUrl: cfg.safetyBaseUrl }), 'safety-qwen');
  // 长期记忆：embedding（百炼）+ pgvector 混合召回。未配 embedding key 时 recall 降级为空记忆。
  const embedder = obs.wrapEmbedder(createEmbedder({ apiKey: cfg.embeddingApiKey, baseUrl: cfg.embeddingBaseUrl, model: cfg.embeddingModel }), 'embed', cfg.embeddingModel);
  const memory = createMemoryStore(pool, embedder, { recallTopK: cfg.memoryRecallTopK });
  const askedQuestions = createAskedQuestionsStore(pool); // 近 3 天已问过的问题（防重复提问）
  const conversationSummaries = createConversationSummariesStore(pool); // 最近 3 天对话概要（跨通话「最近聊过什么」）
  const selfAdded = createSelfAddedStore(pool); // 人设增补：陪伴者底座之外的软细节
  const goals = createGoalsStore(pool); // 成长课题：Life Coach 的跨会话轨迹（重骨架）
  const holidayMap = await loadHolidayMap(shanghaiParts(new Date()).year); // 节假日/工作日判定（缓存优先，miss 联网查）
  const timeAware = createTimeAware(memory, holidayMap); // 时间感知（L5）：时间上下文 + 临近日期 + 作息关怀
  const summarizer = createSummarizer(llm, cfg.generateModel);
  // 上下文窗口预算（参考 kima 六层：压缩只打 L5 历史；这里给 L2 记忆与 L5 历史两个粗略预算）。
  const memoryBudget = Math.floor(cfg.contextMaxTokens * 0.35);
  const historyBudget = Math.floor(cfg.contextMaxTokens * 0.5);
  const userId = 'demo-user'; // 尚未有账号体系，先固定单用户；接鉴权后按会话取 userId。

  const context = await new EmptyContextProvider().get(userId);
  let tracker = new ModeTracker(); // 会话级（L5）：每通重置
  let coachTracker = new CoachTracker(); // 会话级交互框架（friend/coach）：每通重置
  let goalFollowUpDone = false; // 主动追问「后来呢」每通只一次（新通话首轮触发后锁住）
  let coachCheckinDone = false; // 教练态沉默：是否已轻轻确认过（确认后若还沉默 → 下一阶段温柔收尾）
  let mood: MoodState | null = null; // 会话级（L5）：每通重置
  let persona: Persona = resolvePersona('程书衡')!; // 默认接程书衡（首位、恒上线）；/rtc/offer 时按 name 覆盖
  let lang: 'zh' | 'en' = 'zh'; // 通话语言（/rtc/offer 传入，英文模式喂给 ASR/招呼语/提示词）
  let englishMode: 'immersion' | 'coach' = 'immersion'; // 英文模式二级开关：沉浸式 / 纠错教学
  let personaMatcher: ((text: string) => Promise<PersonaDetail[]>) | null = null; // 人物详情语义匹配器（character/ 存在时启用）
  let safetyGuard = new SafetyGuard({ llm: safetyLlm, model: cfg.safetyModel }); // 会话级（L4）：每通重置 episode
  let currentSessionId: string | null = null; // 当前通话的会话记录 id（挂断/重连时补 ended_at）

  // 会话级状态
  let rtc: ReturnType<typeof createRtcPeer> | null = null;
  let asr: ParaformerRealtimeASR | null = null;
  let acoustic: AcousticFeatureExtractor | null = null; // 副语言特征（L0）
  let sed: NlsSoundEventDetector | null = null; // 哭/笑检测（NLS 声音事件，L2）
  let pendingVocals = new VocalEventAggregator(); // 本轮待附着的哭/笑事件（聚合加权）
  let vocalTimer: ReturnType<typeof setTimeout> | null = null; // 纯哭/纯笑无字触发去抖
  let lastVocalRespondAt = 0; // 上次纯发声回应的墙钟时间（防「一句话说两遍」）
  let currentGeneration = 0; // 代次：每次 respond 或打断都 +1，旧一轮自动作废
  let currentAbort: AbortController | null = null; // 本轮 TTS 的取消信号
  // 待答义务：一次 isFinal 用户话 = 一条「必须回」的债。被打断（咳嗽）先停声，没新话则重答兜底。
  let lastUserTurn: { text: string; vocals: VocalizationEvent[]; dominantVocal: DominantVocal } | null = null;
  let reanswerTimer: ReturnType<typeof setTimeout> | null = null;
  let reanswerCount = 0; // 同一条债已重答次数（防持续咳嗽无限重答）
  let history: HistoryEntry[] = []; // 会话历史（L5，唯一压缩对象；每轮 append，压缩在 assembleTurn 内做）
  let recentSummaryText = ''; // 最近 3 天对话概要（通话前加载一次，注入 [RECENT]）
  let turnCount = 0; // 累计轮次（L1 状态快照用）
  let loadedDetails: PersonaDetail[] = []; // 人物详情渐进式加载缓存（会话内命中即驻留，不卸载）
  const prefetchCache = createPrefetchCache(); // look-ahead 预取缓存（后台预热，命中并入下一轮 eager 召回）

  // 主动发话（全部程序计时，不靠 LLM 自觉）：一联通就打招呼；提问后 5s 没答就自问自答；
  // 连续 2 次没答就失落收尾；非问句结尾则沉默 2s 轻问一次（每段静默只一次）。
  const NUDGE_MS = 2000;
  const FOLLOWUP_MS = 5000;
  const NO_REPLY_LIMIT = 3; // 1 次没答→自问自答，2 次→问"还在吗"，3 次→情绪化收尾
  const COACH_SILENT_MS = 30000; // 教练态沉默：等这么久才轻轻确认一次（比朋友态 nudge 长 3 倍）
  const COACH_CLOSE_MS = 30000;  // 确认「还在吗」后若仍无回应，再等这么久就温柔收尾（留门 + 挂断）
  const MIN_SEARCH_MS = 1500; // 搜索即使秒回也留的自然延迟（像人查东西）
  const REANSWER_MS = 2500; // 误打断（咳嗽/底噪）后，等这么久没新话就重答，保证"说了话必回"（放宽到 2.5s，别盖着慢语速用户说话）
  const REANSWER_LIMIT = 2; // 同一条用户话最多重答几次（防持续咳嗽导致的无限重答）
  const INTERRUPT_GRACE_MS = 700; // VAD 抢话后给 ASR 的判定期：判出只是语气词附和就不打断，判不出再真打断
  const TOPIC_DRIFT_LIMIT = 3; // 连续 3 轮都以问句结尾 = 追问太密 → 下一轮主动换话题（治"逮着一个点连问"）

  // 道别检测改由模型判定（brain/turn.ts 的 classifyFarewell 在决策阶段并行跑），不再用关键词正则。
  // plan.farewell 为 true 时：回一句道别收尾 → 别再主动发话（nudge/followup），等 10s 挂断；
  // 用户继续搭话则 markUserVoice 取消挂断。误判代价低（用户一开口就取消）。
  // 是否在向用户提问。优先用生成阶段顺带输出的 awaitsResponse 标签（语义判断，见 generate.ts extractAwaits），
  // 模型漏打标签时回退正则。用「句子里出现过问号」判断，而不是 endsWith('？')：
  // 主动发话常在问句后加软垫（"说来听听。" / "我听着。"），endsWith 会把这种真问句漏判成陈述，
  // 导致 idleFired 又拦住 nudge → 问完就整段死寂（正是"大段空白"的根因）。
  const isAsking = (text: string) => /[？?]/.test(text);
  let lastUserVoiceAt = Date.now(); // 最近一次有人发声的墙钟时间（静默计时基准）
  let idleFired = false;            // 本轮静默是否已轻问过（防话痨）
  let lastTurnAskedQuestion = false; // 上一轮陪伴者是否以问句结尾（触发 5s 追问）
  let lastQuestionText = '';         // 上一轮问句的文本（followup 自问自答用）
  let lastCuriosityHint = '';        // 最近一轮好奇心缺口线索（nudge 找话题复用）
  let noReplyStreak = 0;            // 连续几次提问用户没答（≥2 则失落收尾）
  let disinterestStreak = 0;        // 连续「唤醒低+回复慢」计数（≥3 换话题）
  let perfunctoryStreak = 0;        // 连续「敷衍（短/空回复）」计数（≥2 换话题）
  let consecutiveQuestions = 0;     // 连续几轮陪伴者以问句结尾（追问太密 → 主动换话题）
  const userSaid: string[] = [];   // 会话小笔记本：本次通话里对方说过的、抽取压缩后的信息（累积、不滑窗；防重复问/矛盾，跨通话靠长期记忆）
  let prevTurnMemoryIds: string[] = []; // 上一轮写入的记忆 id → 本轮纠正时按 id 精确撤销
  let agentDoneAt = 0;              // 陪伴者说完的墙钟时间（onPlaybackEnd 更新）
  let lastReplyLatencyMs = 0;       // 最近一次「说完→开口」的间隔（markUserVoice 记）
  let recentVoiceAt = 0;            // 最近一次用户麦克风有真声能的墙钟时间（幻听 ASR 门控基准）
  let agentAudible = false;         // 陪伴者是否真的在「出音频」（TTS 推流中）——区分回声 vs 生成中用户抢话
  let idleTimer: ReturnType<typeof setTimeout> | null = null; // 静默超时定时器
  let speaking = false;             // 陪伴者是否正在说话（避免主动发话抢话）
  let userGender: '男' | '女' | null = null; // 从语音判出的对方性别（会话级，判出即锁；null=还没判出）
  let lastWasFarewell = false;      // 上一轮是否说了"不打扰"（说完后挂断用）
  let hangupTimer: ReturnType<typeof setTimeout> | null = null; // 挂断定时器
  let pendingInterrupt = false; // VAD 抢话待判：等 ASR 确认是「语气词附和」还是「真实抢话」
  let interruptGraceTimer: ReturnType<typeof setTimeout> | null = null; // 抢话判定期定时器
  let lastBargeInAt = 0; // 最近一次真打断的墙钟时间（判定期过后迟到的语气词 final 也算附和）

  // 副语言 backchannel（附和）：用户长段倾诉时轻声应一句，给「被听见感」不打断。onEmit 经闭包引用当前 rtc。
  const backchannel = new BackchannelEngine(
    { silenceMs: 500, cooldownMs: 15000, maxPerTurn: 6, gain: 0.5, minSpeechMs: 30000 },
    (pcm, gain) => rtc?.pushAgentPcm(pcm, gain),
  );

  // 预生成某音色的 backchannel 片段（懒、逐音色缓存），用 streamTTS 出 24kHz PCM。
  async function preloadBackchannelClips(voice: string, name: string): Promise<void> {
    const clips: Uint8Array[] = [];
    for (const phrase of BACKCHANNEL_PHRASES) {
      const parts: Uint8Array[] = [];
      for await (const pcm of streamTTS({
        wsUrl: cfg.dashscopeWsUrl,
        apiKey: cfg.dashscopeApiKey,
        model: cfg.cosyvoiceModel,
        voice,
        instruction: buildInstruction('natural', persona.voiceTint) + '。这句要轻声、短促，像随口应一声，不抢话。',
        text: phrase,
        rate: persona.rate ?? 1.0,
      })) parts.push(pcm);
      clips.push(concatPcm(parts));
    }
    backchannel.setClips(voice, clips);
    console.log(`[backchannel] ${name} 片段就绪（${clips.length} 句）`);
  }

  // 招呼语缓存：每人几句（按人设写）、随机放，预生成、按音色缓存，接通即放（不等 LLM/TTS）。
  // 磁盘缓存：合成结果落盘（.greetings-cache/），重启后直接读文件、不再烧 TTS；改了招呼语就删掉该目录。
  const greetingClips = new Map<string, Uint8Array[]>(); // voice → 招呼语音频片段
  const greetingPhrases = new Map<string, string[]>(); // voice → 招呼语文本（与 clips 下标对齐，供文字记录/落库）
  // 桌面版由 Electron 主进程注入到 userData 下；`npm start` 仍用仓库相对路径。
  const GREETING_CACHE_DIR = process.env.GREETING_CACHE_DIR ?? join(process.cwd(), 'apps', 'server', '.greetings-cache');
  const greetingInFlight = new Map<string, Promise<void>>(); // voice → 合成中，防并发重复烧 TTS

  // 序列化：uint32 片段数 + 每个片段的 uint32 字节长 + 原始 PCM 拼接。
  function serializeGreetingClips(clips: Uint8Array[]): Buffer {
    const header = Buffer.alloc(4 + clips.length * 4);
    header.writeUInt32LE(clips.length, 0);
    clips.forEach((c, i) => header.writeUInt32LE(c.length, 4 + i * 4));
    return Buffer.concat([header, ...clips.map((c) => Buffer.from(c))]);
  }

  function deserializeGreetingClips(buf: Buffer): Uint8Array[] {
    const count = buf.readUInt32LE(0);
    const clips: Uint8Array[] = [];
    let off = 4 + count * 4;
    for (let i = 0; i < count; i++) {
      const len = buf.readUInt32LE(4 + i * 4);
      clips.push(new Uint8Array(buf.subarray(off, off + len)));
      off += len;
    }
    return clips;
  }

  // 磁盘缓存 key 带招呼语文本哈希：改了招呼语（GREETINGS 文本变）哈希就变，自动失效旧缓存，
  // 避免「改了招呼语却还读到旧音频（比如旧缓存里带『上午好/中午好』这类时间词）」。旧文件成为孤儿缓存，无害。
  function greetingCacheKey(voice: string, phrases: string[]): string {
    const digest = createHash('sha1').update(phrases.join('\n')).digest('hex').slice(0, 12);
    return `${voice}.${digest}.pcm`;
  }

  function loadGreetingClipsFromDisk(filename: string): Uint8Array[] | null {
    const file = join(GREETING_CACHE_DIR, filename);
    if (!existsSync(file)) return null;
    try {
      const clips = deserializeGreetingClips(readFileSync(file));
      return clips.length > 0 ? clips : null;
    } catch (e) {
      console.warn('[greeting] 读磁盘缓存失败，将重新合成：', e);
      return null;
    }
  }

  function saveGreetingClipsToDisk(filename: string, clips: Uint8Array[]): void {
    try {
      mkdirSync(GREETING_CACHE_DIR, { recursive: true });
      writeFileSync(join(GREETING_CACHE_DIR, filename), serializeGreetingClips(clips));
    } catch (e) {
      console.warn('[greeting] 写磁盘缓存失败（不影响内存缓存）：', e);
    }
  }

  async function preloadGreetingClips(voice: string, name: string, voiceTint: string, rate: number, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    const key = `${voice}:${lang}`;
    if (greetingClips.has(key)) return;
    const inflight = greetingInFlight.get(key);
    if (inflight) return inflight; // 已在合成/加载中，复用同一个，别并发重复烧 TTS

    const task = (async () => {
      // 未写招呼语的人物回落通用（先定 phrases，才能算出带哈希的缓存文件名）。
      const phrases = (lang === 'en' ? GREETINGS_EN[name] : GREETINGS[name]) ?? ['喂，你好呀', '嗨，是我', '你好呀'];
      greetingPhrases.set(key, phrases); // 与 clips 下标对齐，供文字记录/落库
      const cacheFile = greetingCacheKey(voice, phrases);
      // 先读磁盘缓存：重启后不再烧 TTS。
      const fromDisk = loadGreetingClipsFromDisk(cacheFile);
      if (fromDisk) {
        greetingClips.set(key, fromDisk);
        console.log(`[greeting] ${name}${lang === 'en' ? '(EN)' : ''} 招呼语已从磁盘缓存加载（${fromDisk.length} 句）`);
        return;
      }
      // 磁盘没有 → 现合成并回写磁盘。
      const clips: Uint8Array[] = [];
      for (const phrase of phrases) {
        const parts: Uint8Array[] = [];
        for await (const pcm of streamTTS({
          wsUrl: cfg.dashscopeWsUrl,
          apiKey: cfg.dashscopeApiKey,
          model: cfg.cosyvoiceModel,
          voice,
          instruction: buildInstruction('natural', voiceTint) + tailHint(phrase),
          text: phrase,
          rate,
        })) parts.push(pcm);
        clips.push(concatPcm(parts));
      }
      greetingClips.set(key, clips);
      saveGreetingClipsToDisk(cacheFile, clips); // 回写磁盘（失败不阻断，只告警）
      console.log(`[greeting] ${name}${lang === 'en' ? '(EN)' : ''} 招呼语就绪（${clips.length} 句）`);
    })();

    greetingInFlight.set(key, task);
    try {
      await task;
    } finally {
      greetingInFlight.delete(key);
    }
  }

  // 直接放一条缓存的招呼语（秒回，不等 LLM/TTS）
  function playCachedGreeting(voice: string, lang: 'zh' | 'en' = 'zh') {
    if (!rtc || speaking) return;
    const key = `${voice}:${lang}`;
    const clips = greetingClips.get(key);
    if (!clips || clips.length === 0) return;
    const idx = Math.floor(Math.random() * clips.length);
    const pick = clips[idx];
    const phrase = greetingPhrases.get(key)?.[idx] ?? '';
    console.log('[greeting] 播放缓存招呼语');
    speaking = true;
    agentAudible = true;
    lastTurnAskedQuestion = false;
    rtc.pushAgentPcm(pick); // 24kHz 缓存片段，内部重采样到 48kHz
    rtc.end(); // → onPlaybackEnd 收尾（speaking=false + 静默计时）
    // 招呼语也进文字记录 + 落库（否则聊天记录第一句是空的）。
    if (phrase) {
      rtc?.sendControl({ type: 'transcript', role: 'agent', text: phrase });
      transcript.insert(persona.name, userId, {
        sessionId: currentSessionId,
        role: 'agent',
        text: phrase,
        turnIndex: turnCount,
        emotion: 'natural',
        frame: coachTracker.current,
        asked: isAsking(phrase),
      }).catch((e) => console.warn('[transcript] 招呼语落库失败：', e));
    }
  }

  // 招呼语预热：启动即把所有上线人物的招呼语 TTS 成缓存片段，
  // 让第一通的第一句话一定是缓存好的（秒回、不吃 LLM 空响应的亏）。
  for (const p of Object.values(PERSONAS)) {
    if (!p.available) continue;
    const voice = resolveVoice(p.name, cfg.cosyvoiceVoice);
    preloadGreetingClips(voice, p.name, p.voiceTint, p.rate ?? 1.0).catch((e) =>
      console.warn(`[greeting] ${p.name} 招呼语预热失败：`, e),
    );
  }

  // 说完"不打扰"后 10s 挂断（发 hangup 给前端）
  function scheduleHangup() {
    if (hangupTimer !== null) clearTimeout(hangupTimer);
    console.log('[proactive] 说完"不打扰"，10s 后挂断');
    hangupTimer = setTimeout(() => {
      hangupTimer = null;
      console.log('[proactive] 挂断');
      rtc?.sendControl({ type: 'hangup' });
      setTimeout(() => rtc?.close(), 500); // 给前端一点处理时间
    }, 10000);
  }

  // 电话结束（客户端挂断 / 连接断开 / 服务端挂断）：立刻停掉进行中的生成/TTS，别再往后端输出。
  function teardownCall(reason: 'hangup' | 'close') {
    // 通话结束：把这一通的对话概括成「最近概要」异步落库（best-effort，失败只告警）。
    // 先快照再清空 history，防止 hangup + close 双触发重复写。
    const snap = history;
    history = [];
    if (snap.length > 0) {
      summarizeCall(llm, cfg.generateModel, snap)
        .then((s) => conversationSummaries.save(persona.name, userId, s))
        .catch((e) => console.warn('[summary] 写最近概要失败：', e));
    }
    currentGeneration++;   // 作废正在跑的 respond（myGen 失配 → 停止出句）
    currentAbort?.abort(); // 中止正在进行的 TTS 合成
    rtc?.close();          // 停止出帧 + 清队列 + 标记 closed
    rtc = null;            // 清掉引用，否则 runDreamIfIdle 永远判成「正在通话」→ 做梦永远不跑
    sed?.close();          // 关掉哭/笑检测（NLS）连接，别挂断后还在后台重连
    speaking = false;
    clearReanswer(); // 通话结束：取消任何挂起的重答
    lastUserTurn = null;
    reanswerCount = 0;
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    if (vocalTimer !== null) { clearTimeout(vocalTimer); vocalTimer = null; }
    if (hangupTimer !== null) { clearTimeout(hangupTimer); hangupTimer = null; }
    clearPendingInterrupt(); // 通话结束：取消挂起的抢话判定期
    if (currentSessionId) {
      const id = currentSessionId;
      currentSessionId = null;
      // 挂断收尾 marker trace：谁先挂断（data channel 明确挂断 / 连接断开兜底），再清 session 上下文、补 DB 结束时间。
      void obs.trace('hangup', { metadata: { reason, characterId: persona.name } }, async () => {});
      obs.setSession(null);
      sessions.end(id).catch(() => {});
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // TTS 端点（顺序即优先级）：主端点（中转站）→ 兜底端点（官方百炼，配了官方 key 才启用）。
  function ttsEndpoints(): Array<{ url: string; key: string }> {
    const eps = [{ url: cfg.dashscopeWsUrl, key: cfg.dashscopeApiKey }];
    if (cfg.dashscopeWsFallbackUrl && cfg.dashscopeOfficialApiKey) {
      eps.push({ url: cfg.dashscopeWsFallbackUrl, key: cfg.dashscopeOfficialApiKey });
    }
    return eps;
  }

  // 每个端点最多试 TTS_MAX_ATTEMPTS 次；网络/限流退避重试，业务错误（task-failed 之类）直接抛。
  // 端点耗尽后切兜底端点，兜底也耗尽才抛——瞬时抖动不再整轮丢音频。
  const TTS_MAX_ATTEMPTS = 3;            // 1 次初始 + 2 次重试
  const TTS_NETWORK_BACKOFF_MS = 600;    // 网络抖动退避（短）
  const TTS_RATELIMIT_BACKOFF_MS = 2000; // 限流退避（长，沿用原 2s 起步）

  async function synthesizeWithRetry(params: Omit<RealtimeTTSInput, 'wsUrl' | 'apiKey'>): Promise<void> {
    const endpoints = ttsEndpoints();
    let lastErr: unknown = null;
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      let attempt = 0;
      while (true) {
        try {
          agentAudible = true; // 开始推流音频
          for await (const pcm of streamTTS({ ...params, wsUrl: ep.url, apiKey: ep.key })) {
            if (params.signal?.aborted) break; // 打断后不再往队列里塞
            rtc?.pushAgentPcm(pcm);
          }
          if (params.signal?.aborted) return; // 被打断：静默退出
          return; // 本端点合成成功
        } catch (e) {
          if (params.signal?.aborted) return; // 被打断：静默退出，不重试
          lastErr = e;
          if (!isNetworkError(e) && !isRateLimitError(e)) throw e; // 业务错误，换端点也救不回
          const rateLimit = isRateLimitError(e);
          attempt++;
          if (attempt >= TTS_MAX_ATTEMPTS) break; // 本端点耗尽，切兜底（或最终抛）
          const wait = (rateLimit ? TTS_RATELIMIT_BACKOFF_MS : TTS_NETWORK_BACKOFF_MS) * attempt;
          const reason = (e as { code?: string })?.code ?? (e as Error)?.message ?? String(e);
          console.log(`[TTS] ${rateLimit ? '限流' : '网络失败'}（${reason}），${wait}ms 后重试（端点 ${i + 1}/${endpoints.length} 第 ${attempt} 次）`);
          await sleep(wait);
        }
      }
      if (i < endpoints.length - 1) {
        console.log(`[TTS] 端点 ${ep.url} 多次失败，切兜底端点`);
      }
    }
    throw lastErr;
  }

  async function respond(userText: string, vocals: VocalizationEvent[] = [], dominantVocal: DominantVocal = null) {
    if (!rtc) return;
    const tStart = Date.now(); // 用户说完这一刻（测首字延迟用）
    const myGen = ++currentGeneration; // 这一轮成为最新，旧的立即作废
    currentAbort = new AbortController(); // 本轮专属，打断时 abort
    const signal = currentAbort.signal;
    const searchEnabled = Boolean(cfg.bochaApiKey); // 配了 key 就把 search_web 交给模型自己决定
    speaking = true; // 陪伴者开始说话：静默主动发话先让位
    let reachedEnd = false; // 是否走到了 rtc.end()（真正播完由 onPlaybackEnd 收尾）
    await obs.trace('turn', {
      metadata: { kind: 'respond', characterId: persona.name, turnIndex: turnCount, dominantVocal },
      input: { text: userText, vocals, dominantVocal },
    }, async () => {
    try {
    const acoustics = acoustic?.finalize(userText) ?? neutralAcoustic();
    // 判性别：每轮尝试一次，判出即锁（null = 样本不够或落在中间地带，保持中性）
    if (!userGender) {
      const g = acoustic?.detectGender() ?? null;
      if (g) {
        userGender = g;
        console.log('[gender] 判出对方性别：', g);
        obs.event('gender-detected', { gender: g });
      }
    }
    console.log('[respond] 触发，用户说：', userText, '声学：', JSON.stringify(acoustics), '非言语：', JSON.stringify(vocals));
    if (dominantVocal) obs.event('vocal', { dominantVocal, count: vocals.length });

    // 决策阶段（打分 + 判情绪等）与记忆召回并行，省掉一次串行等待。
    const assembleDeps = {
      store: memory,
      userId,
      characterId: persona.name,
      memoryBudget,
      compress: (entries: HistoryEntry[]) => compressHistory(entries, historyBudget, summarizer),
      timeAware,
      selfAdded,
      goals,
      personaMatch: personaMatcher ?? undefined,
      prefetchCache,
    };
    // L4 过度依赖行为信号（通话会话记录，本地快查询，不进 LLM；失败降级为无信号）。
    const dependenceSignals: DependenceSignals = currentSessionId
      ? await sessions.signals(persona.name, userId, currentSessionId).catch(() => ({ recentCalls7d: 0, currentCallMinutes: 0, lastGapMinutes: null }))
      : { recentCalls7d: 0, currentCallMinutes: 0, lastGapMinutes: null };
    const [plan, ctx, recentAsked] = await Promise.all([
      obs.span('decision', () => planTurn(
        { llm, scoreModel: cfg.scoreModel, generateModel: cfg.generateModel, safetyGuard, tracker, coachTracker, mood },
        { text: userText, acoustic: acoustics, vocalizations: vocals, dominantVocal, persona, context, dependenceSignals },
      )),
      obs.span('recall', () => recallContext(assembleDeps, { text: userText, history, loadedDetails })),
      askedQuestions.recent(persona.name, userId, 3), // 近 3 天问过的问题（防重复问，进 [ASKED]）
    ]);
    if (myGen !== currentGeneration) return; // 决策/召回期间被打断/被新一轮取代，放弃
    mood = plan.mood;
    // 不感兴趣检测：唤醒低 + 回复慢，连续 3 轮 → 本轮换话题
    const disinterest = evaluateDisinterest(plan.affect.arousal, lastReplyLatencyMs, disinterestStreak);
    disinterestStreak = disinterest.streak;
    // 敷衍检测：短/空回复，连续 2 轮 → 换话题（与低唤醒互补）
    const perfunctory = evaluatePerfunctory(userText, perfunctoryStreak);
    perfunctoryStreak = perfunctory.streak;
    // 追问太密：连续 N 轮都以问句结尾 → 换话题（治"逮着一个点连问"）
    // 教练态不换话题：GROW 就是靠连续提问推进的，追问太密/敷衍/低唤醒都不该把教练拽去闲聊。
    const topicDrift = consecutiveQuestions >= TOPIC_DRIFT_LIMIT;
    const switchTopic = plan.frame !== 'coach' && (disinterest.switchTopic || perfunctory.switchTopic || topicDrift);
    if (switchTopic) {
      disinterestStreak = 0;
      perfunctoryStreak = 0;
      consecutiveQuestions = 0;
    }
    loadedDetails = ctx.loadedDetails; // 本轮命中的人物详情驻留到会话缓存
    // 好奇心缺口线索：缓存给 nudge 找话题复用 + 打日志（仅变化时，避免每轮刷屏）。
    // 教练态不算好奇心（GROW 是唯一主线）：别算、别打，否则日志看着像「好奇心还在触发」。
    const curiosityHint = plan.frame === 'coach' ? lastCuriosityHint : (buildCuriosityHint(ctx.coverage) ?? '');
    if (curiosityHint !== lastCuriosityHint) {
      lastCuriosityHint = curiosityHint;
      console.log('[CURIOSITY] 缺口线索：', curiosityHint || '（无缺口）');
    }
    console.log('[L3] 决策完成，情绪：', plan.emotion);
    console.log('[latency] 打分+召回耗时', Date.now() - tStart, 'ms');
    obs.score('decision-ms', Date.now() - tStart);

    // L4 强制转介：refer 时走 data channel 给前端安全 overlay（纯语音也看得见号码）。
    if (plan.safetyAction.action === 'refer') {
      rtc?.sendControl({ type: 'safety', level: plan.safetyAction.level, resources: CRISIS_RESOURCES });
      console.log('[safety] 命中危机，转介 level=', plan.safetyAction.level);
      obs.event('safety-refer', { level: plan.safetyAction.level });
    }

    // 主动追问：新通话首轮、且对方还在「朋友」态时，若有未完成下一步的课题，温柔带一句"后来呢"（每通一次）。
    let goalFollowUp = '';
    if (!goalFollowUpDone && plan.frame === 'friend') {
      goalFollowUp = buildGoalFollowUpHint(ctx.goals);
      if (goalFollowUp) goalFollowUpDone = true;
    }

    // 装配完整 messages 供流式生成。
    const messages = buildTurnMessages(ctx, assembleDeps, {
      text: userText,
      history,
      loadedDetails: ctx.loadedDetails,
      mode: plan.mode,
      stance: plan.stance,
      frame: plan.frame,
      coachInvite: plan.coachInvite,
      celebrate: plan.celebrate,
      goalFollowUp,
      emotion: plan.emotion,
      mood,
      turnCount: ++turnCount,
      affect: plan.affect,
      userGender,
      switchTopic,
      personaSystemPrompt: buildLanguagePrompt(persona.systemPrompt, lang, englishMode),
      vocalizations: vocals,
      safetyAction: plan.safetyAction,
      dependence: plan.dependence,
      farewell: plan.farewell,
      lastAskedQuestion: lastQuestionText,
      userSaid: [...userSaid],
      recentAsked,
      recentSummary: recentSummaryText,
      curiosityHint,
      searchEnabled,
    });

    // 单句 TTS：首句用本轮基调（零延迟），后续句生成后分类（B2）。
    // 每句先剥结尾的 awaits 标签（顺带记录是否等回应），标签绝不喂 TTS / 写历史。
    let awaitsResponse: boolean | null = null;
    let firstTokenMs = 0;
    const speakOne = async (seg: string, i: number): Promise<string> => {
      const { clean, awaits } = extractAwaits(seg);
      if (awaits !== null) awaitsResponse = awaits;
      if (!clean) return ''; // 整段只是标签（或空），跳过
      const segEmotion = i === 0
        ? plan.emotion
        : await classifySegmentEmotion(llm, cfg.generateModel, clean, plan.emotion);
      const segProsody = EMOTION_PROSODY[segEmotion];
      const segRate = Math.round((persona.rate ?? 1.0) * (segProsody.rate ?? 1.0) * 100) / 100;
      if (i === 0) {
        firstTokenMs = Date.now() - tStart;
        console.log('[latency] 首句开始合成', firstTokenMs, 'ms（从用户说完）');
        obs.score('first-token-ms', firstTokenMs);
      }
      console.log('[TTS] 合成这句：', clean, '情绪：', segEmotion);
      await obs.span('tts', () => synthesizeWithRetry({
        model: cfg.cosyvoiceModel,
        voice: resolveVoice(persona.name, cfg.cosyvoiceVoice, lang),
        instruction: buildInstruction(segEmotion, persona.voiceTint) + tailHint(clean),
        text: clean,
        rate: segRate,
        pitch: segProsody.pitch,
        signal,
      }), { text: clean, emotion: segEmotion });
      return clean;
    };

    // 逐句 TTS：返回拼接的完整文本。
    const speakSegments = async (segments: AsyncIterable<string> | string[]): Promise<string> => {
      let full = '';
      let i = 0;
      for await (const seg of segments) {
        if (myGen !== currentGeneration) break;
        full += await speakOne(seg, i);
        i++;
      }
      return full;
    };

    // 生成阶段：联网搜索交给模型自己 Function Calling（不再用正则启发式）。
    let fullText = '';
    if (!searchEnabled) {
      // 未配搜索 key：普通流式生成。
      fullText = await speakSegments(streamMessages(llm, cfg.generateModel, messages));
    } else {
      // 一次流式生成：模型要么直接逐句吐文本（零延迟 TTS），要么给出 search_web 工具调用（此时无文本）。
      let searchCall: ToolCall | null = null;
      let spoken = '';
      let i = 0;
      for await (const ev of streamMessagesWithTools(llm, cfg.generateModel, messages, [SEARCH_TOOL])) {
        if (myGen !== currentGeneration) return;
        if (ev.kind === 'sentence') {
          spoken += await speakOne(ev.text, i);
          i++;
        } else if (ev.kind === 'tool_calls') {
          searchCall = ev.calls.find((c) => c.name === 'search_web') ?? null;
        }
      }
      if (myGen !== currentGeneration) return;
      if (!searchCall || spoken.trim()) {
        // 模型没要搜（或已经开始答）：直接用已说的文本。
        console.log('[search] 本轮未发起搜索（模型直接作答）');
        fullText = spoken;
      } else {
        // 模型要搜：先播 filler 盖住搜索延迟，搜完回填工具结果续写。
        let query = '';
        try { query = (JSON.parse(searchCall.arguments)?.query as string) ?? ''; } catch { query = ''; }
        console.log('[search] 模型发起联网搜索：', query || '（空 query）');
        for await (const pcm of streamTTS({
          wsUrl: cfg.dashscopeWsUrl,
          apiKey: cfg.dashscopeApiKey,
          model: cfg.cosyvoiceModel,
          voice: resolveVoice(persona.name, cfg.cosyvoiceVoice, lang),
          instruction: buildInstruction('natural', persona.voiceTint),
          text: pickFiller(),
          rate: persona.rate ?? 1.0,
          signal,
        })) {
          if (myGen !== currentGeneration) break;
          rtc?.pushAgentPcm(pcm);
        }
        const t0 = Date.now();
        const results = query ? await bochaSearch(query, { apiKey: cfg.bochaApiKey, baseUrl: cfg.bochaBaseUrl }) : [];
        await sleep(Math.max(0, MIN_SEARCH_MS - (Date.now() - t0))); // 即使秒回也留自然延迟
        console.log('[search] 搜索返回', results.length, '条');
        // 回填工具结果，续写最终答复（流式，逐句 TTS）。
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: searchCall.id, type: 'function', function: { name: searchCall.name, arguments: searchCall.arguments } }],
        };
        const summary = results.map((r) => `${r.title}\n${r.snippet}`).join('\n\n') || '（没查到）';
        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: searchCall.id,
          content: `搜索结果（用「哦，我查到了／原来是…」这类自然语气说出来，别生硬复述）：\n${summary}`,
        };
        fullText = await speakSegments(streamMessages(llm, cfg.generateModel, [...messages, assistantMsg, toolMsg]));
      }
    }
    if (myGen === currentGeneration) {
      lastUserTurn = null; // 这条债已答完，清掉待答义务
      reanswerCount = 0;
      // 整轮完成才记历史（被打断则整轮丢弃）：先记她，再记我。
      history.push({ kind: 'turn', role: 'user', text: userText });
      if (fullText.trim()) history.push({ kind: 'turn', role: 'agent', text: fullText.trim() });
      reachedEnd = true;
      rtc?.end(); // 整轮结束，冲掉末尾残余
      const replyText = fullText.trim();
      if (replyText) rtc?.sendControl({ type: 'transcript', role: 'agent', text: replyText }); // 回看：把陪伴者说的话推给前端文字记录
      obs.setOutput(replyText);
      const asked = awaitsResponse !== null ? awaitsResponse : isAsking(replyText);
      // 逐轮落库（导出/优化用）：user + agent 各一条，best-effort 不阻断。
      transcript.insert(persona.name, userId, {
        sessionId: currentSessionId,
        role: 'user',
        text: userText,
        turnIndex: turnCount,
        affect: plan.affect,
        acoustic: acoustics,
        vocals: vocals.length ? vocals : undefined,
        latencyMs: lastReplyLatencyMs || null,
      }).catch((e) => console.warn('[transcript] 用户话落库失败：', e));
      if (replyText) {
        transcript.insert(persona.name, userId, {
          sessionId: currentSessionId,
          role: 'agent',
          text: replyText,
          turnIndex: turnCount,
          emotion: plan.emotion,
          recalled: {
            constraint: ctx.recalled.constraint.map((m) => ({ id: m.id, content: m.content })),
            persona: ctx.recalled.persona.map((m) => ({ id: m.id, content: m.content })),
            fact: ctx.recalled.fact.map((m) => ({ id: m.id, content: m.content })),
            preference: ctx.recalled.preference.map((m) => ({ id: m.id, content: m.content })),
            episodic: ctx.recalled.episodic.map((m) => ({ id: m.id, content: m.content })),
          },
          latencyMs: firstTokenMs || null,
          frame: plan.frame,
          mode: plan.mode,
          stance: plan.stance,
          asked,
        }).catch((e) => console.warn('[transcript] 陪伴者话落库失败：', e));
      }
      lastTurnAskedQuestion = asked; // 问句结尾 → 之后走 5s 追问
      if (asked) lastQuestionText = replyText; else lastQuestionText = '';
      if (asked && replyText) askedQuestions.record(persona.name, userId, replyText).catch(() => {}); // 记一条问过的（防重复问）
      if (asked) consecutiveQuestions++; else consecutiveQuestions = 0; // 追问太密计数
      // 道别收尾：这一轮对方已道别（模型判定）→ 别再 nudge/followup，等 10s 挂断（用户继续搭话会取消）
      if (plan.farewell) {
        lastTurnAskedQuestion = false; // 道别优先，压掉可能的 5s 追问
        lastWasFarewell = true;
        idleFired = true;
      }

      // 后台记忆 Agent（异步、不进热路径）：写记忆 + look-ahead 预取，都是 best-effort，失败只告警不阻断。
      consolidateTurn({
        llm,
        model: cfg.generateModel,
        store: memory,
        classify: (raw) => classifyMemory(llm, cfg.generateModel, raw),
        userId,
        characterId: persona.name,
        userText,
        agentText: fullText.trim(),
        retractIds: prevTurnMemoryIds,
      })
        .then((res) => {
          prevTurnMemoryIds = res.writtenIds;
          for (const f of res.facts) userSaid.push(f); // 抽取压缩后累积进会话小笔记本（不滑窗，整通累积）
        })
        .catch((e) => console.warn('[memory] 后台写记忆失败：', e));
      prefetchNextTurn(
        { store: memory, userId, characterId: persona.name, query: userText },
        prefetchCache,
      ).catch((e) => console.warn('[memory] 后台预取失败：', e));
      // 后台课题巩固（异步、不进热路径）：教练轮才跑，把 GROW 进展落进 growth_goals。
      if (plan.frame === 'coach') {
        consolidateGoal({
          llm,
          model: cfg.generateModel,
          store: goals,
          userId,
          characterId: persona.name,
          userText,
          agentText: fullText.trim(),
        }).catch((e) => console.warn('[goal] 后台课题巩固失败：', e));
      }
      // 后台人设增补（异步、不进热路径）：固化陪伴者新说出的软细节 + 提及检测刷新活跃度 + 归档过期。
      consolidateSelfAdded({
        llm,
        model: cfg.generateModel,
        store: selfAdded,
        userId,
        characterId: persona.name,
        agentText: fullText.trim(),
        personaSystemPrompt: persona.systemPrompt,
        embedder,
      }).catch((e) => console.warn('[self-add] 后台写增补失败：', e));
      touchSelfAdded({
        embedder,
        store: selfAdded,
        userId,
        characterId: persona.name,
        text: `${userText}\n${fullText.trim()}`,
      }).catch((e) => console.warn('[self-add] 后台提及检测失败：', e));
      selfAdded.archiveStale(persona.name, userId, SELF_ADDED_TTL_DAYS).catch((e) =>
        console.warn('[self-add] 归档过期失败：', e),
      );
    }
    } finally {
      // 正常走到 rtc.end() 时由 onPlaybackEnd 收尾；这里只兜底"没走到播放"（空文本/异常）
      if (myGen === currentGeneration && !reachedEnd) {
        speaking = false;
        agentAudible = false; // 兜底复位：没走到播放就结束（空文本/异常），别让 agentAudible 卡死吞掉后续 ASR
        lastUserVoiceAt = Date.now();
        armIdleCheck();
      }
    }
    });
  }

  // 静默主动发话：接通 5s 没说话打招呼；之后用户每沉默 2s 轻问一句（非问句结尾）。
  // markUserVoice 在用户出声时刷新计时基准；armIdleCheck 排一次定时器，到点自检、必要时重排。
  function markUserVoice() {
    const now = Date.now();
    if (agentDoneAt > 0) {
      // 只记一次：陪伴者说完 → 用户开口的间隔（interim 多次触发只记第一次）
      lastReplyLatencyMs = now - agentDoneAt;
      agentDoneAt = 0;
    }
    lastUserVoiceAt = now;
    idleFired = false;            // 新一轮静默：允许再次主动发话一次
    lastTurnAskedQuestion = false; // 用户回应了，退出"等回答"状态
    noReplyStreak = 0;            // 重置连续未答计数
    coachCheckinDone = false;     // 用户又开口了：教练态确认阶段归零
    lastWasFarewell = false;      // 用户又开口了，取消挂断
    if (hangupTimer !== null) {
      clearTimeout(hangupTimer);
      hangupTimer = null;
    }
  }

  // 误打断重答：咳嗽/底噪把正在播的回复掐断后，若接下来没有新用户话，就重答那条待答债。
  function clearReanswer() {
    if (reanswerTimer !== null) { clearTimeout(reanswerTimer); reanswerTimer = null; }
  }
  function armReanswer() {
    clearReanswer();
    const turn = lastUserTurn;
    if (!turn || reanswerCount >= REANSWER_LIMIT) return;
    reanswerTimer = setTimeout(() => {
      reanswerTimer = null;
      // 期间来了新用户话（lastUserTurn 已被替换）或已在说话/已挂断 → 不重答
      if (lastUserTurn === turn && !speaking && rtc) {
        reanswerCount++;
        console.log('[respond] 误打断后重答（第', reanswerCount, '次）：', turn.text);
        void obs.trace('reanswer', { metadata: { attempt: reanswerCount, characterId: persona.name } }, async () => {});
        respond(turn.text, turn.vocals, turn.dominantVocal).catch(console.error);
      }
    }, REANSWER_MS);
  }

  function armIdleCheck() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!rtc || speaking) return;
    // 教练态：沉默多半是在「想/消化」，别用朋友态那套 followup(自问自答)/nudge(找话题)/farewell(失落收尾) 去催、去换话题。
    // 两阶段：① 沉默 30s → 轻轻确认「还在吗」；② 确认后仍无回应再等 30s → 温柔收尾（留门 + 挂断），不无限等。
    if (coachTracker.current === 'coach') {
      const target = coachCheckinDone ? COACH_CLOSE_MS : COACH_SILENT_MS;
      const wait = Math.max(0, target - (Date.now() - lastUserVoiceAt));
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!rtc || speaking) return;
        if (Date.now() - lastUserVoiceAt >= target) {
          if (!coachCheckinDone) {
            coachCheckinDone = true;
            console.log('[proactive] 教练态沉默较久，轻轻确认一次');
            speakProactive('checkin').catch(console.error);
          } else {
            console.log('[proactive] 教练态确认后仍无回应，温柔收尾');
            speakProactive('coachClose').catch(console.error);
          }
        } else {
          armIdleCheck();
        }
      }, wait);
      return;
    }
    // 追问流：上一轮以问句结尾、且还没到"连续 2 次没答" → 5s 等回答
    if (lastTurnAskedQuestion && noReplyStreak < NO_REPLY_LIMIT) {
      const wait = Math.max(0, FOLLOWUP_MS - (Date.now() - lastUserVoiceAt));
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!rtc || speaking) return;
        if (Date.now() - lastUserVoiceAt >= FOLLOWUP_MS) {
          noReplyStreak++;
          if (noReplyStreak >= NO_REPLY_LIMIT) {
            idleFired = true; // 收尾后别再主动，等对方再开口
            console.log('[proactive] 触发 farewell（多次没回应）');
            speakProactive('farewell').catch(console.error);
          } else if (noReplyStreak === 2) {
            console.log('[proactive] 触发 checkin（先问还在吗）');
            speakProactive('checkin').catch(console.error);
          } else {
            console.log('[proactive] 触发 followup（追问自答）');
            speakProactive('followup').catch(console.error);
          }
        } else {
          armIdleCheck();
        }
      }, wait);
      return;
    }
    // 轻问流：非问句结尾 → 2s 静默轻问，每段只一次
    if (idleFired) return;
    const wait = Math.max(0, NUDGE_MS - (Date.now() - lastUserVoiceAt));
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!rtc || speaking || idleFired) return;
      if (Date.now() - lastUserVoiceAt >= NUDGE_MS) {
        idleFired = true; // 本轮静默只发一次，别变成话痨
        console.log('[proactive] 触发 nudge（2s 静默）');
        speakProactive('nudge').catch(console.error);
      } else {
        armIdleCheck();
      }
    }, wait);
  }

  // 取消 VAD 抢话的判定期（判出语气词附和时用）。
  function clearPendingInterrupt() {
    pendingInterrupt = false;
    if (interruptGraceTimer !== null) {
      clearTimeout(interruptGraceTimer);
      interruptGraceTimer = null;
    }
  }

  // 真打断：清声 + 复位 + 重答兜底。
  function doBargeIn(source: 'rtc' | 'asr') {
    console.log(`[RTC] 打断（interrupt，via ${source}）`);
    void obs.trace('interrupt', { metadata: { characterId: persona.name, source } }, async () => {});
    lastBargeInAt = Date.now();
    currentGeneration++;      // 作废当前 respond
    currentAbort?.abort();    // 中止正在进行的 TTS 合成
    rtc?.clear();             // 清空播放队列，立刻停声
    backchannel.reset();      // 打断时复位附和状态
    speaking = false;         // 已停声
    agentAudible = false;     // 音频已停
    agentDoneAt = 0;          // 抢话打断：不按「说完→开口」计时
    markUserVoice();          // 你抢话了：重置追问/静默计数（别紧接着就自问自答/收尾）
    armReanswer();            // 掐掉的是正在播的回复：若只是误触发没新话，稍后重答，保证"说了话必回"
    armIdleCheck();
  }

  // 打断（barge-in）：对方抢话时停声。两个来源——
  // ① 前端 data channel 的 interrupt（快、只表示「有人说话」、不知内容）
  // ② ASR 在 agentAudible 期间判到字（稳，真抢话）。
  // VAD 抢话先不立刻停声，进入短判定期：若 ASR 判出只是「嗯/哦」这类语气词附和，就取消、让对方继续说；
  // 判出真字、或判定期到期没等到 ASR，才真打断。
  function handleBargeIn(source: 'rtc' | 'asr') {
    if (!agentAudible) return; // 陪伴者没在出声，这不是抢话，忽略（正常接话走 ASR 主流程）
    if (source === 'rtc') {
      if (pendingInterrupt) return; // 已在判定期，等 ASR 出结论
      pendingInterrupt = true;
      if (interruptGraceTimer !== null) clearTimeout(interruptGraceTimer);
      interruptGraceTimer = setTimeout(() => {
        interruptGraceTimer = null;
        pendingInterrupt = false;
        doBargeIn('rtc'); // 判定期到期没等到 ASR 判定 → 真打断
      }, INTERRUPT_GRACE_MS);
      return;
    }
    // ASR 判到真字：立即真打断
    clearPendingInterrupt();
    doBargeIn('asr');
  }

  // 主动发话（开场白 / 静默关怀）：没有用户输入，单独走生成 + TTS，不进打分/记忆热路径。
  async function speakProactive(kind: 'greeting' | 'nudge' | 'followup' | 'checkin' | 'farewell' | 'coachClose') {
    if (!rtc || speaking) return;
    const myGen = ++currentGeneration;
    currentAbort = new AbortController();
    const signal = currentAbort.signal;
    speaking = true;
    let reachedEnd = false; // 是否走到了 rtc.end()
    console.log('[proactive] 开始：', kind);
    await obs.trace('proactive', {
      metadata: { kind, characterId: persona.name },
      input: { kind },
    }, async () => {
    try {
      const system = buildProactiveSystemPrompt(kind, buildLanguagePrompt(persona.systemPrompt, lang, englishMode), lastQuestionText, kind === 'nudge' && coachTracker.current === 'friend' ? lastCuriosityHint || undefined : undefined);
      const text = await generateProactiveText(llm, cfg.generateModel, system);
      if (myGen !== currentGeneration) return;
      const { clean: seg, awaits } = extractAwaits(text.trim());
      if (!seg) return;
      console.log('[proactive] 文本：', seg);
      obs.setOutput(seg);
      await obs.span('tts', () => synthesizeWithRetry({
        model: cfg.cosyvoiceModel,
        voice: resolveVoice(persona.name, cfg.cosyvoiceVoice, lang),
        instruction: buildInstruction('natural', persona.voiceTint) + tailHint(seg),
        text: seg,
        rate: persona.rate ?? 1.0,
        signal,
      }), { text: seg });
      if (myGen === currentGeneration) {
        history.push({ kind: 'turn', role: 'agent', text: seg }); // 主动话也进历史，保持上下文连贯
        rtc?.sendControl({ type: 'transcript', role: 'agent', text: seg }); // 主动发话也进文字记录
        reachedEnd = true;
        rtc?.end();
        const asked = awaits !== null ? awaits : isAsking(seg);
        lastTurnAskedQuestion = asked; // 问句结尾 → 之后走 5s 追问
        if (asked) lastQuestionText = seg; else lastQuestionText = '';
        if (kind === 'farewell' || kind === 'coachClose') lastWasFarewell = true; // 说完收尾后 10s 挂断（教练态温柔留门收尾也走同一挂断）
        // 主动话也落库（导出用）：best-effort，不阻断。
        transcript.insert(persona.name, userId, {
          sessionId: currentSessionId,
          role: 'agent',
          text: seg,
          turnIndex: turnCount,
          emotion: 'natural',
          frame: coachTracker.current,
          asked,
        }).catch((e) => console.warn('[transcript] 主动话落库失败：', e));
      }
    } catch (e) {
      console.warn('[proactive] 主动发话失败：', e);
    } finally {
      if (myGen === currentGeneration && !reachedEnd) {
        speaking = false;
        agentAudible = false; // 兜底复位：主动发话没走到播放就结束，别让 agentAudible 卡死
        lastUserVoiceAt = Date.now();
        armIdleCheck();
      }
    }
    });
  }

  // 纯哭/纯笑无字：把「一段连续发声」合并成一次回应，两次回应之间留冷却，避免一句话说两遍。
  // - 去抖 3s：NLS 事件约 2s 一个，3s 无新事件 = 这段发声结束，触发。
  // - 最大等待 6s：持续哭/笑不停歇时也强制给一次回应（否则去抖被事件持续重置、永远不触发）。
  // - 冷却 8s：两次回应最小间隔（让上一句说完，别叠成复读机）。
  const VOCAL_DEBOUNCE_MS = 3000;
  const VOCAL_MAX_HOLD_MS = 6000;
  const VOCAL_COOLDOWN_MS = 8000;

  function scheduleVocalRespond() {
    if (vocalTimer !== null) clearTimeout(vocalTimer);
    const now = Date.now();
    const sinceLast = now - lastVocalRespondAt;
    let wait: number;
    if (sinceLast < VOCAL_COOLDOWN_MS) {
      wait = VOCAL_COOLDOWN_MS - sinceLast; // 冷却中：等到冷却结束
    } else {
      wait = VOCAL_DEBOUNCE_MS; // 冷却已过：去抖合并
      if (pendingVocals.hasAny) {
        wait = Math.min(wait, Math.max(0, VOCAL_MAX_HOLD_MS - (now - pendingVocals.firstAtMs)));
      }
    }
    vocalTimer = setTimeout(() => {
      vocalTimer = null;
      triggerVocalRespond();
    }, wait);
  }

  function triggerVocalRespond() {
    if (!pendingVocals.hasAny) return;
    lastVocalRespondAt = Date.now();
    const vocals = pendingVocals.list;
    const dominantVocal = pendingVocals.dominant();
    pendingVocals.reset();
    respond('', vocals, dominantVocal).catch(console.error);
  }

  function clearVocalTimer() {
    if (vocalTimer !== null) {
      clearTimeout(vocalTimer);
      vocalTimer = null;
    }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 健康检查：前端轮询它判断后端是否还活着（挂了就中断通话 + 报错）
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // 通讯录：持久化已添加的伙伴（Postgres，见 store/contacts.ts + db.ts）
    if (req.method === 'GET' && req.url === '/contacts') {
      try {
        sendJson(res, 200, { names: await contacts.list() });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/contacts') {
      try {
        const { name } = await readJson<{ name: string }>(req);
        if (!name || typeof name !== 'string') {
          sendJson(res, 400, { error: 'name 必填' });
          return;
        }
        sendJson(res, 200, { names: await contacts.add(name) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/contacts/')) {
      try {
        const name = decodeURIComponent(req.url.slice('/contacts/'.length));
        sendJson(res, 200, { names: await contacts.remove(name) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    // 笔记本 / 记忆库：跨型列出某伙伴的未归档记忆（?character=姓名&since=ISO&kind=类型）。
    if (req.method === 'GET' && req.url?.startsWith('/memories')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const character = u.searchParams.get('character') ?? persona.name;
        const since = u.searchParams.get('since') ?? undefined;
        const kindParam = u.searchParams.get('kind');
        const kind = kindParam ? (kindParam as MemoryKind) : undefined;
        sendJson(res, 200, { memories: await memory.listAll(character, userId, { kind, since }) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }
    // 笔记本编辑：PATCH /memories/:id?character=姓名，body { content?, kind? }。
    if (req.method === 'PATCH' && req.url?.startsWith('/memories/')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const id = u.pathname.slice('/memories/'.length);
        const character = u.searchParams.get('character') ?? persona.name;
        const body = await readJson<{ content?: string; kind?: MemoryKind }>(req);
        const m = await memory.update(character, userId, id, body);
        if (!m) {
          sendJson(res, 404, { error: '记忆不存在' });
          return;
        }
        sendJson(res, 200, { memory: m });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }
    // 笔记本删除：DELETE /memories/:id?character=姓名（软删除 superseded）。
    if (req.method === 'DELETE' && req.url?.startsWith('/memories/')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const id = u.pathname.slice('/memories/'.length);
        const character = u.searchParams.get('character') ?? persona.name;
        sendJson(res, 200, { removed: await memory.remove(character, userId, id) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    // 聊天记录导出：结构化 JSON（对话正文 + 元数据），供后续分析/优化。
    if (req.method === 'GET' && req.url?.startsWith('/export/chat')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const character = u.searchParams.get('character') ?? persona.name;
        const since = u.searchParams.get('since') ?? undefined;
        const limitParam = u.searchParams.get('limit');
        const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 2000) : undefined;
        const turns = await transcript.list(character, userId, { since, limit });
        sendJson(res, 200, { character, exportedAt: new Date().toISOString(), count: turns.length, turns });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/rtc/offer') {
      try {
        const body = await readJson<{ sdp: string; name?: string; lang?: 'zh' | 'en'; englishMode?: 'immersion' | 'coach' }>(req);
        lang = body.lang === 'en' ? 'en' : 'zh';
        englishMode = body.englishMode === 'coach' ? 'coach' : 'immersion';
        const resolved = resolvePersona(body.name ?? '程书衡');
        if (!resolved) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `未上线或不存在的人物：${body.name}` }));
          return;
        }
        persona = resolved;
        // 人物详情渐进式加载（认知/经历/偏好）：运行期语义匹配；常驻底座已在构建期烤进 systemPrompt。
        const details = resolvePersonaDetails(persona.name);
        personaMatcher = details.length ? createPersonaMatcher(embedder, details) : null;
        if (details.length) console.log(`[persona] ${persona.name} 启用渐进式记忆：共 ${details.length} 条详情待命中加载`);
        // 未配专属音色时提示：这位暂时会回落到程书衡的音色（共用一张嘴，明显违和）
        if (resolveVoice(persona.name, cfg.cosyvoiceVoice, lang) === cfg.cosyvoiceVoice && persona.name !== '程书衡') {
          console.warn(`[voice] ${persona.name} 尚未配置专属音色，暂用程书衡音色；用 npm run enroll-voices 建模后填 env。`);
        }
        // 副语言 backchannel：复位 + 切音色 + 预生成片段（懒、按音色缓存）。
        backchannel.reset();
        const backVoice = resolveVoice(persona.name, cfg.cosyvoiceVoice, lang);
        backchannel.setVoice(backVoice);
        if (!backchannel.hasClips(backVoice)) {
          preloadBackchannelClips(backVoice, persona.name).catch((e) =>
            console.warn('[backchannel] 片段预生成失败：', e),
          );
        }
        sed?.close(); // 关掉上一通的检测连接（新通话重连）
        asr = new ParaformerRealtimeASR();
        acoustic = new AcousticFeatureExtractor();
        pendingVocals = new VocalEventAggregator();
        history = []; // 新通话：重置会话历史与轮次（长期记忆在 Postgres，不受影响）
        tracker = new ModeTracker(); // mode 归零：每通全新开始，不继承上一通
        coachTracker = new CoachTracker(); // frame 归零：每通从「朋友」开始，教练态不跨通话
        goalFollowUpDone = false; // 主动追问每通重置：新通话还能再问一次"后来呢"
        coachCheckinDone = false; // 教练态确认每通重置
        safetyGuard = new SafetyGuard({ llm: safetyLlm, model: cfg.safetyModel }); // 安全 episode 每通重置
        mood = null; // mood 归零：情绪轨迹每通重来，跨通话连续性交给长期记忆
        turnCount = 0;
        loadedDetails = []; // 人物详情缓存随通话重置
        prefetchCache.clear(); // 预取缓存随通话重置，避免上一通的陈旧预热污染新会话
        lastUserVoiceAt = Date.now(); // 静默主动发话的计时基准从接通这一刻起
        idleFired = false;
        clearPendingInterrupt(); // 新通话：清掉上一通残留的抢话判定期
        lastTurnAskedQuestion = false;
        lastQuestionText = ''; // 上一通遗留的问句要清掉，别在新通话里注入陈旧的 [ANSWERED]
        userSaid.length = 0;
        prevTurnMemoryIds = [];
        lastCuriosityHint = '';
        // 最近 3 天对话概要：新通话加载一次（超预算在后台压成短回顾，别卡建连）。
        recentSummaryText = '';
        conversationSummaries.recent(persona.name, userId, 3)
          .then(async (summaries) => {
            if (summaries.length === 0) return;
            recentSummaryText = await compressSummaries(llm, cfg.generateModel, summaries).catch(() => summaries.join('\n'));
          })
          .catch(() => {});
        noReplyStreak = 0;
        disinterestStreak = 0;
        perfunctoryStreak = 0;
        consecutiveQuestions = 0;
        agentDoneAt = 0;
        lastReplyLatencyMs = 0;
        speaking = false;
        userGender = null; // 每通重新判性别

        // 记忆巩固（做梦）已改为「空闲时自动」跑，见文件尾部 runDreamIfIdle——不再在接通时同步反思。

        // 哭/笑检测（NLS 云端）：收 PCM、出事件。连不上/未配凭证时 onEvent 不被调用，主链路照常。
        const hasToken = Boolean(cfg.nlsToken);
        const hasAk = Boolean(cfg.nlsAkId && cfg.nlsAkSecret);
        if (cfg.nlsEnabled && cfg.nlsAppKey && (hasToken || hasAk)) {
          sed = new NlsSoundEventDetector(
            {
              appKey: cfg.nlsAppKey,
              token: cfg.nlsToken || undefined,
              akId: cfg.nlsAkId || undefined,
              akSecret: cfg.nlsAkSecret || undefined,
            },
            (ev) => {
              pendingVocals.add(ev);
              console.log('[NLS] 非言语发声：', JSON.stringify(ev), '主导：', pendingVocals.dominant());
              scheduleVocalRespond(); // 纯哭/纯笑无字 → 去抖触发回应
            },
          );
        } else if (!cfg.nlsEnabled) {
          sed = null;
          console.warn('[NLS] 已通过 NLS_ENABLED=false 关闭哭/笑检测');
        } else {
          sed = null;
          console.warn('[NLS] 未配 NLS 凭证（NLS_APPKEY + NLS_TOKEN 或 NLS_ACCESS_KEY_ID/SECRET），哭/笑检测关闭');
        }

        // 通话会话记录：结束上一通（若有残留），开新一条；失败不阻断建连。
        if (currentSessionId) sessions.end(currentSessionId).catch(() => {});
        currentSessionId = await sessions.start(persona.name, userId).catch(() => null);
        obs.setSession(currentSessionId ? { sessionId: currentSessionId, userId, characterId: persona.name } : null);

        rtc = createRtcPeer(
          {
            onUserPcm: (chunk) => {
              // ASR 和 NLS 始终收——否则陪伴者说话时你抢话，麦克风被门挡住听不见。
              // 回声靠前端 AEC 消；markUserVoice 已改成 ASR 判到字才触发（不误判回声）。
              asr?.sendAudio(chunk); // ASR（抢话/打断要能被听到）
              sed?.sendPcm(chunk); // 哭/笑检测
              if (speaking) return; // 陪伴者说话时，回声不进声学/附和
              if (hasVoicePcm(chunk)) recentVoiceAt = Date.now(); // 真声能：幻听 ASR 门控基准
              acoustic?.push(chunk); // 副语言特征
              backchannel.feedPcm(chunk); // 副语言附和（静音间隙检测）
            },
            onInterrupt: () => handleBargeIn('rtc'),
            onPlaybackEnd: () => {
              speaking = false;            // 这一轮真正说完（队列播完）
              agentAudible = false;        // 音频出完了
              lastUserVoiceAt = Date.now(); // 静默从"说完"这一刻起算（不是从生成完算）
              agentDoneAt = Date.now();     // 「说完」基准：下一轮回复延迟从这里起算
              if (lastWasFarewell) {
                lastWasFarewell = false;
                scheduleHangup(); // 说完"不打扰"后 10s 挂断
              }
              armIdleCheck();
            },
            onHangup: () => {
              // 客户端经 data channel 明确说挂断：立刻停（不等 WebRTC 断连的 ICE 失败延迟）。
              console.log('[RTC] 收到挂断，立刻停');
              teardownCall('hangup');
            },
            onClose: () => {
              // 连接真正断开（兜底：客户端直接 close / 网络失败 / 服务端挂断）。
              teardownCall('close');
            },
          },
          { portRange: cfg.icePortRange, hostAddress: cfg.iceHostAddress },
        );
        await sed?.start(); // 连不上也立即返回，降级
        await asr.start({
          wsUrl: cfg.dashscopeWsUrl,
          apiKey: cfg.dashscopeApiKey,
          model: cfg.paraformerModel,
          languageHints: lang === 'en' ? ['en'] : ['zh'],
          onResult: (text, isFinal) => {
            console.log('[ASR] 结果：', JSON.stringify({ text, isFinal }));
            const t = text.trim();
            // 语气词附和（「嗯/哦/啊/好/对/是/唔」）：抢话语境下别打断、别当成一轮新话——让对方继续说。
            if (t && isFillerText(t) && (agentAudible || pendingInterrupt || Date.now() - lastBargeInAt < 1500)) {
              if (isFinal) {
                clearPendingInterrupt(); // 确认只是附和，取消 VAD 的待定打断（AI 继续讲）
                pendingVocals.reset();   // 这一小段不算哭/笑事件
              } else if (pendingInterrupt) {
                // interim 是附和：延长判定期，等 final 确认（也可能是「嗯，那个…」真实话）。
                if (interruptGraceTimer !== null) clearTimeout(interruptGraceTimer);
                interruptGraceTimer = setTimeout(() => {
                  interruptGraceTimer = null;
                  pendingInterrupt = false;
                  doBargeIn('rtc');
                }, INTERRUPT_GRACE_MS);
              }
              return;
            }
            if (agentAudible) {
              // 陪伴者在出音频时 ASR 判到字：回声已被前端 AEC 消，判到字基本是真抢话（比 VAD 稳）。
              // 触发打断后让这段文字继续往下走，不再当回声丢弃。
              if (t.length >= 2 || (isFinal && t)) handleBargeIn('asr');
              else return; // 单字/空：要么刚开始说，要么回声残影，再等等
            }
            if (isFinal && Date.now() - recentVoiceAt > 3000) return; // 幻听门控：isFinal 却无近期真声能 → 纯底噪幻听，丢弃（窗口放宽到 3s，VAD 断句+软尾音会拖 1~2s）
            if (t) {
              recentVoiceAt = Date.now(); // ASR 判到字 = 真在说话，刷新门控基准（hasVoicePcm 按 20ms 块判 RMS，软尾音/断续会漏，用「判到字」兜底）
              if (speaking) {
                // AI 还在「生成中」（尚未出声）用户就开口了：作废在途发话，别等它出声抢话
                currentGeneration++;
                currentAbort?.abort();
                speaking = false;
              }
              markUserVoice(); // ASR 判到字才算真的在说话（比 RMS 阈值可靠，不被底噪误判）
            }
            if (isFinal) {
              if (t) {
                const cleanText = normalizePersonaName(t, persona.name); // 名字同音字改回正确写法（如「明月」→「明悦」）
                const vocals = pendingVocals.list; // 把这期间的哭/笑事件附着到这轮文字
                const dominantVocal = pendingVocals.dominant();
                pendingVocals.reset();
                clearVocalTimer(); // 有字了，取消纯发声触发
                backchannel.onTurnEnd(); // 一轮结束，复位附和计数
                lastUserTurn = { text: cleanText, vocals, dominantVocal }; // 新债：这条必须回
                reanswerCount = 0; // 新债重置重答计数
                clearReanswer(); // 有新话了，取消上一次误打断的重答
                rtc?.sendControl({ type: 'transcript', role: 'user', text: cleanText }); // 回看：把"你说的话"推给前端文字记录
                respond(cleanText, vocals, dominantVocal).catch(console.error);
              }
            } else if (t) {
              clearReanswer(); // 用户在说新话：取消"误打断重答"，别抢话
              backchannel.onInterim(); // interim 有字：用户在说、还没说完，允许附和
            }
          },
        });
        const answer = await rtc.handleOffer(body.sdp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sdp: answer }));
        // 一联通就打招呼：优先放缓存的招呼语（秒回）。启动时已预热，这里再 await 一次兜底，
        // 确保第一句话一定是缓存片段（不吃 LLM 空响应的亏）；只有预热失败才回退 LLM 生成。
        const greetVoice = resolveVoice(persona.name, cfg.cosyvoiceVoice, lang);
        idleFired = true; // 招呼算一次主动发话，本轮静默不再重复
        try {
          await preloadGreetingClips(greetVoice, persona.name, persona.voiceTint, persona.rate ?? 1.0, lang);
          await rtc.whenReady(); // 等连接真正建立（首包到达）再放，否则开头音频会被切
          void obs.trace('greeting', { metadata: { kind: 'cached' } }, async () => {
            playCachedGreeting(greetVoice, lang);
          });
        } catch (e) {
          console.warn('[greeting] 招呼语预热失败，回退 LLM 生成：', e);
          speakProactive('greeting').catch(console.error);
        }
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  const PORT = Number(process.env.PORT ?? 3001);
  server.listen(PORT, () => {
    console.log(`实时通话服务已启动：http://localhost:${PORT}（信令 /rtc/offer）`);
  });

  // 做梦：空闲时自动巩固记忆（合并去重 + 清理矛盾 + 抽象升级）。有通话时跳过。
  const DREAM_INTERVAL_MS = 3 * 60 * 1000; // 每 3 分钟扫一次
  let dreaming = false;
  const lastDreamAt = new Map<string, string>(); // persona.name → 上次做梦完成时间（ISO），脏标记：没有新记忆就跳过
  async function runDreamIfIdle() {
    if (rtc || dreaming) return; // 正在通话 / 上一轮还没跑完就跳过
    dreaming = true;
    try {
      for (const p of Object.values(PERSONAS)) {
        if (!p.available) continue;
        try {
          // 脏标记：自上次做梦后没有新落库记忆，跳过（省掉全量重 embedding + 重跑 reflect LLM）。
          const prev = lastDreamAt.get(p.name);
          if (prev) {
            const fresh = await memory.listAll(p.name, userId, { since: prev });
            if (fresh.length === 0) continue;
          }
          const r = await dreamOnMemory({ llm, model: cfg.generateModel, store: memory, embedder, userId, characterId: p.name });
          lastDreamAt.set(p.name, new Date().toISOString()); // 完成后才记：做梦自己写的 fact/persona 不会再触发下一轮
          console.log(`[dream] ${p.name}：抽象 ${r.abstractedFacts}f/${r.abstractedPersona}p，合并 ${r.merged} 条，清矛盾 ${r.resolved} 条`);
        } catch (e) {
          console.warn(`[dream] ${p.name} 做梦失败：`, e);
        }
      }
    } finally {
      dreaming = false;
    }
  }
  setInterval(runDreamIfIdle, DREAM_INTERVAL_MS);

  // 进程退出前 flush 一次 LangFuse（后台批量，避免最后几个 trace 丢在缓冲区）。
  const shutdown = (sig: string) => {
    console.log(`[obs] 收到 ${sig}，flush LangFuse 后退出`);
    obs.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data) as T);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// 直接运行时（npm start → tsx apps/server/src/run.ts）由 run.ts 调用 main；
// Electron 主进程 import { main } 后自行调用。这里不再自动执行。
