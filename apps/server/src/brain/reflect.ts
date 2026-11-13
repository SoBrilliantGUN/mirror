import type { MemoryStore } from '@mirror/contracts';
import type { DeepSeek } from '../llm/deepseek';

// 后端反思（Reflection / 记忆巩固）：新通话开始时退一步，把已积累的「情节记忆」酿成
// 「稳定事实 fact」与「高层洞察 insight」，落库后自然流进下一次 recall → L2 注入，让教练「越聊越懂对方」。
// 参考 Generative Agents 的 reflection（对记忆流做高层综合）+ kima 的 memory consolidation。
//
// insight 单独成型、强制在场（像 constraint 全量召回），所以必须控量：模型少而精 + 硬上限裁剪（prune）。

const REFLECT_SYSTEM_PROMPT = `你是记忆巩固助手。读「已有情节记忆 + 已有事实 + 已有洞察」，退一步综合出「对对方新的、更高层的理解」。只输出 JSON，不要解释、不要 markdown。

输出两类（都要用第三人称、一句话、具体不空泛）：
1. facts —— 从情节记忆提炼的「稳定事实」（职业/家庭/重要关系/正在经历的事）。只输出「新出现或变化的」，已有事实里已有的别再重复。每条给一个稳定 entityId（如 user:job / user:family / user:goal），同实体新事实会覆盖旧事实。
2. insights —— 「对对方的理解」，只这四类、少而精（0~5 条，宁缺毋滥）：
   - 情绪模式/触发点（"一提工作就唤醒飙升、语速变快"）
   - 成长观察（"对方第一次主动说出自己的需要"）
   - 关系洞察（"还处试探期，对我有戒备，别太亲昵"）
   - 成长课题（"怕被拒绝所以不敢表达"）
   已有洞察里已有的别再重复；新洞察要与旧的合并、别堆砌。

只输出这个 JSON：
{"facts": [{"content": "<一句话事实>", "entityId": "<稳定键>"}], "insights": ["<一句话洞察>", ...]}`;

export type ReflectionOutput = { facts: { content: string; entityId: string }[]; insights: string[] };

export async function reflectOnMemory(deps: {
  llm: DeepSeek;
  model: string;
  store: MemoryStore;
  userId: string;
  characterId: string;
  maxInsights?: number;
}): Promise<{ factsWritten: number; insightsWritten: number }> {
  const { llm, model, store, userId, characterId, maxInsights = 20 } = deps;

  // 只拿最近一段（情节/事实各 50 条足够），洞察已控量全取。
  const episodic = (await store.listActive(characterId, userId, 'episodic')).slice(-50);
  if (episodic.length === 0) return { factsWritten: 0, insightsWritten: 0 };
  const facts = (await store.listActive(characterId, userId, 'fact')).slice(-50);
  const insights = await store.listActive(characterId, userId, 'insight');

  const userPrompt = [
    '【已有情节记忆】' + (episodic.map((m) => m.content).join('\n') || '（无）'),
    '【已有事实】' + (facts.map((m) => m.content).join('\n') || '（无）'),
    '【已有洞察】' + (insights.map((m) => m.content).join('\n') || '（无）'),
  ].join('\n\n');

  let out: ReflectionOutput;
  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: REFLECT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { model, temperature: 0, maxTokens: 1500 },
    );
    out = parseReflection(raw);
  } catch (e) {
    console.warn('[reflect] 反思调用失败，跳过：', e);
    return { factsWritten: 0, insightsWritten: 0 };
  }

  let factsWritten = 0;
  for (const f of out.facts) {
    const content = (f.content ?? '').trim();
    if (!content) continue;
    try {
      await store.write(characterId, userId, { kind: 'fact', content, entityId: f.entityId?.trim() || null });
      factsWritten++;
    } catch (e) {
      console.warn('[reflect] 写 fact 失败：', e);
    }
  }

  let insightsWritten = 0;
  for (const s of out.insights) {
    const content = (s ?? '').trim();
    if (!content) continue;
    try {
      await store.write(characterId, userId, { kind: 'insight', content });
      insightsWritten++;
    } catch (e) {
      console.warn('[reflect] 写 insight 失败：', e);
    }
  }

  // 硬上限：洞察强制在场，必须控量，超了归档最旧（不硬删，可审计）。
  if (insightsWritten > 0) {
    try {
      await store.prune(characterId, userId, 'insight', maxInsights);
    } catch (e) {
      console.warn('[reflect] 裁剪 insight 失败：', e);
    }
  }

  return { factsWritten, insightsWritten };
}

// 纯函数：从反思输出里抽 { facts, insights }，非法/缺失返回空。可单测。
export function parseReflection(raw: string): ReflectionOutput {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1].trim() : raw;
  const brace = jsonStr.match(/\{[\s\S]*\}/);
  let obj: unknown;
  try {
    obj = JSON.parse(brace ? brace[0] : jsonStr);
  } catch {
    return { facts: [], insights: [] };
  }
  const o = obj as Record<string, unknown>;
  const facts = Array.isArray(o.facts)
    ? o.facts.map((f) => {
        const x = (f ?? {}) as Record<string, unknown>;
        return { content: String(x.content ?? ''), entityId: String(x.entityId ?? '') };
      })
    : [];
  const insights = Array.isArray(o.insights) ? o.insights.map((s) => String(s)) : [];
  return { facts, insights };
}
