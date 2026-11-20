import type { Memory, MemoryKind, MemoryStore, TimeAnchor } from '@mirror/contracts';
import type { DeepSeek } from '../../llm/deepseek';
import type { PrefetchCache } from '../assemble';
import { DIMENSION_LIST, ASPECT_LIST } from '../ontology';
import { shanghaiParts } from '../timezone';
import { normalizeTimeAnchor, parseTimeAnchor, rewriteRelativeTime, tagRecordedAt } from '../timeAnchor';
import { parseJsonish } from '../parse';

// 后台记忆 Agent（异步、不进热路径）：把「写记忆」和「定向召回」从实时回复里挪出来。
// - consolidateTurn：一轮结束后，从「对方说了什么 + 我回了什么」里抽取值得长期记住的内容，分类后落库。
//   相当于原 ReAct 循环里 write_memory 工具的事，但改成离线做（参考 Character.AI / Replika 的后台事实抽取）。
// - prefetchNextTurn：look-ahead 预取——用上一轮文字预热下一轮可能用到的记忆（纯 best-effort，不阻塞）。
// 参考 Generative Agents 的 reflection（离线巩固）+ kima 的 memory consolidation。

const EXTRACT_SYSTEM_PROMPT = `你是记忆抽取助手。读「对方这一轮说了什么 + 陪伴者这一轮回了什么」，从中抽出值得长期记住的、关于对方的内容。只输出 JSON，不要解释、不要 markdown。

规则：
1. 只抽「关于对方的稳定事实 / 反复表达的偏好 / 重要事件」，第三人称、一句话、具体不空泛。对方的事实只能来自【对方这一轮】。
2. 【我这一轮】是陪伴者（你自己的人设）说的话，仅供理解语境，严禁从中抽取任何内容。陪伴者用第一人称说的（如「我拍照」「我遛狗」「我做时尚博主」）是他自己的事，绝不能写成「对方…」；陪伴者的猜测/追问（「是不是…」「可能…」「你是在…吧」）也不是对方说过的，不得写成对方的事实。
3. 每句都记、琐碎寒暄不记。0~5 条，宁缺毋滥。
4. kind 先自报（fact / preference / episodic / profile），系统会再核对一次。其中：
   - profile = 人设，只记「身份基本信息」和「稳定特质」两类——名字/性别/年龄/职业/学校/地域/重要关系（如「对方是深圳大学学生」「对方自称章鱼哥」），以及性格/价值观/长期模式这类长期稳定的东西。别把一次性的状态（如「正在找工作」）写成 profile，那属于 fact。
   - fact = 可变的、具体的事实状态（「正在学 RocketMQ」「目前没工作」「正在找工作」）。
   - 一条只记一件事。若对方一句话里同时含「身份/地域/称呼」+「偏好」+「当前状态」，拆成多条分别归类：身份/地域/称呼（强相关，关于"对方是谁"）→ profile；口味/习惯等偏好 → preference；当前状态/正在做的事（弱相关）→ fact。严禁把身份信息（职业/学校/地域/重要关系/称呼）塞进 fact。
5. dimension 归入哪个维度（${DIMENSION_LIST}），实在归不进去就留空字符串。
6. aspect 归入该维度的哪个子项（${ASPECT_LIST}），没有对应子项就留空字符串。
7. 若这条记忆含「值得长期记住的时间」（生日/纪念日/忌日/规律作息），额外给 anchor，并把 content 写成绝对/周期措辞（如「对方生日是 11 月 13 日」）：
   - 绝对时间（一次性，如某年忌日）：{"kind":"absolute","at":"YYYY-MM-DD"}
   - 周期时间（每年/每月/每周）：{"kind":"periodic","rule":{"type":"yearly","month":M,"day":D}}，每月用 {"type":"monthly","day":D}，每周用 {"type":"weekly","weekday":1~7}（1=周一）。
   - 严禁在 content 里出现「明天/后天/下周三/去年」这类相对词——它们必须在今天（见 user 消息第一行）折算成绝对/周期后落库。
   - 一次性琐碎日程（「明天开会」「今晚要交报告」）不要抽 anchor，宁可不记。
8. 若对方这一轮在纠正之前说过的某个事实（例如「不是签证，是全栈」「我刚才说错了」「其实不是…」），说明之前可能听错/记错了：除了抽取纠正后的正确事实，还要把被纠正掉的错误点放进 retract（放最简短的关键词，通常一个词，如「签证」；别放整句）。没有纠正就省略 retract。

只输出这个 JSON（retract 可省略）：
{"memories":[{"content":"<一句话>","kind":"fact|preference|episodic|profile","dimension":"<维度或空>","aspect":"<子项或空>","anchor":<绝对或周期锚点或省略>}],"retract":["<被纠正掉的错误关键词>"]}`;

export type ExtractOutput = { content: string; kind: MemoryKind; dimension: string; aspect: string; anchor?: TimeAnchor }[];

// 给抽取 prompt 的「今天」：把相对时间（明天/下周三）折算成绝对/周期锚点时的参照日期。
function todayForPrompt(now: Date): string {
  const p = shanghaiParts(now);
  const wd = '一二三四五六日'[p.weekday - 1];
  return `${p.year}年${p.month}月${p.day}日（周${wd}）`;
}

