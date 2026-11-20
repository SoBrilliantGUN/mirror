// ============================================================
// CallSession —— 单通通话编排。生命周期 = 一通电话（每 /rtc/offer 重置状态）。
//
// 职责地图（本文件唯一要背的心智模型）：
//   · 建连        handleOffer —— 建 RTC/ASR/NLS，预热招呼语，回 SDP
//   · 实时接入    onAsrResult —— ASR 流式 → 打断/抢话判定 → respond
//   · 对话回合    respond —— 决策(planTurn) + 召回(recallContext) + 装配 + 逐句流水线
//   · 主动发话    armIdleCheck / speakProactive —— 追问/checkin/找话题/道别/教练收尾
//   · 打断/抢话   handleBargeIn / doBargeIn —— 中止生成 + 误打断重答(armReanswer)
//   · 非言语发声  scheduleVocalRespond —— 哭/笑去抖后触发一次 respond
//   · 挂断收尾    teardownCall —— 写通话概要 + 结束会话
//
// 已拆出去的（这里只留窄回调，不背实现）：
//   · TTS 合成 + 多端点重试      → speech/ttsEngine.ts（TtsEngine）
//   · 招呼语片段缓存/落盘         → speech/greetingClips.ts（GreetingClipCache）
//   · 后台记忆/课题/人设巩固      → brain/consolidate/（memoryTurn / goalTurn / selfAddTurn / dream）
//
// 会话级字段分组：
//   · 注入共享资源（不随通话重置）: cfg / llm / safetyLlm / embedder / memory / tts / greetingClips …
//   · 会话状态（每通重置）: tracker / coachTracker / mood / lastAffect / persona / lang / history …
//   · 实时互锁（计时器 + 代际中止）: gate（GenerationGate）/ speaking / agentAudible …
// ============================================================
import type {
  Affect,
  DependenceSignals,
  EmotionTag,
  GrowthGoalStore,
  MemoryStore,
  MoodState,
  Persona,
  SelfAddedStore,
  TimeAware,
  VocalizationEvent,
} from '@mirror/contracts';
import type { Config } from './config';
import type { DeepSeek, ChatMessage, ToolCall } from './llm/deepseek';
import type { Embedder } from './llm/embedding';
import type { Obs } from './obs/langfuse';
import type { HistorySummarizer } from './brain/compress';
import type { HistoryEntry } from './brain/context';
import type { PersonaDetail } from './persona/loadPersona';
import type { DominantVocal } from './speech/vocalEvents';
import type { PrefetchCache } from './brain/assemble';
import type { OfferBody, OfferResult } from './router';
import { createRtcPeer } from './rtc/webrtc';
import { ParaformerRealtimeASR } from './speech/paraformerRealtime';
import { streamTTS } from './speech/cosyvoiceRealtime';
import { TtsEngine, buildTtsEndpoints } from './speech/ttsEngine';
import { GreetingClipCache } from './speech/greetingClips';
import { AcousticFeatureExtractor } from './speech/acousticFeatures';
import { NlsSoundEventDetector } from './speech/nlsSoundEvent';
import { normalizePersonaName } from './speech/nameNormalizer';
import { VocalEventAggregator } from './speech/vocalEvents';
import { buildInstruction, EMOTION_PROSODY, tailHint } from './speech/emotionInstruction';
import { BackchannelEngine, BACKCHANNEL_PHRASES, concatPcm, hasVoicePcm } from './speech/backchannel';
import { PERSONAS, resolvePersona, resolvePersonaDetails, resolveVoice } from './persona';
import { createPersonaMatcher } from './persona/loadPersona';
import { ModeTracker } from './brain/modeTracker';
import { CoachTracker } from './brain/coach';
import { planTurn } from './brain/turn';
import { evaluateDisinterest, evaluatePerfunctory } from './brain/interest';
import { SEARCH_TOOL, pickFiller } from './brain/search';
import { bochaSearch } from './search/bocha';
import { streamMessages, streamMessagesWithTools, generateProactiveText, extractAwaits } from './brain/generate';
import { recallContext, buildTurnMessages } from './brain/assemble';
import { createPrefetchCache } from './brain/consolidate/memoryTurn';
import { consolidateAfterTurn } from './brain/consolidate/afterTurn';
import { classifyMemory } from './brain/memoryClassifier';
import { GenerationGate } from './brain/generation';
import { classifySegmentEmotion } from './brain/segmentEmotion';
import { compressHistory } from './brain/compress';
import { summarizeCall, compressSummaries } from './brain/recentSummary';
import { buildProactiveSystemPrompt } from './brain/prompts';
import { buildCuriosityHint } from './brain/ontology';
import { buildGoalFollowUpHint, formatHistory } from './brain/context';
import { neutralAcoustic } from './fallbacks';
import { SafetyGuard } from './brain/safety';
import { CRISIS_RESOURCES } from './brain/crisisResources';
import { createSessionsStore } from './store/sessions';
import { createTranscriptStore } from './store/transcript';
import { createAskedQuestionsStore } from './store/askedQuestions';
import { createConversationSummariesStore } from './store/conversationSummaries';

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

// 是否在向用户提问（回退正则：优先用生成阶段顺带输出的 awaits 标签，漏打时用「句子里出现过问号」判断）。
const isAsking = (text: string) => /[？?]/.test(text);

// string[] / AsyncIterable 统一成 AsyncIterator，供逐句流水线预取下一句用。
function asyncIterator<T>(segments: AsyncIterable<T> | T[]): AsyncIterator<T> {
  if (Symbol.asyncIterator in (segments as AsyncIterable<T>)) {
    return (segments as AsyncIterable<T>)[Symbol.asyncIterator]();
  }
  const arr = segments as T[];
  let idx = 0;
  return {
    async next(): Promise<IteratorResult<T>> {
      return idx < arr.length ? { value: arr[idx++], done: false } : { value: undefined as T, done: true };
    },
  };
}

// 从对方一句话判语言：含中文 → zh；纯英文 → en；无语义字符（嗯/哦/数字/标点）→ null（不切换，保持现状）。
// 说话自动切换语言用，替代原来的中英文开关。
function detectLang(text: string): 'zh' | 'en' | null {
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[A-Za-z]/.test(text)) return 'en';
  return null;
}

// 主动发话计时（全部程序计时，不靠 LLM 自觉）。
const FOLLOWUP_MS = 5000;

