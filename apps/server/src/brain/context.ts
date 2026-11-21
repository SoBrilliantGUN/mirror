import type {
  Affect,
  EmotionTag,
  GrowthGoal,
  IdentityField,
  Memory,
  Mode,
  MoodState,
  RecalledMemories,
  SelfAdded,
  Stance,
  TimeContext,
  UpcomingDate,
  VocalizationEvent,
} from '@mirror/contracts';
import { formatUserTurn, SAFETY_REMINDER } from './prompts';
import { anchorLabel } from './timeAnchor';

// 上下文分层装配器：把一条 user prompt 按「位置」切成固定块（块名带 [] 前缀，供模型分界 + 代码锚点回捞）。
//   system 段（人设+安全+记忆引导）→ [STATE] 状态 → [MEMORY] 记忆 → [REMINDER] 安全红线尾播 → 历史对话（唯一压缩对象）。
// 压缩只打「历史对话」块（见 compress.ts），其余块是固定成本。全部纯函数，可单测。
// 注意：这里的「分层」是 prompt 里的块位置，与 README 的架构分层 L0–L8 是两套编号，别混。

// token 估算（启发式）：中文约 1 token / 1.5 字符，其余约 1 token / 4 字符。
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[一-鿿　-〿＀-￯]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

// 约束子预算上限（占记忆块总预算比例）：红线必须在场，但不能独占预算挤掉偏好/事实/情节。
const CONSTRAINT_BUDGET_RATIO = 0.4;

function fillGroup(label: string, items: Memory[], budget: number): { text: string; used: number } {
  if (items.length === 0 || budget <= 0) return { text: '', used: 0 };
  const lines: string[] = [`【${label}】`];
  let used = 0;
  for (const m of items) {
    const cost = estimateTokens(m.content);
    if (used + cost > budget && lines.length > 1) continue; // 塞不下跳过，继续试后边
    lines.push(`- ${m.content}`);
    used += cost;
  }
  if (lines.length === 1) return { text: '', used: 0 };
  return { text: lines.join('\n'), used };
}

// [MEMORY] 块：五型按 约束→特质→偏好→事实→情节 优先级（约束先拿足预算、特质强制在场），
// 按 token 预算贪心填充；空则返回空串。
export function formatMemoryBlock(recalled: RecalledMemories, maxTokens: number): string {
  const groups: { label: string; items: Memory[] }[] = [
    { label: '约束（硬规则/红线，必须遵守）', items: recalled.constraint },
    { label: '特质（对方的稳定性格/价值观/长期模式 + 你对 TA 的理解，时刻记得）', items: recalled.profile },
    { label: '偏好（软规则/习惯，长期有效）', items: recalled.preference },
    { label: '事实（稳定状态）', items: recalled.fact },
    { label: '情节（具体事件）', items: recalled.episodic },
  ];
  const constraintBudget = Math.floor(maxTokens * CONSTRAINT_BUDGET_RATIO);
  let remaining = maxTokens;
  const blocks: string[] = [];
  for (const g of groups) {
    const budget = g.label.startsWith('约束') ? Math.min(constraintBudget, remaining) : remaining;
    const block = fillGroup(g.label, g.items, budget);
    if (block.text) {
      blocks.push(block.text);
      remaining -= block.used;
    }
  }
  if (blocks.length === 0) return '';
  return '[MEMORY]\n' + blocks.join('\n\n');
}

// [STATE] 状态快照：轻量标量（不是完整 State JSON，噪音太大）。
export function formatStateBlock(s: {
  mode: Mode;
  stance: Stance;
  emotion: EmotionTag;
  mood: MoodState | null;
  turnCount: number;
  affect?: Affect; // 对方这一轮的瞬时情感（追问高唤醒点用）
  userGender?: '男' | '女' | null; // 从语音检测出的对方性别，用于人称「他/她」
}): string {
  const mood = s.mood
    ? `心境 效价${s.mood.valence.toFixed(2)}/唤醒${s.mood.arousal.toFixed(2)}/支配${s.mood.dominance.toFixed(2)}`
    : '心境 尚未形成';
  const affect = s.affect
    ? `对方此刻 效价${s.affect.valence.toFixed(2)}/唤醒${s.affect.arousal.toFixed(2)}/支配${s.affect.dominance.toFixed(2)}`
    : '';
  const gender = s.userGender ? ` | 对方：${s.userGender}（指代时用「${s.userGender === '男' ? '他' : '她'}」）` : '';
  return `[STATE]\nTurn: ${s.turnCount} | Mode: ${s.mode} | Stance: ${s.stance} | Emotion: ${s.emotion} | ${mood}${affect ? ` | ${affect}` : ''}${gender}`;
}

