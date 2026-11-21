import type {
  CoverageEntry,
  DependenceAction,
  Frame,
  GrowthGoal,
  GrowthGoalStore,
  IdentityField,
  IdentityStore,
  Memory,
  MemoryStore,
  RecalledMemories,
  SafetyAction,
  SelfAdded,
  SelfAddedStore,
  TimeAware,
  TimeContext,
  UpcomingDate,
} from '@mirror/contracts';
import type { ChatMessage } from '../llm/deepseek';
import { formatPersonaBlock, type PersonaDetail } from '../persona/loadPersona';
import { buildGoalFollowUpHint, buildLayeredUserPrompt, formatGoalBlock, formatIdentityBlock, formatSelfAddedBlock, formatTimeBlock, type HistoryEntry, type TurnPromptSignals } from './context';
import { buildGenerateSystemPrompt } from './prompts';
import { buildCuriosityHint } from './ontology';
import { formatCrisisResources } from './crisisResources';

// 「说话 LLM」的上下文装配（热路径，零工具循环）：
// eager 召回基线记忆（约束硬召回 + fact/preference/episodic 混合召回）注入 [MEMORY] 块，
// 再压缩历史、装配分层上下文，直接返回完整 messages 供 streamMessages 流式生成最终回复。
// 首字延迟只多一次向量召回（非 LLM 往返）；记忆的「写」与「定向召回」都挪到后台 Agent
// （见 consolidate.ts），不进热路径。参考 kima 的 reactive 图，但把工具循环整段摘掉了。

export type PrefetchCache = {
  take(key: string): Memory[] | null;
  set(key: string, memories: Memory[]): void;
  clear(): void;
};

// 一次性预取缓存：每 key 单槽，set 覆盖、take 取走即清空（每次预取只服务「紧接着的下一轮」）。
export function createPrefetchCache(): PrefetchCache {
  const slots = new Map<string, Memory[]>();
  return {
    take(key) {
      const v = slots.get(key) ?? null;
      slots.delete(key);
      return v;
    },
    set(key, memories) {
      slots.set(key, memories);
    },
    clear() {
      slots.clear();
    },
  };
}

export type AssembleDeps = {
  store: MemoryStore;
  userId: string;
  personaName: string;
  memoryBudget: number;
  compress: (entries: HistoryEntry[]) => Promise<HistoryEntry[]>;
  // 时间感知（架构 L5 · 状态/会话）：当前时间上下文 + 临近日期 + 作息关怀，装配成 [TIME] 块。
  timeAware: TimeAware;
  // 人设增补存储：每轮召回活跃软细节，装配成 [SELF_ADDED] 块（永久固化 + 强制一致）。
  selfAdded: SelfAddedStore;
  // 成长课题存储：每轮召回进行中课题，装配成 [GOAL] 块（Life Coach 的跨会话轨迹）。
  goals: GrowthGoalStore;
  // 结构化身份存储：每轮召回字段（单值、覆盖式），装配成 [IDENTITY] 块。
  identity: IdentityStore;
  // 人物记忆渐进式加载：语义匹配器（无则跳过）+ 会话级已加载详情缓存。
  personaMatch?: (text: string) => Promise<PersonaDetail[]>;
  // look-ahead 预取缓存：后台预热命中的记忆并入本轮召回（纯增量、去重，可选）。
  prefetchCache?: PrefetchCache;
};

export type AssembleInput = TurnPromptSignals & {
  personaSystemPrompt: string;
  frame?: Frame;                 // 交互框架：coach 时注入 GROW 块
  coachInvite?: boolean;         // 主动察觉累计命中 → 注入温柔邀入块
  celebrate?: boolean;           // 刚解决退出教练 → 注入庆祝块
  safetyAction?: SafetyAction;   // 危机（refer 时注入确定性资源块）
  dependence?: DependenceAction; // 过度依赖（boundary 时注入设界块）
  searchEnabled?: boolean; // 配了联网搜索 key → 注入 search_web 工具使用规则
};

// 召回阶段只需要这三样，与打分（mode/stance/emotion）无关 → 可并行
export type RecallInput = {
  text: string;
  history: HistoryEntry[];
  loadedDetails: PersonaDetail[];
};

