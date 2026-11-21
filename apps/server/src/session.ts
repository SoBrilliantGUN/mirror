// ============================================================
// CallSession —— 单通通话编排。生命周期 = 一通电话（每 /rtc/offer 重置状态）。
//
// 职责地图（本文件唯一要背的心智模型）：
//   · 建连        handleOffer —— 建 RTC/ASR/NLS，预热招呼语，回 SDP
//   · 实时接入    onAsrResult —— ASR 流式 → 打断/抢话判定 → respond
//   · 对话回合    respond —— 决策(planTurn) + 召回(recallContext) + 装配 → streamTurnSpeech
//   · 主动发话    turnTaking.armIdleCheck / speakProactive —— 追问/checkin/找话题/道别/教练收尾
//   · 打断/抢话   turnTaking.handleBargeIn / doBargeIn —— 中止生成 + 误打断重答
//   · 非言语发声  turnTaking.scheduleVocalRespond —— 哭/笑去抖后触发一次 respond
//   · 挂断收尾    teardownCall —— 写通话概要 + 结束会话
//
// 已拆出去的（这里只留窄回调，不背实现）：
//   · 主动发话/打断/收尾状态机     → conversationFlow.ts（ConversationFlowController，借 host 回调触发 respond/speakProactive）
//   · 逐句流水线（生成→切句→TTS→搜索）→ speech/speakPipeline.ts（streamTurnSpeech）
//   · TTS 合成 + 多端点重试      → speech/ttsEngine.ts（TtsEngine）
//   · 招呼语片段缓存/落盘         → speech/greetingClips.ts（GreetingClipCache）
//   · 后台记忆/课题/人设巩固      → brain/consolidate/（memoryTurn / goalTurn / selfAddTurn / dream）
//
// 会话级字段分组：
//   · 注入共享资源（不随通话重置）: cfg / llm / safetyLlm / embedder / memory / tts / greetingClips …
//   · 会话状态（每通重置）: tracker / coachTracker / mood / lastAffect / persona / lang / history …
//   · 实时互锁（计时器 + 代际中止）: gate（GenerationGate）/ speaking / agentAudible …（turn-taking 共享状态见 conversationFlow.ts）
// ============================================================
import type {
  AcousticFeatures,
  Affect,
  DependenceSignals,
  GrowthGoalStore,
  IdentityStore,
  MemoryStore,
  MoodState,
  Persona,
  SelfAddedStore,
  TimeAware,
  VocalizationEvent,
} from '@mirror/contracts';
import type { Config } from './config';
import type { LlmClient } from './llm/client';
import type { Embedder } from './llm/embedding';
import type { Obs } from './obs/langfuse';
import type { HistorySummarizer } from './brain/compress';
import type { HistoryEntry } from './brain/context';
import type { PersonaDetail } from './persona/loadPersona';
import type { DominantVocal } from './speech/vocalEvents';
import type { PrefetchCache, RecalledContext } from './brain/assemble';
import type { OfferBody, OfferResult } from './router';
import { createRtcPeer, type RtcCallbacks, type RtcPeer, type RtcIceOptions } from './rtc/webrtc';
import { ParaformerRealtimeASR } from './speech/paraformerRealtime';
import { streamTTS } from './speech/cosyvoiceRealtime';
import { TtsEngine, buildTtsEndpoints, type TtsEndpoint } from './speech/ttsEngine';
import { GreetingClipCache, type GreetingTts } from './speech/greetingClips';
import { AcousticFeatureExtractor } from './speech/acousticFeatures';
import { NlsSoundEventDetector } from './speech/nlsSoundEvent';
import { normalizePersonaName, normalizeUserName } from './speech/nameNormalizer';
import { buildInstruction, tailHint } from './speech/emotionInstruction';
import { BackchannelEngine, BACKCHANNEL_PHRASES, concatPcm, hasVoicePcm } from './speech/backchannel';
import { PERSONAS, resolvePersona, resolvePersonaDetails, resolveVoice } from './persona';
import { createPersonaMatcher } from './persona/loadPersona';
import { streamTurnSpeech } from './speech/speakPipeline';
import { ConversationFlowController, DEFAULT_TIMING, type ConversationFlowTiming, type ConversationFlowHost, type ProactiveKind } from './conversationFlow';
import { ModeTracker } from './brain/modeTracker';
import { CoachTracker } from './brain/coach';
import { planTurn, type TurnPlan } from './brain/turn';
import { evaluateDisinterest, evaluatePerfunctory, isExplicitTopicSwitch } from './brain/topicSwitch';
import { generateProactiveText, extractAwaits } from './brain/generate';
import { recallContext, buildTurnMessages, createPrefetchCache } from './brain/assemble';
import { consolidateAfterTurn } from './brain/consolidate';
import { classifyMemory } from './brain/memoryClassifier';
import { GenerationGate } from './brain/generationGate';
import { correctAsrText } from './brain/asrCorrect';
import { compressHistory } from './brain/compress';
import { summarizeCall, mergeCallSummaries } from './brain/recentSummary';
import { buildProactiveSystemPrompt } from './brain/prompts';
import { buildCuriosityHint } from './brain/ontology';
import { buildGoalFollowUpHint, formatHistory } from './brain/context';
import { neutralAcoustic } from './fallbacks';
import { SafetyGuard } from './brain/safety';
import { CRISIS_RESOURCES } from './brain/crisisResources';
import { createSessionsStore } from './store/sessions';
import { createTranscriptStore, type TurnInsert } from './store/transcript';
import { createAskedQuestionsStore } from './store/askedQuestions';
import { createConversationSummariesStore } from './store/conversationSummaries';
import { analyzeSessionTopics, refreshTopicLibrary } from './brain/topicLibrary';
import { pickCuriosityTopic, latestEventByDimension, type CuriosityPick, type CuriosityResult } from './brain/curiosity';
import type { TopicsStore } from './store/topics';
import type { AskedTopicsStore } from './store/askedTopics';

