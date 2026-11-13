// ============================================================
// 共享类型 + 接口契约 —— 「缝」的物理位置。
// client 和 server 都只依赖这里，不依赖对方内部实现。
// 未来记忆 / MBTI / 时间各自实现下面的接口，L3 大脑一行不改。
// ============================================================

// —— call1 打分输出 ——
export type Affect = {
  valence: number;        // -2..+2：痛苦/厌恶 → 愉悦
  arousal: number;        // -2..+2：麻木/疲惫 → 激动/崩溃
  dominance: number;      // -2..+2：无力/被压着 → 掌控/主动
  incongruence: boolean;  // 文字平静 + 声音异常 = 逞强
};

export type Mode = 'casual' | 'careful';
export type Stance = 'guide' | 'accompany';   // 由支配度驱动：低支配 → 只陪不抛清单

// —— 交互框架（与 Mode 正交）：friend = 陪伴/映照，coach = GROW 成长引导。 ——
export type Frame = 'friend' | 'coach';

// —— 教练意图检测（每轮 LLM 判定，仿 farewell）：两个触发 + 一个退出 + 可选课题主题。 ——
export type CoachCue = {
  explicit: boolean;      // 用户明说求助/要指引（"我该怎么办""我到底想要什么""好迷茫"）→ 立即进教练
  invite: boolean;        // 这轮有反复的成长卡点信号（反复说累/纠结/走不出来）→ 累计后温柔邀入
  resolved: boolean;      // 这轮明确表示课题做成了/解决了/放下了 → 教练态退出回朋友（收口）
  theme: string | null;   // 若可辨，本轮卡在什么事上的短词组（供邀入/命名课题）；看不出为 null
};

// —— 表达「陪伴者此刻情绪」的标签（喂给 TTS）——
// 4 个方向，由对方情绪驱动（通用镜像），再叠加人设底色 voiceTint。
export type EmotionTag = 'warm' | 'tender' | 'steady' | 'natural';

export type VoiceConfig = {
  speed: number;      // 语速倍率 0.7~1.1
  energy: number;     // 能量/响度 0.7~1.1
  pauseMore: boolean; // careful 模式句间停顿更长
};

export type SafetyAction = {
  level: 0 | 1 | 2;          // 0 无 / 1 黄旗（被动意念·持续低落）/ 2 红旗（计划·手段·即时危险）
  action: 'none' | 'refer';  // 已按 episode 去抖：首次或升级时 refer，episode 内为 none
};

// 过度依赖（非危机）：level 0 无 / 1 轻依赖 / 2 强依赖；action boundary = 话术层温柔设界。
export type DependenceAction = {
  level: 0 | 1 | 2;
  action: 'none' | 'boundary';
};

// SafetyGuard.check 的完整返回：危机 + 依赖 两路并行判定，互不污染。
export type SafetyCheck = {
  crisis: SafetyAction;
  dependence: DependenceAction;
};

// 过度依赖的行为信号（来自 L5 通话会话记录，纯确定性，非 LLM）。
export type DependenceSignals = {
  recentCalls7d: number;          // 近 7 天通话次数（含本次）
  currentCallMinutes: number;     // 本次通话已持续分钟数
  lastGapMinutes: number | null;  // 距上一通结束的间隔分钟；null = 没有上一通
};

// —— L3 对外接口返回值 ——
export type TurnResult = {
  affect: Affect;
  mode: Mode;
  stance: Stance;
  emotion: EmotionTag;      // 本轮回应情绪（由对方情绪驱动）
  segmentEmotions?: EmotionTag[]; // 逐句情绪（B2：与 segments 等长，生成后分类；缺省回退 emotion）
  voiceConfig: VoiceConfig;
  segments: string[];       // 已按句切分
  safetyAction: SafetyAction;      // 危机（自伤/轻生）
  dependence: DependenceAction;    // 过度依赖（话术层设界，不转介）
  frame?: Frame;            // 本轮交互框架（friend/coach，教练改造后新增；缺省回退 friend）
};

// —— 副语言（L0 上行，喂给 call1 打分）——
export type AcousticFeatures = {
  rateZ: number;      // 语速 z-score（正 = 偏快）
  pitchZ: number;     // 音高 z-score
  loudnessZ: number;  // 响度 z-score
  pauseZ: number;     // 停顿 z-score（正 = 停顿多）
};