// 非问句结尾后的「轻问找话题」等待时长：根据对方当前情绪动态决定，不写死一个数。
// 越沉（效价越负 / 唤醒越高 / 越无力 / 逞强）越要给人空间、等得越久；轻松时短一点。
function nudgeDelayMs(mood: MoodState | null, incongruence: boolean): number {
  const m = mood ?? { valence: 0, arousal: 0, dominance: 0 };
  let ms = 10000 // 中性基线 10s
    - Math.max(0, m.valence) * 2000       // 轻松（效价正）→ 早点接话
    + Math.max(0, -m.valence) * 2500      // 低落（效价负）→ 多给空间
    + Math.max(0, m.arousal) * 1500       // 激动 / 崩溃 → 别催
    + Math.max(0, -m.dominance) * 1500;   // 无力 / 被压着 → 多给空间
  if (incongruence) ms += 4000;           // 逞强（嘴上平静心里慌）→ 尤其别急着打断
  return Math.round(Math.min(Math.max(ms, 5000), 24000)); // 夹在 5s ~ 24s
}
const NO_REPLY_LIMIT = 3; // 1 次没答→自问自答，2 次→问"还在吗"，3 次→情绪化收尾
const COACH_SILENT_MS = 30000;
const COACH_CLOSE_MS = 30000;
const MIN_SEARCH_MS = 1500;
const REANSWER_MS = 2500;
const REANSWER_LIMIT = 2;
const INTERRUPT_GRACE_MS = 700;
const TOPIC_DRIFT_LIMIT = 3;
const VOCAL_DEBOUNCE_MS = 3000;
const VOCAL_MAX_HOLD_MS = 6000;
const VOCAL_COOLDOWN_MS = 8000;

export type SessionDeps = {
  cfg: Config;
  llm: DeepSeek;
  safetyLlm: DeepSeek;
  embedder: Embedder;
  memory: MemoryStore;
  askedQuestions: ReturnType<typeof createAskedQuestionsStore>;
  conversationSummaries: ReturnType<typeof createConversationSummariesStore>;
  selfAdded: SelfAddedStore;
  goals: GrowthGoalStore;
  sessions: ReturnType<typeof createSessionsStore>;
  transcript: ReturnType<typeof createTranscriptStore>;
  obs: Obs;
  timeAware: TimeAware;
  summarizer: HistorySummarizer;
  memoryBudget: number;
  historyBudget: number;
  userId: string;
};

export class CallSession {
  // —— 注入的共享资源（不随通话重置） ——
  private readonly cfg: Config;
  private readonly llm: DeepSeek;
  private readonly safetyLlm: DeepSeek;
  private readonly embedder: Embedder;
  private readonly memory: MemoryStore;
  private readonly askedQuestions: SessionDeps['askedQuestions'];
  private readonly conversationSummaries: SessionDeps['conversationSummaries'];
  private readonly selfAdded: SelfAddedStore;
  private readonly goals: GrowthGoalStore;
  private readonly sessions: SessionDeps['sessions'];
  private readonly transcript: SessionDeps['transcript'];
  private readonly obs: Obs;
  private readonly timeAware: TimeAware;
  private readonly summarizer: HistorySummarizer;
  private readonly memoryBudget: number;
  private readonly historyBudget: number;
  private readonly userId: string;

  // —— 会话级状态（每通重置） ——
  private tracker = new ModeTracker();
  private coachTracker = new CoachTracker();
  private goalFollowUpDone = false;
  private coachCheckinDone = false;
  private mood: MoodState | null = null;
  private lastAffect: Affect | null = null; // 最近一轮的 affect（含 incongruence，供 nudge 动态计时用）
  private persona: Persona = resolvePersona('程书衡')!;
  private lang: 'zh' | 'en' = 'zh';
  private englishMode: 'immersion' | 'coach' = 'immersion';
  private personaMatcher: ((text: string) => Promise<PersonaDetail[]>) | null = null;
  private safetyGuard!: SafetyGuard; // 构造器赋值（依赖 safetyLlm/cfg）
  private currentSessionId: string | null = null;

  private rtc: ReturnType<typeof createRtcPeer> | null = null;
  private asr: ParaformerRealtimeASR | null = null;
  private acoustic: AcousticFeatureExtractor | null = null;
  private sed: NlsSoundEventDetector | null = null;
  private pendingVocals = new VocalEventAggregator();
  private vocalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVocalRespondAt = 0;
  private readonly gate = new GenerationGate(); // 代际中止门：哪次生成还作数 + 对应 AbortSignal
  private lastUserTurn: { text: string; vocals: VocalizationEvent[]; dominantVocal: DominantVocal } | null = null;
  private reanswerTimer: ReturnType<typeof setTimeout> | null = null;
  private reanswerCount = 0;
  private history: HistoryEntry[] = [];
  private recentSummaryText = '';
  private turnCount = 0;
  private loadedDetails: PersonaDetail[] = [];
  private readonly prefetchCache: PrefetchCache = createPrefetchCache();

  private lastUserVoiceAt = Date.now();
  private idleFired = false;
  private lastTurnAskedQuestion = false;
  private lastQuestionText = '';
  private lastCuriosityHint = '';
  private noReplyStreak = 0;
  private disinterestStreak = 0;
  private perfunctoryStreak = 0;
  private consecutiveQuestions = 0;
  private readonly userSaid: string[] = [];
  private prevTurnMemoryIds: string[] = [];
  private agentDoneAt = 0;
  private lastReplyLatencyMs = 0;
  private recentVoiceAt = 0;
  private agentAudible = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private speaking = false;
  private userGender: '男' | '女' | null = null;
  private lastWasFarewell = false;
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingInterrupt = false;
  private interruptGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBargeInAt = 0;

  private readonly backchannel = new BackchannelEngine(
    { silenceMs: 500, cooldownMs: 15000, maxPerTurn: 6, gain: 0.5, minSpeechMs: 30000 },
    (pcm, gain) => this.rtc?.pushAgentPcm(pcm, gain),
  );

  private readonly tts: TtsEngine; // 构造器赋值（依赖 cfg 端点 + rtc 闭包）

  private readonly greetingClips: GreetingClipCache; // 构造器赋值（依赖 cfg）