// 语气词附和（「嗯/哦/啊/好/对/是/唔」及其重复）：抢话语境下判定为附和、不算真实打断。
function isFillerText(text: string): boolean {
  const t = text.replace(/[。，！？!?,\s]/g, '');
  if (!t) return false;
  return /^[嗯哦啊好对是唔]+$/.test(t);
}

// 纯语气词（嗯/哦/啊/呃/唔…）：不含"好/对/是"这种有实义的肯定。独立回合里出现不算真回复。
function isPureInterjection(text: string): boolean {
  const t = text.replace(/[。，！？!?,\s]/g, '');
  if (!t) return false;
  return /^[嗯哦啊呃唔噢]+$/.test(t);
}

// 组装系统提示词尾部：先注入「对方名字」（有则），再按语言追加语言要求（沉浸式 / 纠错教学）。
function buildLanguagePrompt(base: string, lang: 'zh' | 'en', englishMode: 'immersion' | 'coach', userName?: string): string {
  let out = base;
  if (userName) {
    out = `${out}\n\n[对方名字] 对方的名字是「${userName}」。若语音识别把名字听成了同音字或别的写法，一律以「${userName}」为准，别再纠结写法，也别当成昵称或别名。`;
  }
  if (lang !== 'en') return out;
  const mode = englishMode === 'coach'
    ? '用户练英语，若其语法/用词明显有误，请温和自然地顺带点出更地道的表达，但别频繁打断，优先保证对话流畅。'
    : '自然流畅地陪用户用英文聊天即可，不要刻意纠错。';
  return `${out}\n\n[语言要求] 本轮请全程用英文交流（自然、口语化的 English，不要用中文）。用户正在练习英语。${mode}`;
}

// 是否在向用户提问（回退正则：优先用生成阶段顺带输出的 awaits 标签，漏打时用「句子里出现过问号」判断）。
const isAsking = (text: string) => /[？?]/.test(text);

// 额度耗尽等 API 配额类错误：识别出来给用户弹「额度不足」提示，而不是默默卡住。
function isQuotaError(e: unknown): boolean {
  return /429|402|401|limit_requests|quota|insufficient/i.test(String(e));
}

// string[] / AsyncIterable 统一成 AsyncIterator，供逐句流水线预取下一句用。
// 从对方一句话判语言：含中文 → zh；纯英文 → en；无语义字符（嗯/哦/数字/标点）→ null（不切换，保持现状）。
// 说话自动切换语言用，替代原来的中英文开关。
function detectLang(text: string): 'zh' | 'en' | null {
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[A-Za-z]/.test(text)) return 'en';
  return null;
}

const TOPIC_DRIFT_LIMIT = 3; // 连续提问上限（换话题检测，与主动发话计时无关）

export type SessionDeps = {
  cfg: Config;
  llm: LlmClient;
  safetyLlm: LlmClient;
  embedder: Embedder;
  memory: MemoryStore;
  askedQuestions: ReturnType<typeof createAskedQuestionsStore>;
  conversationSummaries: ReturnType<typeof createConversationSummariesStore>;
  selfAdded: SelfAddedStore;
  goals: GrowthGoalStore;
  identity: IdentityStore;
  sessions: ReturnType<typeof createSessionsStore>;
  transcript: ReturnType<typeof createTranscriptStore>;
  topics: TopicsStore;
  askedTopics: AskedTopicsStore;
  obs: Obs;
  timeAware: TimeAware;
  summarizer: HistorySummarizer;
  memoryBudget: number;
  historyBudget: number;
  userId: string;
  // 主动发话 / 打断计时（缺省 DEFAULT_TIMING；测试传小值加速）
  timing?: Partial<ConversationFlowTiming>;
  // 测试注入点（默认用真实实现；测试传 mock 以脱离网络/设备）
  rtcFactory?: (cbs: RtcCallbacks, ice: RtcIceOptions) => RtcPeer;
  asrFactory?: () => ParaformerRealtimeASR;
  ttsFactory?: (endpoints: TtsEndpoint[], pushPcm: (pcm: Uint8Array) => void, onStart: () => void, sleep: (ms: number) => Promise<void>) => TtsEngine;
  greetingClipsFactory?: (tts: GreetingTts) => GreetingClipCache;
};

export class CallSession {
  // —— 注入的共享资源（不随通话重置） ——
  private readonly cfg: Config;
  private readonly llm: LlmClient;
  private readonly safetyLlm: LlmClient;
  private readonly embedder: Embedder;
  private readonly memory: MemoryStore;
  private readonly askedQuestions: SessionDeps['askedQuestions'];
  private readonly conversationSummaries: SessionDeps['conversationSummaries'];
  private readonly selfAdded: SelfAddedStore;
  private readonly goals: GrowthGoalStore;
  private readonly identity: IdentityStore;
  private readonly sessions: SessionDeps['sessions'];
  private readonly transcript: SessionDeps['transcript'];
  private readonly topics: TopicsStore;
  private readonly askedTopics: AskedTopicsStore;
  private readonly obs: Obs;
  private readonly timeAware: TimeAware;
  private readonly summarizer: HistorySummarizer;
  private readonly memoryBudget: number;
  private readonly historyBudget: number;
  private readonly userId: string;
  private readonly timing: ConversationFlowTiming;