// 一轮结束后异步写记忆：抽取 → 确定性分类兜底 → 落库。返回写入条数（观测用）。
export async function consolidateTurn(deps: {
  llm: DeepSeek;
  model: string;
  store: MemoryStore;
  classify: (raw: string) => Promise<MemoryKind | null>;
  userId: string;
  personaName: string;
  userText: string;
  agentText: string;
  retractIds?: string[]; // 上一轮写入的记忆 id：本轮若是纠正，先按 id 精确撤销它们
}): Promise<{ wrote: number; writtenIds: string[]; facts: string[] }> {
  const { llm, model, store, classify, userId, personaName, userText, agentText, retractIds } = deps;
  if (!userText.trim()) return { wrote: 0, writtenIds: [], facts: [] };

  let out: ExtractOutput;
  let retract: string[] = [];
  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: `今天是 ${todayForPrompt(new Date())}。\n【对方这一轮】${userText}\n【我这一轮】${agentText || '（无）'}` },
      ],
      { model, temperature: 0, maxTokens: 500 },
    );
    out = parseExtraction(raw);
    retract = parseRetraction(raw);
  } catch (e) {
    console.warn('[memory] 抽取失败，跳过：', e);
    return { wrote: 0, writtenIds: [], facts: [] };
  }

  let wrote = 0;
  const writtenIds: string[] = [];
  const now = new Date(); // 本轮统一参照「今天」，相对时间折算/内容改写都以此为基准
  for (const m of out) {
    const content = (m.content ?? '').trim();
    if (!content) continue;
    try {
      // 确定性分类兜底：钉回正确桶；分类失败回退信任自报。
      const kind = (await classify(content)) ?? m.kind;
      // 时间锚点程序化优先（正则找时间 → 绝对/周期），LLM 的 anchor 只当兜底。
      const anchor = parseTimeAnchor(content, now) ?? m.anchor;
      // content 里的相对词（明天/下周三）换成折算后的具体日期，避免存进去的「明天」过几天失效。
      const rewritten = rewriteRelativeTime(content, now);
      // 「目前/正在/即将」这类状态词标注记录时间，避免把瞬时状态当永久事实。
      const tagged = tagRecordedAt(rewritten, now);
      const mem = await store.write(personaName, userId, { kind, content: tagged, dimension: m.dimension || null, aspect: m.aspect || null, anchor: anchor ?? null });
      writtenIds.push(mem.id);
      wrote++;
    } catch (e) {
      console.warn('[memory] 写入失败：', e);
    }
  }

  // 纠正即删：对方这轮纠正了之前听错/记错的事实。
  // 1) 先按 id 精确撤销「上一轮刚写入」的记忆（不做关键词模糊匹配，规避 ASR 错词对不上的坑）；
  // 2) 再用关键词兜底撤销更早写入的错误记忆。
  if (retract.length > 0 && retractIds && retractIds.length > 0) {
    for (const id of retractIds) {
      try {
        const n = await store.retractById(personaName, userId, id);
        if (n > 0) console.log(`[memory] 精确撤销上一轮记忆（id ${id.slice(0, 8)}…）`);
      } catch (e) {
        console.warn('[memory] 精确撤销记忆失败：', e);
      }
    }
  }
  for (const kw of retract) {
    try {
      const n = await store.retract(personaName, userId, kw);
      if (n > 0) console.log(`[memory] 撤销错误记忆（关键词「${kw}」）：${n} 条`);
    } catch (e) {
      console.warn('[memory] 撤销记忆失败：', e);
    }
  }

  const facts = out.map((m) => (m.content ?? '').trim()).filter((c) => c.length > 0);
  return { wrote, writtenIds, facts };
}

// 纯函数：从抽取输出里解析 {content, kind} 列表，非法/缺失返回空。可单测。
export function parseExtraction(raw: string): ExtractOutput {
  const o = parseJsonish(raw);
  if (!o) return [];
  const arr = Array.isArray(o.memories) ? o.memories : [];
  const KINDS = new Set<MemoryKind>(['constraint', 'fact', 'preference', 'episodic', 'profile']);
  const out: ExtractOutput = [];
  for (const item of arr) {
    const x = (item ?? {}) as Record<string, unknown>;
    const content = String(x.content ?? '').trim();
    const kind = String(x.kind ?? '') as MemoryKind;
    const dimension = String(x.dimension ?? '').trim();
    const aspect = String(x.aspect ?? '').trim();
    const anchor = normalizeTimeAnchor(x.anchor);
    if (content && KINDS.has(kind)) {
      out.push(anchor ? { content, kind, dimension, aspect, anchor } : { content, kind, dimension, aspect });
    }
  }
  return out;
}

// 纯函数：从抽取输出里解析 retract（对方这轮纠正掉的错误关键词列表）。可单测。
export function parseRetraction(raw: string): string[] {
  const o = parseJsonish(raw);
  if (!o) return [];
  const arr = Array.isArray(o.retract) ? (o.retract as unknown[]) : [];
  return arr.map((x) => String(x ?? '').trim()).filter((s) => s.length > 0);
}

// look-ahead 预取：用上一轮的文字预热下一轮可能用到的记忆（纯 best-effort）。返回命中条数。
export async function prefetchNextTurn(
  deps: { store: MemoryStore; userId: string; personaName: string; query: string },
  cache: PrefetchCache,
): Promise<number> {
  const key = `${deps.personaName}:${deps.userId}`;
  const query = deps.query.trim() || '当前对话';
  try {
    const hits = await deps.store.search(deps.personaName, deps.userId, query);
    if (hits.length > 0) cache.set(key, hits);
    return hits.length;
  } catch (e) {
    console.warn('[memory] 预取失败，跳过：', e);
    return 0;
  }
}