  constructor(deps: SessionDeps) {
    this.cfg = deps.cfg;
    this.llm = deps.llm;
    this.safetyLlm = deps.safetyLlm;
    this.embedder = deps.embedder;
    this.memory = deps.memory;
    this.askedQuestions = deps.askedQuestions;
    this.conversationSummaries = deps.conversationSummaries;
    this.selfAdded = deps.selfAdded;
    this.goals = deps.goals;
    this.sessions = deps.sessions;
    this.transcript = deps.transcript;
    this.obs = deps.obs;
    this.timeAware = deps.timeAware;
    this.summarizer = deps.summarizer;
    this.memoryBudget = deps.memoryBudget;
    this.historyBudget = deps.historyBudget;
    this.userId = deps.userId;
    // safetyGuard 依赖 safetyLlm/cfg，字段初始化在构造器赋值之后再建。
    this.safetyGuard = new SafetyGuard({ llm: this.safetyLlm, model: this.cfg.safetyModel });
    // TTS 合成引擎：把「整句合成 + 多端点重试」委托出去，只留 pushPcm 回调指向当前 RTC。
    this.tts = new TtsEngine(
      buildTtsEndpoints(this.cfg),
      (pcm) => this.rtc?.pushAgentPcm(pcm),
      () => { this.agentAudible = true; },
      (ms) => this.sleep(ms),
    );
    // 招呼语片段缓存：只管加载/落盘；播放与落库仍在本类。
    this.greetingClips = new GreetingClipCache({
      wsUrl: this.cfg.dashscopeWsUrl,
      apiKey: this.cfg.dashscopeApiKey,
      model: this.cfg.cosyvoiceModel,
    });
  }

  get personaName(): string {
    return this.persona.name;
  }

  get isInCall(): boolean {
    return this.rtc !== null;
  }

  // 启动即把所有上线人物的招呼语预热成缓存片段，让第一通的第一句话一定是缓存好的（秒回）。
  preloadGreetings(): void {
    for (const p of Object.values(PERSONAS)) {
      if (!p.available) continue;
      const voice = resolveVoice(p.name, this.cfg.cosyvoiceVoice);
      this.greetingClips.ensure(voice, p.name, p.voiceTint, p.rate ?? 1.0).catch((e) =>
        console.warn(`[greeting] ${p.name} 招呼语预热失败：`, e),
      );
    }
  }

  // /rtc/offer：建立一通新通话。返回 SDP 答案（或错误）。招呼语在响应写出后异步播放。
  async handleOffer(body: OfferBody): Promise<OfferResult> {
    this.lang = body.lang === 'en' ? 'en' : 'zh';
    this.englishMode = body.englishMode === 'coach' ? 'coach' : 'immersion';
    const resolved = resolvePersona(body.name ?? '程书衡');
    if (!resolved) {
      return { error: `未上线或不存在的人物：${body.name}`, status: 400 };
    }
    this.persona = resolved;
    // 人物详情渐进式加载（认知/经历/偏好）：运行期语义匹配；常驻底座已在构建期烤进 systemPrompt。
    const details = resolvePersonaDetails(this.persona.name);
    this.personaMatcher = details.length ? createPersonaMatcher(this.embedder, details) : null;
    if (details.length) console.log(`[persona] ${this.persona.name} 启用渐进式记忆：共 ${details.length} 条详情待命中加载`);
    if (resolveVoice(this.persona.name, this.cfg.cosyvoiceVoice, this.lang) === this.cfg.cosyvoiceVoice && this.persona.name !== '程书衡') {
      console.warn(`[voice] ${this.persona.name} 尚未配置专属音色，暂用程书衡音色；用 npm run enroll-voices 建模后填 env。`);
    }
    // 副语言 backchannel：复位 + 切音色 + 预生成片段（懒、按音色缓存）。
    this.backchannel.reset();
    const backVoice = resolveVoice(this.persona.name, this.cfg.cosyvoiceVoice, this.lang);
    this.backchannel.setVoice(backVoice);
    if (!this.backchannel.hasClips(backVoice)) {
      this.preloadBackchannelClips(backVoice, this.persona.name).catch((e) =>
        console.warn('[backchannel] 片段预生成失败：', e),
      );
    }
    this.sed?.close();
    this.asr = new ParaformerRealtimeASR();
    this.acoustic = new AcousticFeatureExtractor();
    this.pendingVocals = new VocalEventAggregator();
    this.history = [];
    this.tracker = new ModeTracker();
    this.coachTracker = new CoachTracker();
    this.goalFollowUpDone = false;
    this.coachCheckinDone = false;
    this.safetyGuard = new SafetyGuard({ llm: this.safetyLlm, model: this.cfg.safetyModel });
    this.mood = null;
    this.lastAffect = null;
    this.turnCount = 0;
    this.loadedDetails = [];
    this.prefetchCache.clear();
    this.lastUserVoiceAt = Date.now();
    this.idleFired = false;
    this.clearPendingInterrupt();
    this.lastTurnAskedQuestion = false;
    this.lastQuestionText = '';
    this.userSaid.length = 0;
    this.prevTurnMemoryIds = [];
    this.lastCuriosityHint = '';
    this.recentSummaryText = '';
    this.conversationSummaries.recent(this.persona.name, this.userId, 3)
      .then(async (summaries) => {
        if (summaries.length === 0) return;
        this.recentSummaryText = await compressSummaries(this.llm, this.cfg.generateModel, summaries).catch(() => summaries.join('\n'));
      })
      .catch(() => {});
    this.noReplyStreak = 0;
    this.disinterestStreak = 0;
    this.perfunctoryStreak = 0;
    this.consecutiveQuestions = 0;
    this.agentDoneAt = 0;
    this.lastReplyLatencyMs = 0;
    this.speaking = false;
    this.userGender = null;

    // 哭/笑检测（NLS 云端）：收 PCM、出事件。连不上/未配凭证时 onEvent 不被调用，主链路照常。
    const hasToken = Boolean(this.cfg.nlsToken);
    const hasAk = Boolean(this.cfg.nlsAkId && this.cfg.nlsAkSecret);
    if (this.cfg.nlsEnabled && this.cfg.nlsAppKey && (hasToken || hasAk)) {
      this.sed = new NlsSoundEventDetector(
        {
          appKey: this.cfg.nlsAppKey,
          token: this.cfg.nlsToken || undefined,
          akId: this.cfg.nlsAkId || undefined,
          akSecret: this.cfg.nlsAkSecret || undefined,
        },
        (ev) => {
          this.pendingVocals.add(ev);
          console.log('[NLS] 非言语发声：', JSON.stringify(ev), '主导：', this.pendingVocals.dominant());
          this.scheduleVocalRespond();
        },
      );
    } else if (!this.cfg.nlsEnabled) {
      this.sed = null;
      console.warn('[NLS] 已通过 NLS_ENABLED=false 关闭哭/笑检测');
    } else {
      this.sed = null;
      console.warn('[NLS] 未配 NLS 凭证（NLS_APPKEY + NLS_TOKEN 或 NLS_ACCESS_KEY_ID/SECRET），哭/笑检测关闭');
    }

    // 通话会话记录：结束上一通（若有残留），开新一条；失败不阻断建连。
    if (this.currentSessionId) this.sessions.end(this.currentSessionId).catch(() => {});
    this.currentSessionId = await this.sessions.start(this.persona.name, this.userId).catch(() => null);
    this.obs.setSession(this.currentSessionId ? { sessionId: this.currentSessionId, userId: this.userId, characterId: this.persona.name } : null);

    this.rtc = createRtcPeer(
      {
        onUserPcm: (chunk) => {
          // ASR 和 NLS 始终收——否则陪伴者说话时你抢话，麦克风被门挡住听不见。
          this.asr?.sendAudio(chunk);
          this.sed?.sendPcm(chunk);
          if (this.speaking) return;
          if (hasVoicePcm(chunk)) this.recentVoiceAt = Date.now();
          this.acoustic?.push(chunk);
          this.backchannel.feedPcm(chunk);
        },
        onInterrupt: () => this.handleBargeIn('rtc'),
        onPlaybackEnd: () => {
          this.speaking = false;
          this.agentAudible = false;
          this.lastUserVoiceAt = Date.now();
          this.agentDoneAt = Date.now();
          if (this.lastWasFarewell) {
            this.lastWasFarewell = false;
            this.scheduleHangup();
          }
          this.armIdleCheck();
        },
        onHangup: () => {
          console.log('[RTC] 收到挂断，立刻停');
          this.teardownCall('hangup');
        },
        onClose: () => {
          this.teardownCall('close');
        },
      },
      { portRange: this.cfg.icePortRange, hostAddress: this.cfg.iceHostAddress },
    );
    await this.sed?.start();
    try {
      await this.asr.start({
        wsUrl: this.cfg.dashscopeWsUrl,
        apiKey: this.cfg.dashscopeApiKey,
        model: this.cfg.paraformerModel,
        languageHints: ['zh', 'en'],
        onResult: (text, isFinal) => this.onAsrResult(text, isFinal),
      });
    } catch (e) {
      // ASR（语音识别）连不上就别让信令白白 500：回收半成品连接，回一个可读的错误。
      this.rtc?.close();
      this.rtc = null;
      this.sed?.close();
      const detail = (e as Error)?.message ?? String(e);
      const hint = this.cfg.dashscopeApiKey
        ? `（${detail}，请检查 DASHSCOPE_API_KEY / DASHSCOPE_WS_URL 是否有效）`
        : '（未配置 DASHSCOPE_API_KEY，请先在「设置」里填写语音服务 Key）';
      return { error: `语音识别服务连接失败${hint}`, status: 502 };
    }
    const answer = await this.rtc.handleOffer(body.sdp);

    // 一联通就打招呼（异步、不阻塞响应）：优先缓存片段，预热失败回退 LLM 生成。
    const greetVoice = resolveVoice(this.persona.name, this.cfg.cosyvoiceVoice, this.lang);
    this.idleFired = true;
    void (async () => {
      try {
        await this.greetingClips.ensure(greetVoice, this.persona.name, this.persona.voiceTint, this.persona.rate ?? 1.0, this.lang);
        await this.rtc?.whenReady();
        await this.obs.trace('greeting', { metadata: { kind: 'cached' } }, async () => {
          this.playCachedGreeting(greetVoice, this.lang);
        });
      } catch (e) {
        console.warn('[greeting] 招呼语预热失败，回退 LLM 生成：', e);
        this.speakProactive('greeting').catch(console.error);
      }
    })();

    return { sdp: answer };
  }

