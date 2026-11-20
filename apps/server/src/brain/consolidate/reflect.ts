import type { MemoryStore } from '@mirror/contracts';
import type { DeepSeek } from '../../llm/deepseek';
import { parseJsonish } from '../parse';

// 记忆巩固的「抽象升级」步：把已积累的「情节记忆」退一步酿成「稳定事实 fact」与「人设 profile」。
// profile = 对方的身份基本信息 + 稳定特质 + 对对方的高层理解（洞察），落库后自然流进下一次 recall → L2 注入。
// 参考 Generative Agents 的 reflection（对记忆流做高层综合）+ kima 的 memory consolidation。
//
// profile 强制在场（像 constraint 全量召回），所以必须控量：模型少而精 + 硬上限裁剪（prune）。

const REFLECT_SYSTEM_PROMPT = `你是记忆巩固助手。读「已有情节记忆 + 已有事实 + 已有人设」，退一步综合出「对对方新的、更高层的理解」。只输出 JSON，不要解释、不要 markdown。

输出两类（都要用第三人称、一句话、具体不空泛）：
1. facts —— 只收「弱相关的可变事实」：对方**正在经历的事 / 当前状态 / 近期进展**（会变化、会过时的，如「对方正在准备考研」「对方目前没有工作、在家备考」「对方最近在学分布式系统」）。只输出「新出现或变化的」，已有事实里已有的别再重复。每条给一个稳定 entityId（用「正在做的这件事」作键，如 user:goal / user:job_hunt），同实体新事实会覆盖旧事实。
   —— 铁律：凡是「对方是谁」的强相关身份信息（职业/学校/地域/重要关系），一律不放这里，放到 profile。
2. profile —— 「人设」，三类、少而精（0~5 条，宁缺毋滥）：
   - 身份基本信息：名字/性别/年龄/职业/学校/地域/重要关系（如「对方是深圳大学学生，广东人」「对方的职业是护士」）
   - 稳定特质：性格/价值观/长期模式/情绪模式（如「对方更需要被倾听而非建议」「对方习惯把伴侣的付出记成自己的负担」）
   - 高层洞察：对对方退一步的理解（如「对方把'被爱'和'保持光鲜'绑定在了一起」）
   已有 profile 里已有的别再重复；新的要与旧的合并、别堆砌。

只输出这个 JSON：
{"facts": [{"content": "<一句话事实>", "entityId": "<稳定键>"}], "profile": ["<一句话人设>", ...]}`;

export type ReflectionOutput = { facts: { content: string; entityId: string }[]; profile: string[] };

export async function reflectOnMemory(deps: {
  llm: DeepSeek;
  model: string;
  store: MemoryStore;
  userId: string;
  characterId: string;
  maxProfile?: number;
}): Promise<{ factsWritten: number; profileWritten: number }> {
  const { llm, model, store, userId, characterId, maxProfile = 20 } = deps;

  // 只拿最近一段（情节/事实各 50 条足够），人设已控量全取。
  const episodic = (await store.listActive(characterId, userId, 'episodic')).slice(-50);
  if (episodic.length === 0) return { factsWritten: 0, profileWritten: 0 };
  const facts = (await store.listActive(characterId, userId, 'fact')).slice(-50);
  const profile = await store.listActive(characterId, userId, 'profile');

  const userPrompt = [
    '【已有情节记忆】' + (episodic.map((m) => m.content).join('\n') || '（无）'),
    '【已有事实】' + (facts.map((m) => m.content).join('\n') || '（无）'),
    '【已有人设】' + (profile.map((m) => m.content).join('\n') || '（无）'),
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
    return { factsWritten: 0, profileWritten: 0 };
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

  let profileWritten = 0;
  for (const s of out.profile) {
    const content = (s ?? '').trim();
    if (!content) continue;
    try {
      await store.write(characterId, userId, { kind: 'profile', content });
      profileWritten++;
    } catch (e) {
      console.warn('[reflect] 写 profile 失败：', e);
    }
  }

  // 硬上限：人设强制在场，必须控量，超了归档最旧（不硬删，可审计）。
  if (profileWritten > 0) {
    try {
      await store.prune(characterId, userId, 'profile', maxProfile);
    } catch (e) {
      console.warn('[reflect] 裁剪 profile 失败：', e);
    }
  }

  return { factsWritten, profileWritten };
}

// 纯函数：从反思输出里抽 { facts, profile }，非法/缺失返回空。可单测。
export function parseReflection(raw: string): ReflectionOutput {
  const o = parseJsonish(raw);
  if (!o) return { facts: [], profile: [] };
  const facts = Array.isArray(o.facts)
    ? o.facts.map((f) => {
        const x = (f ?? {}) as Record<string, unknown>;
        return { content: String(x.content ?? ''), entityId: String(x.entityId ?? '') };
      })
    : [];
  const profile = Array.isArray(o.profile) ? o.profile.map((s) => String(s)) : [];
  return { facts, profile };
}