// [TIME] 时间感知块：当前时间上下文 + 临近/当天的重要日期 + 作息关怀软信号（无时间上下文则省略）。
export function formatTimeBlock(t?: TimeContext, upcoming?: UpcomingDate[], careHint?: string): string {
  if (!t) return '';
  const weekday = '一二三四五六日'[t.weekday - 1];
  const dayKind = t.isHoliday ? `，今天是${t.holidayName ?? '法定节假日'}（节假日）` : t.isWorkday ? '，今天工作日' : '，今天周末';
  const lines = [
    `[TIME] 现在是 ${t.month}月${t.day}日 周${weekday} ${t.period}（${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}）${t.season}季${dayKind}`,
  ];
  for (const u of upcoming ?? []) {
    const when = u.inDays === 0 ? '今天' : u.inDays === 1 ? '明天' : `${u.inDays} 天后`;
    lines.push(`${when}是对方的${u.relation}（${anchorLabel(u.anchor)}）`);
  }
  if (careHint) lines.push(careHint);
  return lines.join('\n');
}

// [SELF_ADDED] 人设增补块：陪伴者自己说过的软细节，保持前后一致、绝不改口。空则返回空串。
export function formatSelfAddedBlock(items: SelfAdded[]): string {
  if (items.length === 0) return '';
  return (
    '[SELF_ADDED] 你说过的、关于你自己的事（保持前后一致，绝不改口）：\n' +
    items.map((s) => `- ${s.content}`).join('\n')
  );
}

// [IDENTITY] 结构化身份块：对方的基本信息（字段→值，单值、覆盖式）。空则返回空串。
export function formatIdentityBlock(fields: IdentityField[]): string {
  if (fields.length === 0) return '';
  return '[IDENTITY] 对方的基本信息（记在心里，别念档案）：\n' + fields.map((f) => `- ${f.field}：${f.value}`).join('\n');
}

// [约束] 尾部重放：把硬规则/红线再强调一遍（头部 [MEMORY] 已有一遍，这里防 lost-in-the-middle）。空则返回空串。
export function formatConstraintReminder(constraints: Memory[]): string {
  if (constraints.length === 0) return '';
  return '[约束] 再强调一遍，这些硬规则/红线务必遵守，别因为聊得投入就忘掉：\n' + constraints.map((c) => `- ${c.content}`).join('\n');
}

const STAGE_LABEL: Record<string, string> = {
  goal: '定目标',
  reality: '看现状',
  options: '列选项',
  will: '定行动',
  done: '已完成',
};

// [GOAL] 成长课题块：把进行中课题的 GROW 进度喂给模型（重骨架），但要求化进自然对话（轻表达）。
// 空则返回空串。可单测。
export function formatGoalBlock(goals: GrowthGoal[]): string {
  const active = goals.filter((g) => g.status === 'active');
  if (active.length === 0) return '';
  const lines = active.map((g) => {
    const stage = STAGE_LABEL[g.stage] ?? g.stage;
    const parts = [`「${g.title}」——在 ${stage}阶段`];
    if (g.goal) parts.push(`她想要的：${g.goal}`);
    if (g.reality) parts.push(`现状：${g.reality}`);
    if (g.options) parts.push(`可选：${g.options}`);
    if (g.will) parts.push(`下一步：${g.will}`);
    if (g.progressNote) parts.push(`最近进展：${g.progressNote}`);
    return '- ' + parts.join('；');
  });
  return (
    '[GOAL] 对方正在进行的成长课题（当成你心里记着的事，别念档案、别填表，化进自然对话里。若对方隔了一阵子回来，可温柔问问上一步后来怎么样）：\n' +
    lines.join('\n')
  );
}

// [FOLLOW_UP] 主动追问：新通话首轮，若对方有「上一步还没结果」的进行中课题，温柔带一句"后来呢"。
// 只挑最近更新、且有下一步（will）的那条；空则返回空串。可单测。
export function buildGoalFollowUpHint(goals: GrowthGoal[]): string {
  const pending = goals.filter((g) => g.status === 'active' && g.will);
  if (pending.length === 0) return '';
  const g = pending[pending.length - 1]; // listActive 按 updated_at 升序，最后一条最新
  return `[FOLLOW_UP] 对方之前有个进行中的课题「${g.title}」，上一步是「${g.will}」，之后没再提起。这一轮别急着开教练、别像查岗一样追问，就朋友般地自然带一句"上次说的那件事，后来怎么样了？"，看对方愿不愿接着往下说。`;
}