// —— 心境（L5）：mood = affect 的多轮 EMA ——
export type MoodState = {
  valence: number;
  arousal: number;
  dominance: number;
  recent: Affect[];   // 最近几个 affect 点，用于打分连贯 + 轨迹
};

// —— 上下文（ContextProvider 注入，第一片返回空）——
export type HistoryTurn = {
  role: 'user' | 'agent';
  text: string;
};

export type Context = {
  history: HistoryTurn[];      // 最近 N 轮
  mood: MoodState | null;      // 心境轨迹
  // 未来：记忆 / MBTI / 时间各自往这里注入
};

// —— 角色卡（L6）——
export type Persona = {
  name: string;
  mbti: string;          // 内部用，绝不对用户展示
  gender: '男' | '女';
  voiceId: string;       // 音色：区分「加载的是谁」
  voiceTint: string;     // 人设底色：这个陪伴者表达情绪时的语气修饰（来自角色卡）
  available: boolean;    // 是否已上线（未上线者前端置灰 + 服务端 resolvePersona 拒绝）
  rate?: number;         // 语速基线（1.0=正常），人设差异：强势型 ESTJ 可 1.1~1.15，温柔型可 <1.0
  systemPrompt: string;  // 角色卡底座（generate 的 ⑥人物块）
};

// —— 接口（缝）。第一片：stub / 空实现；未来各自填。 ——
export interface ContextProvider {
  get(userId: string): Promise<Context>;
}

export interface SafetyGuard {
  check(text: string, signals?: DependenceSignals): Promise<SafetyCheck>;
}

// —— 长期记忆（五型，参考 kima 的 CopilotMemory 分类；embedding + pgvector 混合召回）——
// constraint = 硬规则/红线（无条件在场）；fact = 稳定事实（entity_id 覆盖）；
// preference = 偏好/软规则；episodic = 带时间锚点的事件（默认 30 天衰减）；
// insight = 反思沉淀的高层洞察（情绪模式/成长/关系/课题，强制在场，单独成型）。
export type MemoryKind = 'constraint' | 'fact' | 'preference' | 'episodic' | 'insight';

export type Memory = {
  id: string;
  userId: string;
  characterId: string;
  kind: MemoryKind;
  content: string;
  entityId: string | null;
  dimension: string | null; // 好奇心维度（原生家庭/职业/…）；constraint/insight 为 null
  aspect: string | null;    // 维度下的子槽（如原生家庭→母亲）；没有则为 null
  anchor?: TimeAnchor;      // 时间锚点（绝对/周期）；无时间含义的记忆为 undefined
  accessCount: number;
  lastAccess: string | null;
  superseded: boolean;
  version: number;
  createdAt: string;
};

// 好奇心覆盖率的一行：某维度下某子槽的已知事实数（aspect 为 null = 只归了维度、没归子槽）。
export type CoverageEntry = { dimension: string; aspect: string | null; count: number };

// 分路召回结果：constraint + insight 硬召回全量（强制在场）；其余三型走混合召回（按相似度过滤）。
export type RecalledMemories = {
  constraint: Memory[];
  insight: Memory[];
  fact: Memory[];
  preference: Memory[];
  episodic: Memory[];
};

export interface MemoryStore {
  // 每个方法的第一个参数 characterId = 当前陪伴者（persona.name），按人物隔离用户画像：
  // 程书衡不会读到只告诉沈知遥的事。见 store/memory.ts。
  // 混合召回：constraint 全量 + fact/preference/episodic 语义检索（供每轮 L2 注入）。
  recall(characterId: string, userId: string, query: string): Promise<RecalledMemories>;
  // 语义检索（recall_memory 工具按需读）。
  search(characterId: string, userId: string, query: string, kind?: MemoryKind, topK?: number): Promise<Memory[]>;
  // 写入一条记忆（fact 同 entity_id 覆盖旧条、旧条留痕 superseded）；anchor 为可选时间锚点。
  write(characterId: string, userId: string, input: { kind: MemoryKind; content: string; entityId?: string | null; dimension?: string | null; aspect?: string | null; anchor?: TimeAnchor | null }): Promise<Memory>;
  // 好奇心覆盖率：按 dimension + aspect 数活跃事实（缺口检测用）。
  getCoverage(characterId: string, userId: string): Promise<CoverageEntry[]>;
  // 全量列出某型活跃记忆（只读面板 / 调试用）。
  listActive(characterId: string, userId: string, kind: MemoryKind): Promise<Memory[]>;
  // 全量列出带时间锚点的活跃记忆（时间感知 upcomingDates 用；数量小，周期评估放 TS 侧）。
  listAnchored(characterId: string, userId: string): Promise<Memory[]>;
  // 撤销错误记忆：对方纠正了之前听错/记错的事实，把含关键词的活跃 fact/preference/episodic 归档（superseded）。返回归档条数。
  retract(characterId: string, userId: string, keyword: string): Promise<number>;
  // 按 id 精确撤销一条活跃记忆（superseded）——纠正「上一轮刚写入」的记忆时用，不做关键词模糊匹配。返回归档条数。
  retractById(characterId: string, userId: string, id: string): Promise<number>;
  // 上限裁剪：某型活跃记忆超过 keep 条时，把最旧的归档（superseded，不硬删）。返回归档条数。
  prune(characterId: string, userId: string, kind: MemoryKind, keep: number): Promise<number>;
}