export type RecalledContext = {
  recalled: RecalledMemories;
  loadedDetails: PersonaDetail[];
  compressedHistory: HistoryEntry[];
  personaBlock: string;
  selfAdded: SelfAdded[]; // 人设增补（陪伴者说过的软细节，强制在场）
  goals: GrowthGoal[];    // 进行中的成长课题（[GOAL] 块注入）
  identity: IdentityField[]; // 结构化身份（[IDENTITY] 块注入，单值字段）
  coverage: CoverageEntry[]; // dimension + aspect → 已知事实数（好奇心缺口检测用）
  time: { timeContext?: TimeContext; upcoming: UpcomingDate[]; careHint: string };
};

const EMPTY_RECALL: RecalledMemories = { constraint: [], fact: [], preference: [], episodic: [], profile: [] };

const RECALL_KEYS = ['constraint', 'profile', 'fact', 'preference', 'episodic'] as const;

// 空的召回上下文：eval/demo（无长期记忆）复用生产同一套消息装配时用。
export function emptyRecall(): RecalledContext {
  return {
    recalled: EMPTY_RECALL,
    loadedDetails: [],
    compressedHistory: [],
    personaBlock: '',
    selfAdded: [],
    goals: [],
    identity: [],
    coverage: [],
    time: { timeContext: undefined, upcoming: [], careHint: '' },
  };
}

// 会话内合并人物详情：已加载的保持，新命中的追加（按 name 去重，先到先得）。
function mergeDetails(loaded: PersonaDetail[], fresh: PersonaDetail[]): PersonaDetail[] {
  if (fresh.length === 0) return loaded;
  const seen = new Set(loaded.map((d) => d.name));
  const added = fresh.filter((d) => !seen.has(d.name));
  return added.length === 0 ? loaded : [...loaded, ...added];
}

// 纯函数：把后台预取命中的记忆并入本轮召回（按 id 去重，纯增量，不覆盖 eager 召回结果）。可单测。
export function mergeRecalled(base: RecalledMemories, extra: Memory[]): RecalledMemories {
  if (extra.length === 0) return base;
  const seen = new Set<string>();
  for (const k of RECALL_KEYS) for (const m of base[k]) seen.add(m.id);
  const out: RecalledMemories = {
    constraint: [...base.constraint],
    profile: [...base.profile],
    fact: [...base.fact],
    preference: [...base.preference],
    episodic: [...base.episodic],
  };
  for (const m of extra) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out[m.kind].push(m);
  }
  return out;
}

// 记忆召回 + 历史压缩：与打分（planTurn）无关，可并行跑，省掉一次串行等待。
export async function recallContext(deps: AssembleDeps, input: RecallInput): Promise<RecalledContext> {
  const { store, userId, personaName, compress, personaMatch, prefetchCache, timeAware, goals, identity } = deps;
  const text = input.text || '当前对话';
  const now = new Date();

  // 八个互不依赖的步骤并行跑：eager 召回、人物详情匹配、历史压缩、覆盖率、临近日期、人设增补、成长课题、身份。
  // 之前串行 await，embedding 召回 + 历史压缩都慢时会出现延迟尖峰（日志里见过召回 2977ms）。
  // 每个网络/DB 步骤都各自 try/catch 降级为空，不因单点失败阻断对话。
  const [recalled, freshDetails, compressedHistory, coverage, upcoming, selfAdded, activeGoals, identityFields] = await Promise.all([
    (async (): Promise<RecalledMemories> => {
      try { return await store.recall(personaName, userId, text); }
      catch (e) { console.warn('[memory] 召回失败，降级为空记忆：', e); return EMPTY_RECALL; }
    })(),
    (async (): Promise<PersonaDetail[]> => {
      if (!personaMatch) return [];
      try { return await personaMatch(text); }
      catch (e) { console.warn('[persona] 详情匹配失败，降级为空：', e); return []; }
    })(),
    compress(input.history),
    (async (): Promise<CoverageEntry[]> => {
      try { return await store.getCoverage(personaName, userId); }
      catch (e) { console.warn('[memory] 覆盖率查询失败：', e); return []; }
    })(),
    (async (): Promise<UpcomingDate[]> => {
      try { return await timeAware.upcomingDates(personaName, userId, now); }
      catch (e) { console.warn('[time] 临近日期查询失败，降级为空：', e); return []; }
    })(),
    (async (): Promise<SelfAdded[]> => {
      try { return await deps.selfAdded.listActive(personaName, userId); }
      catch (e) { console.warn('[self-add] 召回失败，降级为空：', e); return []; }
    })(),
    (async (): Promise<GrowthGoal[]> => {
      try { return await goals.listActive(personaName, userId); }
      catch (e) { console.warn('[goal] 课题召回失败，降级为空：', e); return []; }
    })(),
    (async (): Promise<IdentityField[]> => {
      try { return await identity.list(personaName, userId); }
      catch (e) { console.warn('[identity] 身份召回失败，降级为空：', e); return []; }
    })(),
  ]);

  // look-ahead 预取：后台上一轮预热命中的记忆并入本轮（纯函数，无 IO）。
  let recalledMerged = recalled;
  if (prefetchCache) {
    const prefetched = prefetchCache.take(`${personaName}:${userId}`) ?? [];
    recalledMerged = mergeRecalled(recalled, prefetched);
  }
  // 人物记忆渐进式加载（会话内合并去重）。
  const loadedDetails = freshDetails.length ? mergeDetails(input.loadedDetails, freshDetails) : input.loadedDetails;
  const personaBlock = formatPersonaBlock(loadedDetails);

  // 时间感知：当前时间上下文（纯函数）+ 作息关怀软信号（纯函数，依赖 recall 结果）。
  const timeContext = timeAware.currentTimeContext(now);
  const careHint = timeAware.scheduleCareHint(now, recalledMerged);

  return { recalled: recalledMerged, loadedDetails, compressedHistory, personaBlock, selfAdded, goals: activeGoals, identity: identityFields, coverage, time: { timeContext, upcoming, careHint } };
}