// 历史条目：要么是一轮对话（turn），要么是压缩摘要（summary，恒在最前）。
export type HistoryEntry =
  | { kind: 'turn'; role: 'user' | 'agent'; text: string }
  | { kind: 'summary'; marker: string; text: string };

// 历史（已压缩后）格式化。多轮改造后，逐字 turn 走原生消息、这里通常只剩摘要：
// 只剩摘要时标成「更早对话摘要」，避免被误当成逐字最近对话。
export function formatHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return '';
  const hasTurns = history.some((h) => h.kind === 'turn');
  const header = hasTurns ? '【最近对话】' : '【更早对话摘要】';
  return (
    header + '\n' +
    history
      .map((h) => (h.kind === 'summary' ? `${h.marker} ${h.text}` : `${h.role === 'user' ? '对方' : '我'}：${h.text}`))
      .join('\n')
  );
}

// 装配 [STATE]+[MEMORY]+[REMINDER]+历史 为一条 user prompt（带内标记分界，供模型分界 + 代码锚点回捞）。
//
// 块 ← 来源字段 对照表（改注入时先查这里）：
//   [MEMORY]           ← memories + memoryBudget
//   [PERSONA]          ← personaBlock
//   [SELF_ADDED]       ← selfAddedBlock
//   [IDENTITY]         ← identityBlock
//   [STATE]            ← mode/stance/emotion/mood/turnCount/affect/userGender
//   [GOAL]             ← goalBlock
//   [FOLLOW_UP]        ← goalFollowUp
//   [TIME]             ← timeBlock
//   [CURIOSITY]        ← curiosityHint
//   [TOPIC]            ← switchTopic
//   [RECENT]           ← recentSummary
//   [HISTORY]          ← history
//   [CRISIS_RESOURCES] ← safetyBlock
//   [SAFETY_REMINDER]  ← 常量（尾播）
//   [FAREWELL]         ← farewell
//   [SAID]             ← userSaid
//   [ASKED]            ← recentAsked
//   [ANSWERED]         ← lastAskedQuestion
//   【对方这一轮】       ← text + vocalizations
// 决策阶段的「信号」与装配阶段的「格式化产物」分界线：
// TurnPromptSignals = plan 那批标量（mode/stance/emotion/…）+ 会话级小状态，context 与 assemble 共用，
// 避免两个 20 字段的大参数包各写一份。两个装配器都 extends 它。
export type TurnPromptSignals = {
  mode: Mode;
  stance: Stance;
  emotion: EmotionTag;
  mood: MoodState | null;
  turnCount: number;
  text: string;
  affect?: Affect; // 对方这一轮瞬时情感（追问高唤醒点用）
  userGender?: '男' | '女' | null; // 从语音检测出的对方性别（注入 [STATE] 供人称「他/她」）
  vocalizations?: VocalizationEvent[];
  switchTopic?: boolean; // 对方连续几轮不感兴趣 → 注入 [TOPIC] 块，主动换话题
  lastAskedQuestion?: string; // 上一轮陪伴者问句原文（若上一轮以问句结尾）→ 注入 [ANSWERED]，禁止重复问已答问题
  userSaid?: string[]; // 会话小笔记本：对方本次已回答过的话 → 注入 [SAID]，禁止重复问/矛盾
  recentAsked?: string[]; // 近 3 天已问过的问题（跨通话）→ 注入 [ASKED]，禁止重复问
  recentSummary?: string; // 最近 3 天对话概要（跨通话）→ 注入 [RECENT]，让陪伴者自然接上最近话题
  farewell?: boolean; // 对方这一轮在道别 → 注入 [FAREWELL] 块，回一句道别收尾、不再追问/开新话题
  curiosityHint?: string; // 好奇心线索（预格式化好的 [CURIOSITY] 块），注入当软信号
  goalFollowUp?: string; // [FOLLOW_UP] 主动追问（新通话首轮、每通一次，空则省略）
};