  private onAsrResult(text: string, isFinal: boolean): void {
    console.log('[ASR] 结果：', JSON.stringify({ text, isFinal }));
    const t = text.trim();
    if (t && isFillerText(t) && (this.agentAudible || this.pendingInterrupt || Date.now() - this.lastBargeInAt < 1500)) {
      if (isFinal) {
        this.clearPendingInterrupt();
        this.pendingVocals.reset();
      } else if (this.pendingInterrupt) {
        if (this.interruptGraceTimer !== null) clearTimeout(this.interruptGraceTimer);
        this.interruptGraceTimer = setTimeout(() => {
          this.interruptGraceTimer = null;
          this.pendingInterrupt = false;
          this.doBargeIn('rtc');
        }, INTERRUPT_GRACE_MS);
      }
      return;
    }
    if (this.agentAudible) {
      if (t.length >= 2 || (isFinal && t)) this.handleBargeIn('asr');
      else return;
    }
    if (isFinal && Date.now() - this.recentVoiceAt > 3000) return; // 幻听门控
    if (t) {
      this.recentVoiceAt = Date.now();
      if (this.speaking) {
        this.gate.invalidate();
        this.speaking = false;
      }
      this.markUserVoice();
    }
    if (isFinal) {
      if (t) {
        const cleanText = normalizePersonaName(t, this.persona.name);
        // 说话自动切语言：含中文回 zh、纯英文切 en，无语义字符（嗯/哦）保持不变。
        const detected = detectLang(cleanText);
        if (detected && detected !== this.lang) {
          this.lang = detected;
          console.log(`[lang] 根据对方说话自动切到：${this.lang}`);
        }
        const vocals = this.pendingVocals.list;
        const dominantVocal = this.pendingVocals.dominant();
        this.pendingVocals.reset();
        this.clearVocalTimer();
        this.backchannel.onTurnEnd();
        this.lastUserTurn = { text: cleanText, vocals, dominantVocal };
        this.reanswerCount = 0;
        this.clearReanswer();
        this.rtc?.sendControl({ type: 'transcript', role: 'user', text: cleanText });
        this.respond(cleanText, vocals, dominantVocal).catch(console.error);
      }
    } else if (t) {
      this.clearReanswer();
      this.backchannel.onInterim();
    }
  }