// —— 时间锚点（L5 时间感知）：记忆里的时间只能是绝对或周期，禁止相对（今天/明天/下周三）。 ——
export type PeriodicRule =
  | { type: 'yearly'; month: number; day: number }        // 生日/纪念日：每年 3 月 15 日
  | { type: 'monthly'; day: number }                      // 每月 15 号
  | { type: 'weekly'; weekday: number; time?: string }    // 每周五（1=周一…7=周日，+ 可选时刻）
  | { type: 'lunar'; month: number; day: number };        // 农历八月十五（预留，V0 不实现）

export type TimeAnchor =
  | { kind: 'absolute'; at: string }        // 一次性：'2026-11-12'（忌日、某次重大事件）
  | { kind: 'periodic'; rule: PeriodicRule };  // 周期：每年/每月/每周

// —— 当前时间上下文（A 时间上下文注入，纯函数产出） ——
export type TimeContext = {
  now: string;          // ISO，便于 judge 对齐
  hour: number;         // 0–23
  minute: number;
  weekday: number;      // 1–7（1=周一）
  isWeekend: boolean;
  isWorkday: boolean;   // 是否工作日（调休补班=工作日，法定假日=非工作日）
  isHoliday: boolean;   // 是否法定节假日（放假）
  holidayName?: string; // 节日名（如"国庆节"），仅 isHoliday 时有
  month: number;
  day: number;
  season: '春' | '夏' | '秋' | '冬';
  period: '凌晨' | '上午' | '下午' | '傍晚' | '晚上' | '深夜';
};

// —— 临近/当天命中的重要日期（B 重要日期记忆） ——
export type UpcomingDate = {
  anchor: TimeAnchor;
  memory: Memory;       // 携带该锚点的记忆（生日是哪条）
  relation: string;     // 从 content 里取的「是什么日子」，如 "生日" / "忌日"
  inDays: number;       // 距今天数：0=今天，1=明天，≤windowDays=本周内
};

// 时间感知接口：三层都只在通话内被动体现（不推送、不调度）。
export interface TimeAware {
  // A：当前时间上下文（纯函数，可单测）。
  currentTimeContext(now: Date): TimeContext;
  // B：临近/当天命中的时间锚点（窗口默认 7 天，含当天）。无则空数组。
  upcomingDates(characterId: string, userId: string, now: Date, windowDays?: number): Promise<UpcomingDate[]>;
  // C：作息关怀软信号——深夜/凌晨 + 记忆里对方有「晚睡/加班」痕迹时给一句候选，否则空串。
  scheduleCareHint(now: Date, recalled: RecalledMemories): string;
}

// ============================================================
// 成长课题（Life Coach 的「重骨架」）：GROW 四段 + 生命周期，跨通话持久。
// 轻的表达 = 只在 [GOAL] 块把进度喂给模型，模型用自己的语气化进对话，绝不念档案。
// ============================================================

export type GrowthStage = 'goal' | 'reality' | 'options' | 'will' | 'done';

export type GrowthGoal = {
  id: string;
  userId: string;
  characterId: string;
  title: string;            // 课题名（如「和妈妈的边界」）
  goal: string | null;      // G：她想要的未来
  reality: string | null;   // R：现状/障碍
  options: string | null;   // O：可选路径（模型自然组织）
  will: string | null;      // W：最小下一步 + 时间（承诺）
  stage: GrowthStage;       // GROW 当前推进到哪一步
  progressNote: string | null; // 最近一次回顾的进展（轻表达素材）
  status: 'active' | 'done' | 'archived';
  lastReviewedAt: string | null; // 上次被回顾/追问的时间（问责节奏）；null = 从未
  createdAt: string;
  updatedAt: string;
};