export type LayeredPromptInput = TurnPromptSignals & {
  timeBlock?: string; // 时间感知块（预格式化好的 [TIME] 块），空则省略
  goalBlock?: string; // [GOAL] 成长课题块（预格式化好，空则省略）
  safetyBlock?: string; // [CRISIS_RESOURCES] 危机资源块（refer 时确定性注入，保证号码必现）
  memories: RecalledMemories;
  memoryBudget: number;
  history: HistoryEntry[]; // 已经过压缩的历史（多轮改造后只剩摘要；逐字 turn 走原生消息）
  personaBlock?: string; // [PERSONA] 人物命中详情块（渐进式加载，空则省略）
  selfAddedBlock?: string; // [SELF_ADDED] 人设增补块（永久固化 + 强制一致，空则省略）
  identityBlock?: string; // [IDENTITY] 结构化身份块（字段→值，单值覆盖；空则省略）
};

export function buildLayeredUserPrompt(input: LayeredPromptInput): string {
  const parts: string[] = [];

  const memory = formatMemoryBlock(input.memories, input.memoryBudget);
  if (memory) parts.push(memory);

  if (input.personaBlock) parts.push(input.personaBlock);

  if (input.selfAddedBlock) parts.push(input.selfAddedBlock);

  if (input.identityBlock) parts.push(input.identityBlock);

  parts.push(formatStateBlock(input));

  if (input.goalBlock) {
    parts.push(input.goalBlock);
  }

  if (input.goalFollowUp) {
    parts.push(input.goalFollowUp);
  }

  if (input.timeBlock) {
    parts.push(input.timeBlock);
  }

  if (input.curiosityHint) {
    parts.push(input.curiosityHint);
  }

  if (input.switchTopic) {
    parts.push(
      '[TOPIC] 这个话题要么对方已经兴致不高（唤醒低、回复慢、回复越来越短越来越敷衍），要么已经聊得太久、翻来覆去问腻了。这一轮别延续当前话题，自然换个话题或换个角度（优先级：①对对方好奇，问一个你还不了解他的方面 ②兴趣爱好 ③工作 ④实在没话说讲你自己），自然过渡，别生硬说"我们换个话题吧"。',
    );
  }

  if (input.recentSummary) {
    parts.push(
      `[RECENT] 你最近 3 天和对方聊过这些（当成你心里记得的事，聊到相关处自然带一句、能接上就行，别一上来就生硬回顾或复述）：\n${input.recentSummary}`,
    );
  }

  const history = formatHistory(input.history);
  if (history) parts.push(history);

  if (input.safetyBlock) {
    parts.push(input.safetyBlock); // refer 时的确定性危机资源（与 SAFETY_REMINDER 一前一后夹住）
  }

  parts.push(SAFETY_REMINDER); // [REMINDER] 尾部重放（首尾三明治的「尾」）
  // 约束（硬规则/红线）也在尾部重放一遍——头部 [MEMORY] 已有一遍，这里再强调，防 lost-in-the-middle。
  const constraintReminder = formatConstraintReminder(input.memories.constraint);
  if (constraintReminder) parts.push(constraintReminder);

  if (input.farewell) {
    parts.push(
      '[FAREWELL] 对方这一轮在道别、想结束通话了。自然地回应道别：说再见、用你的语气收一句尾（晚安／改天再聊／照顾好自己都行），1~2 句就好。绝不开启新话题、绝不提问、绝不挽留、绝不追问、绝不再聊刚才的事。（若对方同时透露出危机，安全转介仍最优先。）',
    );
  }

  if (input.userSaid && input.userSaid.length > 0) {
    const list = input.userSaid.map((s, i) => `${i + 1}. ${s}`).join('\n');
    parts.push(
      `[SAID] 这是对方在本次通话里已经告诉过你的事（跨通话的长期记忆另给）。别重复问已经知道答案的问题，也别说与对方这些答复相矛盾的话：\n${list}`,
    );
  }

  if (input.recentAsked && input.recentAsked.length > 0) {
    const list = input.recentAsked.map((s, i) => `${i + 1}. ${s}`).join('\n');
    parts.push(
      `[ASKED] 这是你最近 3 天已经问过对方的问题。除非对方主动重新提起，否则别重复问这些或近义的问题（也别换种说法再问一遍）：\n${list}`,
    );
  }

  if (input.lastAskedQuestion) {
    parts.push(
      `[ANSWERED] 你上一句问的是：「${input.lastAskedQuestion}」。对方这一轮正在回答这个问题。先接住 TA 的回答、顺着往下聊；严禁再重复问这个或近义的问题，也严禁把你上一句刚说过的话原样再念一遍。`,
    );
  }

  parts.push(`【对方这一轮】${formatUserTurn(input.text, input.vocalizations)}`);

  return parts.join('\n\n');
}