  private async respond(userText: string, vocals: VocalizationEvent[] = [], dominantVocal: DominantVocal = null) {
    if (!this.rtc) return;
    const tStart = Date.now();
    const { gen: myGen, signal } = this.gate.begin();
    const searchEnabled = Boolean(this.cfg.bochaApiKey);
    this.speaking = true;
    let reachedEnd = false;
    await this.obs.trace('turn', {
      metadata: { kind: 'respond', characterId: this.persona.name, turnIndex: this.turnCount, dominantVocal },
      input: { text: userText, vocals, dominantVocal },
    }, async () => {
    try {
    const acoustics = this.acoustic?.finalize(userText) ?? neutralAcoustic();
    if (!this.userGender) {
      const g = this.acoustic?.detectGender() ?? null;
      if (g) {
        this.userGender = g;
        console.log('[gender] 判出对方性别：', g);
        this.obs.event('gender-detected', { gender: g });
      }
    }
    console.log('[respond] 触发，用户说：', userText, '声学：', JSON.stringify(acoustics), '非言语：', JSON.stringify(vocals));
    if (dominantVocal) this.obs.event('vocal', { dominantVocal, count: vocals.length });

    const assembleDeps = {
      store: this.memory,
      userId: this.userId,
      characterId: this.persona.name,
      memoryBudget: this.memoryBudget,
      compress: (entries: HistoryEntry[]) => compressHistory(entries, this.historyBudget, this.summarizer),
      timeAware: this.timeAware,
      selfAdded: this.selfAdded,
      goals: this.goals,
      personaMatch: this.personaMatcher ?? undefined,
      prefetchCache: this.prefetchCache,
    };
    const dependenceSignals: DependenceSignals = this.currentSessionId
      ? await this.sessions.signals(this.persona.name, this.userId, this.currentSessionId).catch(() => ({ recentCalls7d: 0, currentCallMinutes: 0, lastGapMinutes: null }))
      : { recentCalls7d: 0, currentCallMinutes: 0, lastGapMinutes: null };
    const [plan, ctx, recentAsked] = await Promise.all([
      this.obs.span('decision', () => planTurn(
        { llm: this.llm, scoreModel: this.cfg.scoreModel, generateModel: this.cfg.generateModel, safetyGuard: this.safetyGuard, tracker: this.tracker, coachTracker: this.coachTracker, mood: this.mood },
        { text: userText, acoustic: acoustics, vocalizations: vocals, dominantVocal, persona: this.persona, dependenceSignals },
      )),
      this.obs.span('recall', () => recallContext(assembleDeps, { text: userText, history: this.history, loadedDetails: this.loadedDetails })),
      this.askedQuestions.recent(this.persona.name, this.userId, 3),
    ]);
    if (!this.gate.isCurrent(myGen)) return;
    this.mood = plan.mood;
    this.lastAffect = plan.affect;
    const disinterest = evaluateDisinterest(plan.affect.arousal, this.lastReplyLatencyMs, this.disinterestStreak);
    this.disinterestStreak = disinterest.streak;
    const perfunctory = evaluatePerfunctory(userText, this.perfunctoryStreak);
    this.perfunctoryStreak = perfunctory.streak;
    const topicDrift = this.consecutiveQuestions >= TOPIC_DRIFT_LIMIT;
    const switchTopic = plan.frame !== 'coach' && (disinterest.switchTopic || perfunctory.switchTopic || topicDrift);
    if (switchTopic) {
      this.disinterestStreak = 0;
      this.perfunctoryStreak = 0;
      this.consecutiveQuestions = 0;
    }
    this.loadedDetails = ctx.loadedDetails;
    const curiosityHint = plan.frame === 'coach' ? this.lastCuriosityHint : (buildCuriosityHint(ctx.coverage) ?? '');
    if (curiosityHint !== this.lastCuriosityHint) {
      this.lastCuriosityHint = curiosityHint;
      console.log('[CURIOSITY] 缺口线索：', curiosityHint || '（无缺口）');
    }
    console.log('[L3] 决策完成，情绪：', plan.emotion);
    console.log('[latency] 打分+召回耗时', Date.now() - tStart, 'ms');
    this.obs.score('decision-ms', Date.now() - tStart);

    if (plan.safetyAction.action === 'refer') {
      this.rtc?.sendControl({ type: 'safety', level: plan.safetyAction.level, resources: CRISIS_RESOURCES });
      console.log('[safety] 命中危机，转介 level=', plan.safetyAction.level);
      this.obs.event('safety-refer', { level: plan.safetyAction.level });
    }

    let goalFollowUp = '';
    if (!this.goalFollowUpDone && plan.frame === 'friend') {
      goalFollowUp = buildGoalFollowUpHint(ctx.goals);
      if (goalFollowUp) this.goalFollowUpDone = true;
    }

    const messages = buildTurnMessages(ctx, this.memoryBudget, {
      text: userText,
      mode: plan.mode,
      stance: plan.stance,
      frame: plan.frame,
      coachInvite: plan.coachInvite,
      celebrate: plan.celebrate,
      goalFollowUp,
      emotion: plan.emotion,
      mood: this.mood,
      turnCount: ++this.turnCount,
      affect: plan.affect,
      userGender: this.userGender,
      switchTopic,
      personaSystemPrompt: buildLanguagePrompt(this.persona.systemPrompt, this.lang, this.englishMode),
      vocalizations: vocals,
      safetyAction: plan.safetyAction,
      dependence: plan.dependence,
      farewell: plan.farewell,
      lastAskedQuestion: this.lastQuestionText,
      userSaid: [...this.userSaid],
      recentAsked,
      recentSummary: this.recentSummaryText,
      curiosityHint,
      searchEnabled,
    });

    let awaitsResponse: boolean | null = null;
    let firstTokenMs = 0;
    const speakOne = async (seg: string, i: number, segEmotion: EmotionTag): Promise<string> => {
      const { clean, awaits } = extractAwaits(seg);
      if (awaits !== null) awaitsResponse = awaits;
      if (!clean) return '';
      const segProsody = EMOTION_PROSODY[segEmotion];
      const segRate = Math.round((this.persona.rate ?? 1.0) * (segProsody.rate ?? 1.0) * 100) / 100;
      if (i === 0) {
        firstTokenMs = Date.now() - tStart;
        console.log('[latency] 首句开始合成', firstTokenMs, 'ms（从用户说完）');
        this.obs.score('first-token-ms', firstTokenMs);
      }
      console.log('[TTS] 合成这句：', clean, '情绪：', segEmotion);
      await this.obs.span('tts', () => this.tts.synthesize({
        model: this.cfg.cosyvoiceModel,
        voice: resolveVoice(this.persona.name, this.cfg.cosyvoiceVoice, this.lang),
        instruction: buildInstruction(segEmotion, this.persona.voiceTint) + tailHint(clean),
        text: clean,
        rate: segRate,
        pitch: segProsody.pitch,
        signal,
      }), { text: clean, emotion: segEmotion });
      return clean;
    };

    // 逐句流水线：下一句的「LLM 续写 + 情绪分类」与当前句的 TTS 播放重叠跑，
    // 消掉句与句之间的停顿/卡顿（否则每句都要先等分类、再等 LLM 续写出下一句，开头就顿一下）。
    const speakSegments = async (segments: AsyncIterable<string> | string[]): Promise<string> => {
      const it = asyncIterator(segments);
      let full = '';
      let i = 0;

      const classify = async (seg: string): Promise<{ text: string; emotion: EmotionTag }> => ({
        text: seg,
        emotion: await classifySegmentEmotion(this.llm, this.cfg.generateModel, extractAwaits(seg).clean, plan.emotion),
      });
      const prefetch = async (): Promise<{ text: string; emotion: EmotionTag } | null> => {
        const n = await it.next();
        return n.done ? null : classify(n.value);
      };

      // 首句零延迟：直接用本轮基调，不跑分类。
      const first = await it.next();
      if (first.done) return '';
      let cur: { text: string; emotion: EmotionTag } | null = { text: first.value, emotion: plan.emotion };
      let nextP: Promise<{ text: string; emotion: EmotionTag } | null> = prefetch();

      while (cur) {
        if (!this.gate.isCurrent(myGen)) break;
        full += await speakOne(cur.text, i, cur.emotion);
        i++;
        cur = await nextP;
        if (cur) nextP = prefetch();
      }
      return full;
    };

    let fullText = '';
    if (!searchEnabled) {
      fullText = await speakSegments(streamMessages(this.llm, this.cfg.generateModel, messages));
    } else {
      let searchCall: ToolCall | null = null;
      let spoken = '';
      let i = 0;
      for await (const ev of streamMessagesWithTools(this.llm, this.cfg.generateModel, messages, [SEARCH_TOOL])) {
        if (!this.gate.isCurrent(myGen)) return;
        if (ev.kind === 'sentence') {
          const segEmotion = i === 0
            ? plan.emotion
            : await classifySegmentEmotion(this.llm, this.cfg.generateModel, extractAwaits(ev.text).clean, plan.emotion);
          spoken += await speakOne(ev.text, i, segEmotion);
          i++;
        } else if (ev.kind === 'tool_calls') {
          searchCall = ev.calls.find((c) => c.name === 'search_web') ?? null;
        }
      }
      if (!this.gate.isCurrent(myGen)) return;
      if (!searchCall || spoken.trim()) {
        console.log('[search] 本轮未发起搜索（模型直接作答）');
        fullText = spoken;
      } else {
        let query = '';
        try { query = (JSON.parse(searchCall.arguments)?.query as string) ?? ''; } catch { query = ''; }
        console.log('[search] 模型发起联网搜索：', query || '（空 query）');
        for await (const pcm of streamTTS({
          wsUrl: this.cfg.dashscopeWsUrl,
          apiKey: this.cfg.dashscopeApiKey,
          model: this.cfg.cosyvoiceModel,
          voice: resolveVoice(this.persona.name, this.cfg.cosyvoiceVoice, this.lang),
          instruction: buildInstruction('natural', this.persona.voiceTint),
          text: pickFiller(),
          rate: this.persona.rate ?? 1.0,
          signal,
        })) {
          if (!this.gate.isCurrent(myGen)) break;
          this.rtc?.pushAgentPcm(pcm);
        }
        const t0 = Date.now();
        const results = query ? await bochaSearch(query, { apiKey: this.cfg.bochaApiKey, baseUrl: this.cfg.bochaBaseUrl }) : [];
        await this.sleep(Math.max(0, MIN_SEARCH_MS - (Date.now() - t0)));
        console.log('[search] 搜索返回', results.length, '条');
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
        fullText = await speakSegments(streamMessages(this.llm, this.cfg.generateModel, [...messages, assistantMsg, toolMsg]));
      }
    }
    if (this.gate.isCurrent(myGen)) {
      this.lastUserTurn = null;
      this.reanswerCount = 0;
      this.history.push({ kind: 'turn', role: 'user', text: userText });
      if (fullText.trim()) this.history.push({ kind: 'turn', role: 'agent', text: fullText.trim() });
      reachedEnd = true;
      this.rtc?.end();
      const replyText = fullText.trim();
      if (replyText) this.rtc?.sendControl({ type: 'transcript', role: 'agent', text: replyText });
      this.obs.setOutput(replyText);
      const asked = awaitsResponse !== null ? awaitsResponse : isAsking(replyText);
      this.transcript.insert(this.persona.name, this.userId, {
        sessionId: this.currentSessionId,
        role: 'user',
        text: userText,
        turnIndex: this.turnCount,
        affect: plan.affect,
        acoustic: acoustics,
        vocals: vocals.length ? vocals : undefined,
        latencyMs: this.lastReplyLatencyMs || null,
      }).catch((e) => console.warn('[transcript] 用户话落库失败：', e));
      if (replyText) {
        this.transcript.insert(this.persona.name, this.userId, {
          sessionId: this.currentSessionId,
          role: 'agent',
          text: replyText,
          turnIndex: this.turnCount,
          emotion: plan.emotion,
          recalled: {
            constraint: ctx.recalled.constraint.map((m) => ({ id: m.id, content: m.content })),
            profile: ctx.recalled.profile.map((m) => ({ id: m.id, content: m.content })),
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
      this.lastTurnAskedQuestion = asked;
      if (asked) this.lastQuestionText = replyText; else this.lastQuestionText = '';
      if (asked && replyText) this.askedQuestions.record(this.persona.name, this.userId, replyText).catch(() => {});
      if (asked) this.consecutiveQuestions++; else this.consecutiveQuestions = 0;
      if (plan.farewell) {
        this.lastTurnAskedQuestion = false;
        this.lastWasFarewell = true;
        this.idleFired = true;
      }

      consolidateAfterTurn({
        llm: this.llm,
        model: this.cfg.generateModel,
        memory: this.memory,
        goals: this.goals,
        selfAdded: this.selfAdded,
        embedder: this.embedder,
        classify: (raw) => classifyMemory(this.llm, this.cfg.generateModel, raw),
        userId: this.userId,
        characterId: this.persona.name,
        userText,
        agentText: fullText.trim(),
        personaSystemPrompt: this.persona.systemPrompt,
        frame: plan.frame,
        prefetchCache: this.prefetchCache,
        retractIds: this.prevTurnMemoryIds,
      })
        .then((res) => {
          this.prevTurnMemoryIds = res.writtenIds;
          for (const f of res.facts) this.userSaid.push(f);
        })
        .catch((e) => console.warn('[memory] 后台写记忆失败：', e));
    }
    } finally {
      if (this.gate.isCurrent(myGen) && !reachedEnd) {
        this.speaking = false;
        this.agentAudible = false;
        this.lastUserVoiceAt = Date.now();
        this.armIdleCheck();
      }
    }
    });
  }

  private async speakProactive(kind: 'greeting' | 'nudge' | 'followup' | 'checkin' | 'farewell' | 'coachClose') {
    if (!this.rtc || this.speaking) return;
    const { gen: myGen, signal } = this.gate.begin();
    this.speaking = true;
    let reachedEnd = false;
    console.log('[proactive] 开始：', kind);
    await this.obs.trace('proactive', {
      metadata: { kind, characterId: this.persona.name },
      input: { kind },
    }, async () => {
    try {
      const system = buildProactiveSystemPrompt(
        kind,
        buildLanguagePrompt(this.persona.systemPrompt, this.lang, this.englishMode),
        {
          lastQuestion: this.lastQuestionText,
          curiosityHint: kind === 'nudge' && this.coachTracker.current === 'friend' ? this.lastCuriosityHint || undefined : undefined,
          recentTurns: formatHistory(this.history.slice(-6)),
          mood: this.mood,
        },
      );
      const text = await generateProactiveText(this.llm, this.cfg.generateModel, system);
      if (!this.gate.isCurrent(myGen)) return;
      const { clean: seg, awaits } = extractAwaits(text.trim());
      if (!seg) return;
      console.log('[proactive] 文本：', seg);
      this.obs.setOutput(seg);
      await this.obs.span('tts', () => this.tts.synthesize({
        model: this.cfg.cosyvoiceModel,
        voice: resolveVoice(this.persona.name, this.cfg.cosyvoiceVoice, this.lang),
        instruction: buildInstruction('natural', this.persona.voiceTint) + tailHint(seg),
        text: seg,
        rate: this.persona.rate ?? 1.0,
        signal,
      }), { text: seg });
      if (this.gate.isCurrent(myGen)) {
        this.history.push({ kind: 'turn', role: 'agent', text: seg });
        this.rtc?.sendControl({ type: 'transcript', role: 'agent', text: seg });
        reachedEnd = true;
        this.rtc?.end();
        const asked = awaits !== null ? awaits : isAsking(seg);
        this.lastTurnAskedQuestion = asked;
        if (asked) this.lastQuestionText = seg; else this.lastQuestionText = '';
        if (kind === 'farewell' || kind === 'coachClose') this.lastWasFarewell = true;
        this.transcript.insert(this.persona.name, this.userId, {
          sessionId: this.currentSessionId,
          role: 'agent',
          text: seg,
          turnIndex: this.turnCount,
          emotion: 'natural',
          frame: this.coachTracker.current,
          asked,
        }).catch((e) => console.warn('[transcript] 主动话落库失败：', e));
      }
    } catch (e) {
      console.warn('[proactive] 主动发话失败：', e);
    } finally {
      if (this.gate.isCurrent(myGen) && !reachedEnd) {
        this.speaking = false;
        this.agentAudible = false;
        this.lastUserVoiceAt = Date.now();
        this.armIdleCheck();
      }
    }
    });
  }

  private markUserVoice() {
    const now = Date.now();
    if (this.agentDoneAt > 0) {
      this.lastReplyLatencyMs = now - this.agentDoneAt;
      this.agentDoneAt = 0;
    }
    this.lastUserVoiceAt = now;
    this.idleFired = false;
    this.lastTurnAskedQuestion = false;
    this.noReplyStreak = 0;
    this.coachCheckinDone = false;
    this.lastWasFarewell = false;
    if (this.hangupTimer !== null) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
  }

  private clearReanswer() {
    if (this.reanswerTimer !== null) { clearTimeout(this.reanswerTimer); this.reanswerTimer = null; }
  }

  private armReanswer() {
    this.clearReanswer();
    const turn = this.lastUserTurn;
    if (!turn || this.reanswerCount >= REANSWER_LIMIT) return;
    this.reanswerTimer = setTimeout(() => {
      this.reanswerTimer = null;
      if (this.lastUserTurn === turn && !this.speaking && this.rtc) {
        this.reanswerCount++;
        console.log('[respond] 误打断后重答（第', this.reanswerCount, '次）：', turn.text);
        void this.obs.trace('reanswer', { metadata: { attempt: this.reanswerCount, characterId: this.persona.name } }, async () => {});
        this.respond(turn.text, turn.vocals, turn.dominantVocal).catch(console.error);
      }
    }, REANSWER_MS);
  }

  private armIdleCheck() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.rtc || this.speaking) return;
    if (this.coachTracker.current === 'coach') {
      const target = this.coachCheckinDone ? COACH_CLOSE_MS : COACH_SILENT_MS;
      const wait = Math.max(0, target - (Date.now() - this.lastUserVoiceAt));
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.rtc || this.speaking) return;
        if (Date.now() - this.lastUserVoiceAt >= target) {
          if (!this.coachCheckinDone) {
            this.coachCheckinDone = true;
            console.log('[proactive] 教练态沉默较久，轻轻确认一次');
            this.speakProactive('checkin').catch(console.error);
          } else {
            console.log('[proactive] 教练态确认后仍无回应，温柔收尾');
            this.speakProactive('coachClose').catch(console.error);
          }
        } else {
          this.armIdleCheck();
        }
      }, wait);
      return;
    }
    if (this.lastTurnAskedQuestion && this.noReplyStreak < NO_REPLY_LIMIT) {
      const wait = Math.max(0, FOLLOWUP_MS - (Date.now() - this.lastUserVoiceAt));
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.rtc || this.speaking) return;
        if (Date.now() - this.lastUserVoiceAt >= FOLLOWUP_MS) {
          this.noReplyStreak++;
          if (this.noReplyStreak >= NO_REPLY_LIMIT) {
            this.idleFired = true;
            console.log('[proactive] 触发 farewell（多次没回应）');
            this.speakProactive('farewell').catch(console.error);
          } else if (this.noReplyStreak === 2) {
            console.log('[proactive] 触发 checkin（先问还在吗）');
            this.speakProactive('checkin').catch(console.error);
          } else {
            console.log('[proactive] 触发 followup（追问自答）');
            this.speakProactive('followup').catch(console.error);
          }
        } else {
          this.armIdleCheck();
        }
      }, wait);
      return;
    }
    if (this.idleFired) return;
    const nudgeMs = nudgeDelayMs(this.mood, this.lastAffect?.incongruence ?? false);
    const wait = Math.max(0, nudgeMs - (Date.now() - this.lastUserVoiceAt));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.rtc || this.speaking || this.idleFired) return;
      if (Date.now() - this.lastUserVoiceAt >= nudgeMs) {
        this.idleFired = true;
        console.log(`[proactive] 触发 nudge（静默 ${Math.round((Date.now() - this.lastUserVoiceAt) / 1000)}s，情绪延迟 ${nudgeMs}ms）`);
        this.speakProactive('nudge').catch(console.error);
      } else {
        this.armIdleCheck();
      }
    }, wait);
  }

  private clearPendingInterrupt() {
    this.pendingInterrupt = false;
    if (this.interruptGraceTimer !== null) {
      clearTimeout(this.interruptGraceTimer);
      this.interruptGraceTimer = null;
    }
  }

  private doBargeIn(source: 'rtc' | 'asr') {
    console.log(`[RTC] 打断（interrupt，via ${source}）`);
    void this.obs.trace('interrupt', { metadata: { characterId: this.persona.name, source } }, async () => {});
    this.lastBargeInAt = Date.now();
    this.gate.invalidate();
    this.rtc?.clear();
    this.backchannel.reset();
    this.speaking = false;
    this.agentAudible = false;
    this.agentDoneAt = 0;
    this.markUserVoice();
    this.armReanswer();
    this.armIdleCheck();
  }

  private handleBargeIn(source: 'rtc' | 'asr') {
    if (!this.agentAudible) return;
    if (source === 'rtc') {
      if (this.pendingInterrupt) return;
      this.pendingInterrupt = true;
      if (this.interruptGraceTimer !== null) clearTimeout(this.interruptGraceTimer);
      this.interruptGraceTimer = setTimeout(() => {
        this.interruptGraceTimer = null;
        this.pendingInterrupt = false;
        this.doBargeIn('rtc');
      }, INTERRUPT_GRACE_MS);
      return;
    }
    this.clearPendingInterrupt();
    this.doBargeIn('asr');
  }

  private scheduleHangup() {
    if (this.hangupTimer !== null) clearTimeout(this.hangupTimer);
    console.log('[proactive] 说完"不打扰"，10s 后挂断');
    this.hangupTimer = setTimeout(() => {
      this.hangupTimer = null;
      console.log('[proactive] 挂断');
      this.rtc?.sendControl({ type: 'hangup' });
      setTimeout(() => this.rtc?.close(), 500);
    }, 10000);
  }

  private teardownCall(reason: 'hangup' | 'close') {
    const snap = this.history;
    this.history = [];
    if (snap.length > 0) {
      summarizeCall(this.llm, this.cfg.generateModel, snap)
        .then((s) => this.conversationSummaries.save(this.persona.name, this.userId, s))
        .catch((e) => console.warn('[summary] 写最近概要失败：', e));
    }
    this.gate.invalidate();
    this.rtc?.close();
    this.rtc = null;
    this.sed?.close();
    this.speaking = false;
    this.clearReanswer();
    this.lastUserTurn = null;
    this.reanswerCount = 0;
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.vocalTimer !== null) { clearTimeout(this.vocalTimer); this.vocalTimer = null; }
    if (this.hangupTimer !== null) { clearTimeout(this.hangupTimer); this.hangupTimer = null; }
    this.clearPendingInterrupt();
    if (this.currentSessionId) {
      const id = this.currentSessionId;
      this.currentSessionId = null;
      void this.obs.trace('hangup', { metadata: { reason, characterId: this.persona.name } }, async () => {});
      this.obs.setSession(null);
      this.sessions.end(id).catch(() => {});
    }
  }

  private scheduleVocalRespond() {
    if (this.vocalTimer !== null) clearTimeout(this.vocalTimer);
    const now = Date.now();
    const sinceLast = now - this.lastVocalRespondAt;
    let wait: number;
    if (sinceLast < VOCAL_COOLDOWN_MS) {
      wait = VOCAL_COOLDOWN_MS - sinceLast;
    } else {
      wait = VOCAL_DEBOUNCE_MS;
      if (this.pendingVocals.hasAny) {
        wait = Math.min(wait, Math.max(0, VOCAL_MAX_HOLD_MS - (now - this.pendingVocals.firstAtMs)));
      }
    }
    this.vocalTimer = setTimeout(() => {
      this.vocalTimer = null;
      this.triggerVocalRespond();
    }, wait);
  }

  private triggerVocalRespond() {
    if (!this.pendingVocals.hasAny) return;
    this.lastVocalRespondAt = Date.now();
    const vocals = this.pendingVocals.list;
    const dominantVocal = this.pendingVocals.dominant();
    this.pendingVocals.reset();
    this.respond('', vocals, dominantVocal).catch(console.error);
  }

  private clearVocalTimer() {
    if (this.vocalTimer !== null) {
      clearTimeout(this.vocalTimer);
      this.vocalTimer = null;
    }
  }

  private async preloadBackchannelClips(voice: string, name: string): Promise<void> {
    const clips: Uint8Array[] = [];
    for (const phrase of BACKCHANNEL_PHRASES) {
      const parts: Uint8Array[] = [];
      for await (const pcm of streamTTS({
        wsUrl: this.cfg.dashscopeWsUrl,
        apiKey: this.cfg.dashscopeApiKey,
        model: this.cfg.cosyvoiceModel,
        voice,
        instruction: buildInstruction('natural', this.persona.voiceTint) + '。这句要轻声、短促，像随口应一声，不抢话。',
        text: phrase,
        rate: this.persona.rate ?? 1.0,
      })) parts.push(pcm);
      clips.push(concatPcm(parts));
    }
    this.backchannel.setClips(voice, clips);
    console.log(`[backchannel] ${name} 片段就绪（${clips.length} 句）`);
  }

  private playCachedGreeting(voice: string, lang: 'zh' | 'en' = 'zh') {
    if (!this.rtc || this.speaking) return;
    const pick = this.greetingClips.pick(`${voice}:${lang}`);
    if (!pick) return;
    console.log('[greeting] 播放缓存招呼语');
    this.speaking = true;
    this.agentAudible = true;
    this.lastTurnAskedQuestion = false;
    this.rtc.pushAgentPcm(pick.clip);
    this.rtc.end();
    if (pick.phrase) {
      this.rtc?.sendControl({ type: 'transcript', role: 'agent', text: pick.phrase });
      this.transcript.insert(this.persona.name, this.userId, {
        sessionId: this.currentSessionId,
        role: 'agent',
        text: pick.phrase,
        turnIndex: this.turnCount,
        emotion: 'natural',
        frame: this.coachTracker.current,
        asked: isAsking(pick.phrase),
      }).catch((e) => console.warn('[transcript] 招呼语落库失败：', e));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