export interface GrowthGoalStore {
  // 列出进行中的课题（status = active），供 [GOAL] 块注入；按 updated_at 升序。
  listActive(characterId: string, userId: string): Promise<GrowthGoal[]>;
  // 新建一条课题（重复 title 时复用已有活跃条）。返回最终那条。
  create(characterId: string, userId: string, input: { title: string; theme?: string | null }): Promise<GrowthGoal>;
  // 就地更新一条课题的 GROW 字段 + stage；按 title 匹配（后台巩固用）。
  update(characterId: string, userId: string, id: string, patch: {
    title?: string; goal?: string | null; reality?: string | null; options?: string | null;
    will?: string | null; stage?: GrowthStage; progressNote?: string | null;
  }): Promise<GrowthGoal | null>;
  // 课题做成 → status=done（庆祝后用）；note 可写一句收尾进展。
  complete(characterId: string, userId: string, id: string, note?: string | null): Promise<void>;
  // 放下/不再做 → status=archived（可回溯，不硬删）。
  archive(characterId: string, userId: string, id: string): Promise<void>;
  // 刷新「上次回顾时间」（本轮又聊到它了）。
  touch(characterId: string, userId: string, id: string): Promise<void>;
}

// ============================================================
// L2 语音流水线（ASR / TTS / 非言语发声）
// ============================================================

export type AudioChunk = Uint8Array;
export type AudioFormat = 'pcm_16000' | 'mp3';

// —— ASR ——
export type Transcript = {
  text: string;
  isFinal: boolean; // interim = false，final = true
};

export type ASROptions = {
  language?: string; // 如 'zh' / 'en'
};

export interface STTStream {
  sendAudio(chunk: AudioChunk): void; // 喂 PCM（linear16 16k 单声道）
  finish(): void;                     // 标记说完，触发 final
  close(): void;                      // 强制关闭
}

export interface SpeechToText {
  open(options: ASROptions, onTranscript: (t: Transcript) => void): Promise<STTStream>;
}

// —— TTS ——
export type TTSRequest = {
  text: string;
  voiceId: string;          // 音色（区分人物）
  voiceConfig: VoiceConfig; // speed/energy/pauseMore
  emotion: EmotionTag;      // 这句的情绪
  format?: AudioFormat;     // 输出格式，默认 pcm_16000
};

export interface TextToSpeech {
  // 流式合成；signal abort = 打断（立即停止流）。被中断时抛 AbortError。
  stream(req: TTSRequest, signal?: AbortSignal): AsyncGenerator<AudioChunk>;
}

// —— 非言语发声（哭/笑）：已实现为服务端 `NlsSoundEventDetector`（Node WS 客户端）→ 阿里云 NLS 云端声音事件检测 ——
export type VocalizationEvent = { type: 'laugh' | 'cry'; at: number; confidence?: number };

export interface VocalizationEventDetector {
  // 已由 apps/server/src/speech/nlsSoundEvent.ts 落地；此接口留作换供应商的缝。
  detect?(chunk: AudioChunk): void;
}

// —— 人设增补（陪伴者底座之外的软细节，永久固化 + 提及驱动衰减）——
// 数据：每条 = 陪伴者在对话中自然说出的、关于他自己的软细节（爱好/口味/小回忆/习惯）。
// 铁律：底座不可推翻（角色卡写死）、增量一经写出强制一致、只补软细节。
export type SelfAdded = {
  id: string;
  userId: string;
  characterId: string;
  category: string;      // 回忆 | 喜好 | 习惯 | 口味 | 其它
  content: string;       // 一句话，小而具体："高中在篮球队打过替补"
  mentionCount: number;  // 提及次数（对话中再次被触碰则 +1）
  lastMentionedAt: string | null; // 最近一次被提及（ISO）；null = 从未
  active: boolean;       // 软衰减归档：false = 不再注入（可回溯）
  createdAt: string;
};

// 人设增补存储：独立于用户长期记忆（那是「关于用户」，这是「关于陪伴者自己」）。
export interface SelfAddedStore {
  listActive(characterId: string, userId: string): Promise<SelfAdded[]>;
  write(characterId: string, userId: string, input: { category: string; content: string }): Promise<SelfAdded>;
  touch(characterId: string, userId: string, ids: string[]): Promise<void>;
  archiveStale(characterId: string, userId: string, ttlDays: number): Promise<number>;
}