  // —— 会话级状态（每通重置） ——
  private tracker = new ModeTracker();
  private coachTracker = new CoachTracker();
  private goalFollowUpDone = false;
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
  private readonly gate = new GenerationGate(); // 代际中止门：哪次生成还作数 + 对应 AbortSignal
  private history: HistoryEntry[] = [];
  private recentSummaryText = '';
  private turnCount = 0;
  private loadedDetails: PersonaDetail[] = [];
  private readonly prefetchCache: PrefetchCache = createPrefetchCache();

  private lastQuestionText = '';
  private lastCuriosityHint = '';
  private disinterestStreak = 0;
  private perfunctoryStreak = 0;
  private consecutiveQuestions = 0;
  private readonly userSaid: string[] = [];
  private prevTurnMemoryIds: string[] = [];
  private recentVoiceAt = 0;
  private lastRawAsrText = ''; // 用户本轮 ASR 原始识别，供 transcript 落三版（raw/名字纠正后/最终）
  private lastCuriosityTrace: { scored: unknown[]; pickedId: string; pickedQuestion: string } | null = null; // 好奇心评分明细，供落库
  private userGender: '男' | '女' | null = null;

  // 主动发话 / 打断 / 收尾状态机（从本类抽出；跨模块共享状态见其 public 字段）
  private readonly turnTaking: ConversationFlowController;

  private readonly backchannel = new BackchannelEngine(
    { silenceMs: 500, cooldownMs: 15000, maxPerTurn: 6, gain: 0.5, minSpeechMs: 30000 },
    (pcm, gain) => this.rtc?.pushAgentPcm(pcm, gain),
  );

  private readonly tts: TtsEngine; // 构造器赋值（依赖 cfg 端点 + rtc 闭包）

  private readonly greetingClips: GreetingClipCache; // 构造器赋值（依赖 cfg）

