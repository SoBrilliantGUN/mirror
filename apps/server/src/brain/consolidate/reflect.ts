import type { IdentityStore, MemoryStore } from '@mirror/contracts';
import type { DeepSeek } from '../../llm/deepseek';
import { parseJsonish } from '../parse';

// 记忆巩固的「抽象升级」步：把已积累的「情节记忆」退一步酿成「稳定事实 fact」「结构化身份 identity」
// 与「软特质 profile」。参考 Generative Agents 的 reflection（对记忆流做高层综合）+ kima 的 memory consolidation。
//
// 身份与软特质分开：身份（名字/性别/职业/…）单值、覆盖式存进 user_identity；软特质（性格/价值观/洞察）
// 多值、自由文本存进 profile。profile 强制在场（像 constraint 全量召回），所以必须控量。

const REFLECT_SYSTEM_PROMPT = `你是记忆巩固助手。读「已有情节记忆 + 已有事实 + 已有特质 + 已有身份」，退一步综合出「对对方新的、更高层的理解」。只输出 JSON，不要解释、不要 markdown。

输出三类（都要第三人称、具体不空泛）：
1. facts —— 只收「弱相关的可变事实」：对方**正在经历的事 / 当前状态 / 近期进展**（会变化、会过时的，如「对方正在准备考研」「对方目前没有工作、在家备考」）。只输出「新出现或变化的」。每条给一个稳定 entityId（用「正在做的这件事」作键，如 user:goal / user:job_hunt），同实体新事实覆盖旧事实。
   —— 铁律：凡是「对方是谁」的身份信息（名字/性别/职业/学校/地域/重要关系），一律不放这里，放到 identity。
2. identity —— 「身份基本信息」结构化字段，每个字段一个值：
   - 字段名用规范标签：中文名 / 英文名 / 昵称 / 性别 / 年龄 / 职业 / 学校 / 地域 / 重要关系；没有对应标签的就自造一个简短的（如「宠物」「婚恋状态」「老家」）。
   - 每个字段只出一个值；已有身份里已有的字段别重复，只报「新出现或变化」的。
   - 宁缺毋滥：只从材料里能明确推断出的才写，别编造。
3. profile —— 「软特质」，少而精（0~5 条）：
   - 稳定特质：性格 / 价值观 / 长期模式 / 情绪模式（如「对方更需要被倾听而非建议」）
   - 高层洞察：对对方退一步的理解（如「对方把'被爱'和'保持光鲜'绑定在了一起」）
   —— 身份基本信息不放在这里；已有 profile 里已有的别重复，新的要与旧的合并、别堆砌。

只输出这个 JSON：
{"facts": [{"content": "<一句话事实>", "entityId": "<稳定键>"}], "identity": [{"field": "<字段名>", "value": "<值>"}], "profile": ["<一句话软特质>", ...]}`;

export type ReflectionOutput = {
  facts: { content: string; entityId: string }[];
  identity: { field: string; value: string }[];
  profile: string[];
};

// 反思结果：既带计数，也带实际写下的内容（前端展示「做梦做了什么」用）。
export type ReflectResult = {
  factsWritten: number;
  identityWritten: number;
  profileWritten: number;
  facts: string[];
  identity: { field: string; value: string }[];
  profile: string[];
};

export async function reflectOnMemory(deps: {
  llm: DeepSeek;
  model: string;
  store: MemoryStore;
  identity: IdentityStore;
  userId: string;
  personaName: string;
  maxProfile?: number;
}): Promise<ReflectResult> {
  const { llm, model, store, identity, userId, personaName, maxProfile = 20 } = deps;

  // 只拿最近一段（情节/事实各 50 条足够），特质已控量全取。
  const episodic = (await store.listActive(personaName, userId, 'episodic')).slice(-50);
  if (episodic.length === 0) return { factsWritten: 0, identityWritten: 0, profileWritten: 0, facts: [], identity: [], profile: [] };
  const facts = (await store.listActive(personaName, userId, 'fact')).slice(-50);
  const profile = await store.listActive(personaName, userId, 'profile');
  const existingIdentity = await identity.list(personaName, userId);

  const userPrompt = [
    '【已有情节记忆】' + (episodic.map((m) => m.content).join('\n') || '（无）'),
    '【已有事实】' + (facts.map((m) => m.content).join('\n') || '（无）'),
    '【已有特质】' + (profile.map((m) => m.content).join('\n') || '（无）'),
    '【已有身份】' + (existingIdentity.map((f) => `${f.field}：${f.value}`).join('、') || '（无）'),
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
    return { factsWritten: 0, identityWritten: 0, profileWritten: 0, facts: [], identity: [], profile: [] };
  }

  let factsWritten = 0;
  const writtenFacts: string[] = [];
  for (const f of out.facts) {
    const content = (f.content ?? '').trim();
    if (!content) continue;
    try {
      await store.write(personaName, userId, { kind: 'fact', content, entityId: f.entityId?.trim() || null });
      factsWritten++;
      writtenFacts.push(content);
    } catch (e) {
      console.warn('[reflect] 写 fact 失败：', e);
    }
  }

  // 结构化身份：单值覆盖（UPSERT）。
  let identityWritten = 0;
  const idFields = out.identity.filter((f) => (f.field ?? '').trim() && (f.value ?? '').trim());
  if (idFields.length > 0) {
    try {
      await identity.upsert(personaName, userId, idFields);
      identityWritten = idFields.length;
    } catch (e) {
      console.warn('[reflect] 写 identity 失败：', e);
    }
  }

  let profileWritten = 0;
  const writtenProfiles: string[] = [];
  for (const s of out.profile) {
    const content = (s ?? '').trim();
    if (!content) continue;
    try {
      await store.write(personaName, userId, { kind: 'profile', content });
      profileWritten++;
      writtenProfiles.push(content);
    } catch (e) {
      console.warn('[reflect] 写 profile 失败：', e);
    }
  }

  // 硬上限：特质强制在场，必须控量，超了归档最旧（不硬删，可审计）。
  if (profileWritten > 0) {
    try {
      await store.prune(personaName, userId, 'profile', maxProfile);
    } catch (e) {
      console.warn('[reflect] 裁剪 profile 失败：', e);
    }
  }

  return { factsWritten, identityWritten, profileWritten, facts: writtenFacts, identity: idFields, profile: writtenProfiles };
}

// 纯函数：从反思输出里抽 { facts, identity, profile }，非法/缺失返回空。可单测。
export function parseReflection(raw: string): ReflectionOutput {
  const o = parseJsonish(raw);
  if (!o) return { facts: [], identity: [], profile: [] };
  const facts = Array.isArray(o.facts)
    ? o.facts.map((f) => {
        const x = (f ?? {}) as Record<string, unknown>;
        return { content: String(x.content ?? ''), entityId: String(x.entityId ?? '') };
      })
    : [];
  const identity = Array.isArray(o.identity)
    ? o.identity.map((f) => {
        const x = (f ?? {}) as Record<string, unknown>;
        return { field: String(x.field ?? ''), value: String(x.value ?? '') };
      })
    : [];
  const profile = Array.isArray(o.profile) ? o.profile.map((s) => String(s)) : [];
  return { facts, identity, profile };
}