// 从召回结果 + 决策结果装配最终 messages。
export function buildTurnMessages(ctx: RecalledContext, memoryBudget: number, input: AssembleInput): ChatMessage[] {
  const system = buildGenerateSystemPrompt({
    mode: input.mode,
    stance: input.stance,
    personaSystemPrompt: input.personaSystemPrompt,
    dependence: input.dependence,
    searchEnabled: input.searchEnabled,
    frame: input.frame,
    coachInvite: input.coachInvite,
    celebrate: input.celebrate,
  });

  // 多轮结构：逐字 turn 发成原生 user/assistant 消息——代词/指代绑定远比「拍平成一段文本」可靠；
  // 压缩摘要（无天然角色）与记忆/状态块一起留在最后的 user 消息里。
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  const summaries: HistoryEntry[] = [];
  for (const h of ctx.compressedHistory) {
    if (h.kind === 'turn') {
      messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
    } else {
      summaries.push(h);
    }
  }

  // 决策信号（TurnPromptSignals）显式逐字段透传——不再 ...input 一把梭，避免把
  // personaSystemPrompt / frame / coachInvite / celebrate / dependence / searchEnabled 这些
  // 只给 system prompt 用的字段泄漏进 user prompt。装配器独有字段（召回/格式化产物）在这里补齐。
  const baseUser = buildLayeredUserPrompt({
    mode: input.mode,
    stance: input.stance,
    emotion: input.emotion,
    mood: input.mood,
    turnCount: input.turnCount,
    text: input.text,
    affect: input.affect,
    userGender: input.userGender,
    vocalizations: input.vocalizations,
    switchTopic: input.switchTopic,
    lastAskedQuestion: input.lastAskedQuestion,
    userSaid: input.userSaid,
    recentAsked: input.recentAsked,
    recentSummary: input.recentSummary,
    farewell: input.farewell,
    curiosityHint: input.frame === 'coach' ? undefined : (input.curiosityHint ?? buildCuriosityHint(ctx.coverage)),
    goalFollowUp: input.goalFollowUp,
    timeBlock: formatTimeBlock(ctx.time.timeContext, ctx.time.upcoming, ctx.time.careHint),
    goalBlock: formatGoalBlock(ctx.goals),
    safetyBlock: input.safetyAction?.action === 'refer' ? formatCrisisResources() : undefined,
    memories: ctx.recalled,
    memoryBudget,
    history: summaries,
    personaBlock: ctx.personaBlock,
    selfAddedBlock: formatSelfAddedBlock(ctx.selfAdded),
    identityBlock: formatIdentityBlock(ctx.identity),
  });
  messages.push({ role: 'user', content: baseUser });
  return messages;
}