  // —— 测试注入点（默认实现；测试传 mock） ——
  private readonly rtcFactory: (cbs: RtcCallbacks, ice: RtcIceOptions) => RtcPeer;
  private readonly asrFactory: () => ParaformerRealtimeASR;
  private readonly ttsFactory: (endpoints: TtsEndpoint[], pushPcm: (pcm: Uint8Array) => void, onStart: () => void, sleep: (ms: number) => Promise<void>) => TtsEngine;
  private readonly greetingClipsFactory: (tts: GreetingTts) => GreetingClipCache;

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
    this.identity = deps.identity;
    this.sessions = deps.sessions;
    this.transcript = deps.transcript;
    this.topics = deps.topics;
    this.askedTopics = deps.askedTopics;
    this.obs = deps.obs;
    this.timeAware = deps.timeAware;
    this.summarizer = deps.summarizer;
    this.memoryBudget = deps.memoryBudget;
    this.historyBudget = deps.historyBudget;
    this.userId = deps.userId;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    // 测试注入点：默认用真实实现。
    this.rtcFactory = deps.rtcFactory ?? createRtcPeer;
    this.asrFactory = deps.asrFactory ?? (() => new ParaformerRealtimeASR());
    this.ttsFactory = deps.ttsFactory ?? ((endpoints, pushPcm, onStart, sleep) => new TtsEngine(endpoints, pushPcm, onStart, sleep));
    this.greetingClipsFactory = deps.greetingClipsFactory ?? ((tts) => new GreetingClipCache(tts));
    // safetyGuard 依赖 safetyLlm/cfg，字段初始化在构造器赋值之后再建。
    this.safetyGuard = new SafetyGuard({ llm: this.safetyLlm, model: this.cfg.llm.safetyModel });
    // TTS 合成引擎：把「整句合成 + 多端点重试」委托出去，只留 pushPcm 回调指向当前 RTC。
    this.tts = this.ttsFactory(
      buildTtsEndpoints(this.cfg.speech),
      (pcm) => this.rtc?.pushAgentPcm(pcm),
      () => { this.turnTaking.markAudible(); this.rtc?.sendControl({ type: 'speaking', value: true }); },
      (ms) => this.sleep(ms),
    );
    // 招呼语片段缓存：只管加载/落盘；播放与落库仍在本类。
    this.greetingClips = this.greetingClipsFactory({
      wsUrl: this.cfg.speech.dashscopeWsUrl,
      apiKey: this.cfg.speech.dashscopeApiKey,
      model: this.cfg.speech.cosyvoiceModel,
    });
    // 主动发话 / 打断状态机：借出窄回调，状态机不碰本类的 I/O 细节。
    const self = this;
    const host: ConversationFlowHost = {
      respond: (t, v, d) => self.respond(t, v, d),
      speakProactive: (k) => self.speakProactive(k),
      gate: self.gate,
      get rtc() { return self.rtc; },
      resetBackchannel: () => self.backchannel.reset(),
      obs: self.obs,
      get personaName() { return self.persona.name; },
      coachIsActive: () => self.coachTracker.current === 'coach',
      get mood() { return self.mood; },
      get lastAffect() { return self.lastAffect; },
    };
    this.turnTaking = new ConversationFlowController(host, this.timing);
  }

  get personaName(): string {
    return this.persona.name;
  }

  get isInCall(): boolean {
    return this.rtc !== null;
  }

  // 每通电话开始时的状态复位（单一入口）。新增会话级状态字段时，这里 + turnTaking.reset() 一起改，
  // 避免「新字段漏复位」——之前 handleOffer 里散着一批、turnTaking.reset() 里又一批，容易漂移。
  private resetSessionState(): void {
    this.history = [];
    this.tracker = new ModeTracker();
    this.coachTracker = new CoachTracker();
    this.goalFollowUpDone = false;
    this.turnTaking.reset();
    this.mood = null;
    this.lastAffect = null;
    this.turnCount = 0;
    this.loadedDetails = [];
    this.prefetchCache.clear();
    this.lastQuestionText = '';
    this.userSaid.length = 0;
    this.prevTurnMemoryIds = [];
    this.lastCuriosityHint = '';
    this.recentSummaryText = '';
    this.disinterestStreak = 0;
    this.perfunctoryStreak = 0;
    this.consecutiveQuestions = 0;
    this.userGender = null;
  }

  // 启动即把所有上线人物的招呼语预热成缓存片段，让第一通的第一句话一定是缓存好的（秒回）。
  preloadGreetings(): void {
    for (const p of Object.values(PERSONAS)) {
      if (!p.available) continue;
      const voice = resolveVoice(p.name, this.cfg.speech.cosyvoiceVoice);
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
    if (resolveVoice(this.persona.name, this.cfg.speech.cosyvoiceVoice, this.lang) === this.cfg.speech.cosyvoiceVoice && this.persona.name !== '程书衡') {
      console.warn(`[voice] ${this.persona.name} 尚未配置专属音色，暂用程书衡音色；用 npm run enroll-voices 建模后填 env。`);
    }
    this.setupBackchannel();
    this.sed?.close();
    this.asr = this.asrFactory();
    this.acoustic = new AcousticFeatureExtractor();
    this.resetSessionState();
    this.safetyGuard = new SafetyGuard({ llm: this.safetyLlm, model: this.cfg.llm.safetyModel });
    this.conversationSummaries.recent(this.persona.name, this.userId, 3)
      .then(async (summaries) => {
        if (summaries.length === 0) return;
        this.recentSummaryText = await mergeCallSummaries(this.llm, this.cfg.llm.generateModel, summaries).catch(() => summaries.join('\n'));
      })
      .catch(() => {});

    this.setupNls();

    // 通话会话记录：结束上一通（若有残留），开新一条；失败不阻断建连。
    if (this.currentSessionId) this.sessions.end(this.currentSessionId).catch(() => {});
    this.currentSessionId = await this.sessions.start(this.persona.name, this.userId).catch(() => null);
    this.obs.setSession(this.currentSessionId ? { sessionId: this.currentSessionId, userId: this.userId, personaName: this.persona.name } : null);

    this.rtc = this.rtcFactory(
      {
        onUserPcm: (chunk) => {
          // ASR 和 NLS 始终收——否则陪伴者说话时你抢话，麦克风被门挡住听不见。
          this.asr?.sendAudio(chunk);
          this.sed?.sendPcm(chunk);
          if (this.turnTaking.speaking) return;
          if (hasVoicePcm(chunk)) this.recentVoiceAt = Date.now();
          this.acoustic?.push(chunk);
          this.backchannel.feedPcm(chunk);
        },
        onInterrupt: () => this.turnTaking.handleBargeIn('rtc'),
        onPlaybackEnd: () => {
          this.turnTaking.markAgentDone();
          this.rtc?.sendControl({ type: 'speaking', value: false });
          if (this.turnTaking.consumeFarewell()) {
            this.turnTaking.scheduleHangup();
          }
          this.turnTaking.armIdleCheck();
        },
        onHangup: () => {
          console.log('[RTC] 收到挂断，立刻停');
          this.teardownCall('hangup');
        },
        onClose: () => {
          this.teardownCall('close');
        },
      },
      { portRange: this.cfg.ice.portRange, hostAddress: this.cfg.ice.hostAddress },
    );
    await this.sed?.start();
    try {
      await this.asr.start({
        wsUrl: this.cfg.speech.dashscopeWsUrl,
        apiKey: this.cfg.speech.dashscopeApiKey,
        model: this.cfg.speech.paraformerModel,
        languageHints: ['zh', 'en'],
        onResult: (text, isFinal) => this.onAsrResult(text, isFinal),
      });
    } catch (e) {
      // ASR（语音识别）连不上就别让信令白白 500：回收半成品连接，回一个可读的错误。
      this.rtc?.close();
      this.rtc = null;
      this.sed?.close();
      const detail = (e as Error)?.message ?? String(e);
      const hint = this.cfg.speech.dashscopeApiKey
        ? `（${detail}，请检查 DASHSCOPE_API_KEY / DASHSCOPE_WS_URL 是否有效）`
        : '（未配置 DASHSCOPE_API_KEY，请先在「设置」里填写语音服务 Key）';
      return { error: `语音识别服务连接失败${hint}`, status: 502 };
    }
    const answer = await this.rtc.handleOffer(body.sdp);

    // 一联通就打招呼（异步、不阻塞响应）：优先缓存片段，预热失败回退 LLM 生成。
    const greetVoice = resolveVoice(this.persona.name, this.cfg.speech.cosyvoiceVoice, this.lang);
    this.turnTaking.setIdleFired();
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

  // 副语言 backchannel：复位 + 切音色 + 预生成片段（懒、按音色缓存）。
  private setupBackchannel(): void {
    this.backchannel.reset();
    const backVoice = resolveVoice(this.persona.name, this.cfg.speech.cosyvoiceVoice, this.lang);
    this.backchannel.setVoice(backVoice);
    if (!this.backchannel.hasClips(backVoice)) {
      this.preloadBackchannelClips(backVoice, this.persona.name).catch((e) =>
        console.warn('[backchannel] 片段预生成失败：', e),
      );
    }
  }

  // 哭/笑检测（NLS 云端）：收 PCM、出事件。连不上/未配凭证时 onEvent 不被调用，主链路照常。
  private setupNls(): void {
    const hasToken = Boolean(this.cfg.nls.token);
    const hasAk = Boolean(this.cfg.nls.akId && this.cfg.nls.akSecret);
    if (this.cfg.nls.enabled && this.cfg.nls.appKey && (hasToken || hasAk)) {
      this.sed = new NlsSoundEventDetector(
        {
          appKey: this.cfg.nls.appKey,
          token: this.cfg.nls.token || undefined,
          akId: this.cfg.nls.akId || undefined,
          akSecret: this.cfg.nls.akSecret || undefined,
        },
        (ev) => {
          this.turnTaking.recordVocal(ev);
          console.log('[NLS] 非言语发声：', JSON.stringify(ev), '主导：', this.turnTaking.dominantVocal);
          this.turnTaking.scheduleVocalRespond();
        },
      );
    } else if (!this.cfg.nls.enabled) {
      this.sed = null;
      console.warn('[NLS] 已通过 NLS_ENABLED=false 关闭哭/笑检测');
    } else {
      this.sed = null;
      console.warn('[NLS] 未配 NLS 凭证（NLS_APPKEY + NLS_TOKEN 或 NLS_ACCESS_KEY_ID/SECRET），哭/笑检测关闭');
    }
  }

  private onAsrResult(text: string, isFinal: boolean): void {
    console.log('[ASR] 结果：', JSON.stringify({ text, isFinal }));
    const t = text.trim();
    if (t && isFillerText(t) && this.turnTaking.handleFillerText(isFinal)) {
      return;
    }
    if (this.turnTaking.agentAudible) {
      if (t.length >= 2 || (isFinal && t)) this.turnTaking.handleBargeIn('asr');
      else return;
    }
    if (isFinal && Date.now() - this.recentVoiceAt > 3000) return; // 幻听门控
    if (t) {
      this.recentVoiceAt = Date.now();
      if (this.turnTaking.speaking) {
        this.gate.invalidate();
        this.turnTaking.stopSpeaking();
      }
      // 独立回合里的纯语气词（嗯/哦/啊）不算真回复：刷新「用户还在」，但不重置「上一句在等回应」，
      // 交给 followup 继续上一话题，别送进模型被误判成「没兴趣、换话题」。
      if (isFinal && isPureInterjection(t)) {
        this.turnTaking.markUserPresence();
        return;
      }
      this.turnTaking.markUserVoice();
    }
    if (isFinal) {
      if (t) {
        const cleanText = normalizeUserName(normalizePersonaName(t, this.persona.name), this.cfg.userName);
        // 说话自动切语言：含中文回 zh、纯英文切 en，无语义字符（嗯/哦）保持不变。
        const detected = detectLang(cleanText);
        if (detected && detected !== this.lang) {
          this.lang = detected;
          console.log(`[lang] 根据对方说话自动切到：${this.lang}`);
        }
        const { vocals, dominantVocal } = this.turnTaking.drainVocals();
        this.turnTaking.clearVocalTimer();
        this.backchannel.onTurnEnd();
        this.turnTaking.captureTurn(cleanText, vocals, dominantVocal);
        this.lastRawAsrText = t; // 记 ASR 原文，供 transcript 落三版
        this.respond(cleanText, vocals, dominantVocal).catch(console.error);
      }
    } else if (t) {
      this.turnTaking.clearReanswer();
      this.backchannel.onInterim();
    }
  }

  private async respond(userText: string, vocals: VocalizationEvent[] = [], dominantVocal: DominantVocal = null) {
    if (!this.rtc) return;
    const tStart = Date.now();
    const { gen: myGen, signal } = this.gate.begin();
    this.turnTaking.beginTurn();
    // 决策 → 召回 → 装配 → 出句 → 记结果 全在 runTurnPipeline；这里只留门牌 + 观测外壳。
    await this.obs.trace('turn', {
      metadata: { kind: 'respond', personaName: this.persona.name, turnIndex: this.turnCount, dominantVocal },
      input: { text: userText, vocals, dominantVocal },
    }, () => this.runTurnPipeline(myGen, signal, tStart, userText, vocals, dominantVocal));
  }

  // respond 的主线：决策 → 出句 → 记结果。由 respond 的 obs.trace 包住；内部 try/finally 负责「半路被打断」收尾。
  private async runTurnPipeline(
    myGen: number,
    signal: AbortSignal,
    tStart: number,
    userText: string,
    vocals: VocalizationEvent[],
    dominantVocal: DominantVocal,
  ): Promise<void> {
    const searchEnabled = Boolean(this.cfg.search.bochaApiKey);
    let reachedEnd = false;
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
      personaName: this.persona.name,
      memoryBudget: this.memoryBudget,
      compress: (entries: HistoryEntry[]) => compressHistory(entries, this.historyBudget, this.summarizer),
      timeAware: this.timeAware,
      selfAdded: this.selfAdded,
      goals: this.goals,
      identity: this.identity,
      personaMatch: this.personaMatcher ?? undefined,
      prefetchCache: this.prefetchCache,
    };
    const dependenceSignals: DependenceSignals = this.currentSessionId
      ? await this.sessions.signals(this.persona.name, this.userId, this.currentSessionId).catch(() => ({ recentCalls7d: 0, currentCallMinutes: 0, lastGapMinutes: null }))
      : { recentCalls7d: 0, currentCallMinutes: 0, lastGapMinutes: null };
    // 纠错与决策/召回并行（不额外吃首字延迟）；纠错结果只喂给装配与落库，打分/召回仍用原文——情绪与
    // 向量召回对同音错字不敏感，但模型读到的正文、以及后台写进记忆的正文，必须是纠正后的。
    const [plan, ctx, recentAsked, corrected] = await Promise.all([
      this.obs.span('decision', () => planTurn(
        { llm: this.llm, scoreModel: this.cfg.llm.scoreModel, generateModel: this.cfg.llm.generateModel, safetyGuard: this.safetyGuard, tracker: this.tracker, coachTracker: this.coachTracker, mood: this.mood },
        { text: userText, acoustic: acoustics, vocalizations: vocals, dominantVocal, persona: this.persona, dependenceSignals },
      )),
      this.obs.span('recall', () => recallContext(assembleDeps, { text: userText, history: this.history, loadedDetails: this.loadedDetails })),
      this.askedQuestions.recent(this.persona.name, this.userId, 3),
      this.obs.span('asr-correct', () => correctAsrText(this.llm, this.cfg.llm.generateModel, userText, formatHistory(this.history.slice(-6)), { personaName: this.persona.name, userName: this.cfg.userName || undefined })),
    ]);
    if (!this.gate.isCurrent(myGen)) return;
    // 用户消息只显示最终版：正文纠错完成后立即推给前端（不再先显示 ASR 原文再替换）。
    this.rtc?.sendControl({ type: 'transcript', role: 'user', text: corrected });
    this.mood = plan.mood;
    this.lastAffect = plan.affect;
    const disinterest = evaluateDisinterest(plan.affect.arousal, this.turnTaking.replyLatencyMs, this.disinterestStreak);
    this.disinterestStreak = disinterest.streak;
    const perfunctory = evaluatePerfunctory(userText, this.perfunctoryStreak);
    this.perfunctoryStreak = perfunctory.streak;
    const topicDrift = this.consecutiveQuestions >= TOPIC_DRIFT_LIMIT;
    const switchTopic = plan.frame !== 'coach' && (disinterest.switchTopic || perfunctory.switchTopic || topicDrift || isExplicitTopicSwitch(userText));
    if (switchTopic) {
      this.disinterestStreak = 0;
      this.perfunctoryStreak = 0;
      this.consecutiveQuestions = 0;
    }
    // 换话题时用好奇心机制挑一个具体推荐话题（加权随机选维度 → 维度下随机选未回答话题）。
    let recommendedTopic = '';
    if (switchTopic) {
      const pick = await this.pickRecommendedTopic();
      if (pick) {
        recommendedTopic = `「${pick.question}」`;
        this.lastCuriosityTrace = { scored: pick.scored, pickedId: pick.id, pickedQuestion: pick.question };
        void this.askedTopics.record(this.persona.name, this.userId, pick.id).catch(() => {});
      }
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
      // 决策信号（mode/stance/frame/emotion/mood/affect/safetyAction/dependence/farewell/coachInvite/celebrate）
      // 直接展开 plan，不再逐字段手抄 11 个；plan.coachCue 是观测用、装配器不读，随展开丢弃无妨。
      ...plan,
      text: corrected,
      goalFollowUp,
      turnCount: ++this.turnCount,
      userGender: this.userGender,
      switchTopic,
      personaSystemPrompt: buildLanguagePrompt(this.persona.systemPrompt, this.lang, this.englishMode, this.cfg.userName),
      vocalizations: vocals,
      lastAskedQuestion: this.lastQuestionText,
      userSaid: [...this.userSaid],
      recentAsked,
      recentSummary: this.recentSummaryText,
      curiosityHint,
      recommendedTopic,
      searchEnabled,
    });

    const voice = resolveVoice(this.persona.name, this.cfg.speech.cosyvoiceVoice, this.lang);
    const { fullText, awaitsResponse, firstTokenMs } = await streamTurnSpeech({
      llm: this.llm,
      generateModel: this.cfg.llm.generateModel,
      messages,
      baseEmotion: plan.emotion,
      voice,
      voiceTint: this.persona.voiceTint,
      rate: this.persona.rate ?? 1.0,
      cosyvoiceModel: this.cfg.speech.cosyvoiceModel,
      dashscopeWsUrl: this.cfg.speech.dashscopeWsUrl,
      dashscopeApiKey: this.cfg.speech.dashscopeApiKey,
      bochaApiKey: this.cfg.search.bochaApiKey,
      bochaBaseUrl: this.cfg.search.bochaBaseUrl,
      searchEnabled,
      gate: this.gate,
      gen: myGen,
      signal,
      tts: this.tts,
      pushAgentPcm: (pcm) => this.rtc?.pushAgentPcm(pcm),
      pushTranscript: (text) => this.rtc?.sendControl({ type: 'transcript', role: 'agent', text }),
      sleep: (ms) => this.sleep(ms),
      tStart,
      obs: this.obs,
    });
    if (this.gate.isCurrent(myGen)) {
      reachedEnd = true;
      this.recordTurnOutcome({ plan, ctx, userText: corrected, rawText: this.lastRawAsrText, nameCorrected: userText, fullText, acoustics, vocals, awaitsResponse, firstTokenMs });
    }
    } catch (e) {
      if (isQuotaError(e)) {
        console.warn('[respond] 服务额度不足：', e);
        this.rtc?.sendControl({ type: 'notice', text: '服务额度不足，请检查 API key 余额后重试' });
      } else {
        console.warn('[respond] 出句失败：', e);
      }
    } finally {
      this.cleanupInterrupted(myGen, reachedEnd);
    }
  }

  private async speakProactive(kind: ProactiveKind) {
    if (!this.rtc || this.turnTaking.speaking) return;
    const { gen: myGen, signal } = this.gate.begin();
    this.turnTaking.beginTurn();
    let reachedEnd = false;
    console.log('[proactive] 开始：', kind);
    await this.obs.trace('proactive', {
      metadata: { kind, personaName: this.persona.name },
      input: { kind },
    }, async () => {
    try {
      let topicLibrary = '';
      let recommendedTopic = '';
      if (kind === 'nudge' && this.coachTracker.current === 'friend') {
        const lib = await this.topics.listLibrary(this.persona.name, this.userId, 5).catch(() => []);
        if (lib.length > 0) topicLibrary = lib.map((e) => `-「${e.topic}」：${e.summary}`).join('\n');
        const pick = await this.pickRecommendedTopic();
        if (pick) {
          recommendedTopic = `「${pick.question}」`;
          this.lastCuriosityTrace = { scored: pick.scored, pickedId: pick.id, pickedQuestion: pick.question };
          void this.askedTopics.record(this.persona.name, this.userId, pick.id).catch(() => {});
        }
      }
      const system = buildProactiveSystemPrompt(
        kind,
        buildLanguagePrompt(this.persona.systemPrompt, this.lang, this.englishMode, this.cfg.userName),
        {
          lastQuestion: this.lastQuestionText,
          curiosityHint: kind === 'nudge' && this.coachTracker.current === 'friend' ? this.lastCuriosityHint || undefined : undefined,
          recentTurns: formatHistory(this.history.slice(-6)),
          mood: this.mood,
          topicLibrary,
          recommendedTopic,
        },
      );
      const text = await generateProactiveText(this.llm, this.cfg.llm.generateModel, system);
      if (!this.gate.isCurrent(myGen)) return;
      const { clean: seg, awaits } = extractAwaits(text.trim());
      if (!seg) return;
      console.log('[proactive] 文本：', seg);
      this.obs.setOutput(seg);
      await this.obs.span('tts', () => this.tts.synthesize({
        model: this.cfg.speech.cosyvoiceModel,
        voice: resolveVoice(this.persona.name, this.cfg.speech.cosyvoiceVoice, this.lang),
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
        this.turnTaking.markAsked(asked);
        if (asked) this.lastQuestionText = seg; else this.lastQuestionText = '';
        if (kind === 'farewell' || kind === 'coachClose') this.turnTaking.markFarewell(true);
        this.recordTranscript('agent', seg, {
          emotion: 'natural',
          frame: this.coachTracker.current,
          asked,
        });
      }
    } catch (e) {
      console.warn('[proactive] 主动发话失败：', e);
    } finally {
      this.cleanupInterrupted(myGen, reachedEnd);
    }
    });
  }

  private teardownCall(reason: 'hangup' | 'close') {
    const snap = this.history;
    this.history = [];
    if (snap.length > 0) {
      summarizeCall(this.llm, this.cfg.llm.generateModel, snap)
        .then((s) => this.conversationSummaries.save(this.persona.name, this.userId, s))
        .catch((e) => console.warn('[summary] 写最近概要失败：', e));
    }
    this.gate.invalidate();
    this.rtc?.close();
    this.rtc = null;
    this.sed?.close();
    this.turnTaking.teardown();
    // 话题分析（后台 fire-and-forget）：抽本通聊过的自由主题 + 深入度，攒到感兴趣再去搜网存备用话题库。
    const topicTurns = snap.filter((h) => h.kind === 'turn').map((h) => ({ role: h.role, text: h.text }));
    if (topicTurns.some((t) => t.role === 'user')) {
      const topicPersona = this.persona.name;
      const topicUserId = this.userId;
      const topicSessionId = this.currentSessionId;
      void (async () => {
        const n = await analyzeSessionTopics({ llm: this.llm, model: this.cfg.llm.generateModel, topics: this.topics, turns: topicTurns, personaName: topicPersona, userId: topicUserId, sessionId: topicSessionId });
        if (n > 0) await refreshTopicLibrary({ llm: this.llm, model: this.cfg.llm.generateModel, topics: this.topics, searchApiKey: this.cfg.search.bochaApiKey, searchBaseUrl: this.cfg.search.bochaBaseUrl, personaName: topicPersona, userId: topicUserId });
      })().catch((e) => console.warn('[topic] 话题分析失败：', e));
    }
    if (this.currentSessionId) {
      const id = this.currentSessionId;
      this.currentSessionId = null;
      void this.obs.trace('hangup', { metadata: { reason, personaName: this.persona.name } }, async () => {});
      this.obs.setSession(null);
      this.sessions.end(id).catch(() => {});
    }
  }

  private async preloadBackchannelClips(voice: string, name: string): Promise<void> {
    const clips: Uint8Array[] = [];
    for (const phrase of BACKCHANNEL_PHRASES) {
      const parts: Uint8Array[] = [];
      for await (const pcm of streamTTS({
        wsUrl: this.cfg.speech.dashscopeWsUrl,
        apiKey: this.cfg.speech.dashscopeApiKey,
        model: this.cfg.speech.cosyvoiceModel,
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
    if (!this.rtc || this.turnTaking.speaking) return;
    const pick = this.greetingClips.pick(`${voice}:${lang}`);
    if (!pick) return;
    console.log('[greeting] 播放缓存招呼语');
    this.turnTaking.beginTurn();
    this.turnTaking.markAudible();
    this.rtc?.sendControl({ type: 'speaking', value: true });
    this.turnTaking.markAsked(false);
    this.rtc.pushAgentPcm(pick.clip);
    this.rtc.end();
    if (pick.phrase) {
      this.rtc?.sendControl({ type: 'transcript', role: 'agent', text: pick.phrase });
      this.recordTranscript('agent', pick.phrase, {
        emotion: 'natural',
        frame: this.coachTracker.current,
        asked: isAsking(pick.phrase),
      });
    }
  }

  // 一轮没跑到 clean end（出错 / 半路被打断）时的收尾：代际仍当前才复位说话状态 + 重新武装静默计时。
  // respond 与 speakProactive 的 finally 共用，避免两处手写同样的几行。
  private cleanupInterrupted(myGen: number, reachedEnd: boolean): void {
    if (this.gate.isCurrent(myGen) && !reachedEnd) {
      this.turnTaking.stopSpeaking();
      this.rtc?.sendControl({ type: 'speaking', value: false });
      this.turnTaking.touchUserVoice();
      this.turnTaking.armIdleCheck();
    }
  }

  // 一轮成功出句后的收尾：写历史 + 写 transcript（用户/陪伴者）+ asked 记账 + farewell 标记 + 派发后台巩固。
  // 从 respond() 抽出，让 respond 只留「决策 → 装配 → 出句」的主线。
  private recordTurnOutcome(opts: {
    plan: TurnPlan;
    ctx: RecalledContext;
    userText: string;
    rawText: string;
    nameCorrected: string;
    fullText: string;
    acoustics: AcousticFeatures;
    vocals: VocalizationEvent[];
    awaitsResponse: boolean | null;
    firstTokenMs: number;
  }): void {
    const { plan, ctx, userText, rawText, nameCorrected, fullText, acoustics, vocals, awaitsResponse, firstTokenMs } = opts;
    this.turnTaking.clearCapturedTurn();
    this.history.push({ kind: 'turn', role: 'user', text: userText });
    const agentText = fullText.trim();
    if (agentText) this.history.push({ kind: 'turn', role: 'agent', text: agentText });
    this.rtc?.end();
    this.obs.setOutput(agentText);
    const asked = awaitsResponse !== null ? awaitsResponse : isAsking(agentText);
    this.recordTranscript('user', userText, {
      rawText,
      nameCorrected,
      affect: plan.affect,
      acoustic: acoustics,
      vocals: vocals.length ? vocals : undefined,
      latencyMs: this.turnTaking.replyLatencyMs || null,
    });
    if (agentText) {
      this.recordTranscript('agent', agentText, {
        emotion: plan.emotion,
        curiosity: this.lastCuriosityTrace,
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
      });
    }
    this.lastCuriosityTrace = null; // 记录完清空
    this.turnTaking.markAsked(asked);
    this.lastQuestionText = asked ? agentText : '';
    if (asked && agentText) this.askedQuestions.record(this.persona.name, this.userId, agentText).catch(() => {});
    if (asked) this.consecutiveQuestions++; else this.consecutiveQuestions = 0;
    if (plan.farewell) {
      this.turnTaking.markAsked(false);
      this.turnTaking.markFarewell(true);
      this.turnTaking.setIdleFired();
    }

    consolidateAfterTurn({
      llm: this.llm,
      model: this.cfg.llm.generateModel,
      memory: this.memory,
      goals: this.goals,
      selfAdded: this.selfAdded,
      embedder: this.embedder,
      classify: (raw) => classifyMemory(this.llm, this.cfg.llm.generateModel, raw),
      userId: this.userId,
      personaName: this.persona.name,
      userText,
      agentText,
      personaSystemPrompt: this.persona.systemPrompt,
      frame: plan.frame,
      prefetchCache: this.prefetchCache,
      retractIds: this.prevTurnMemoryIds,
    })
      .then((res) => {
        this.prevTurnMemoryIds = res.writtenIds;
        for (const f of res.facts) this.userSaid.push(f);
        // 记忆写好了，通知前端刷新笔记本（事件驱动，替代轮询）。
        this.rtc?.sendControl({ type: 'memory' });
      })
      .catch((e) => console.warn('[memory] 后台写记忆失败：', e));
  }

  // 逐轮聊天记录落库（fire-and-forget）。用户话/陪伴者话/主动发话/招呼语四处共用，
  // 之前各写一份近乎相同的 insert 样板；收敛到这一处，sessionId/role/text/turnIndex 由这里统一填。
  private recordTranscript(role: 'user' | 'agent', text: string, extra: Omit<TurnInsert, 'sessionId' | 'role' | 'text' | 'turnIndex'> = {}): void {
    this.transcript.insert(this.persona.name, this.userId, {
      sessionId: this.currentSessionId,
      role,
      text,
      turnIndex: this.turnCount,
      ...extra,
    }).catch((e) => console.warn(`[transcript] ${role === 'user' ? '用户' : '陪伴者'}话落库失败：`, e));
  }

  // 好奇心机制：三个值相加 → 加权随机选维度 → 维度下随机选未回答话题。
  private async pickRecommendedTopic(): Promise<CuriosityResult | null> {
    try {
      const [coverage, engagement, anchored, askedIds] = await Promise.all([
        this.memory.getCoverage(this.persona.name, this.userId),
        this.topics.dimensionEngagement(this.persona.name, this.userId),
        this.memory.listAnchored(this.persona.name, this.userId),
        this.askedTopics.listAsked(this.persona.name, this.userId),
      ]);
      return pickCuriosityTopic({ coverage, engagement, latestEventAt: latestEventByDimension(anchored), askedIds });
    } catch (e) {
      console.warn('[curiosity] 选话题失败：', e);
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
