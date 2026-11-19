import type { SelfAdded, SelfAddedStore } from '@mirror/contracts';
import type { DeepSeek } from '../llm/deepseek';
import type { Embedder } from '../llm/embedding';
import { cosine } from '../persona/loadPersona';
import { parseJsonish } from './parse';

// 人设增补（后台 Agent，不进热路径）：把「陪伴者自己长出的软细节」固化下来。
// - consolidateSelfAdded：一轮结束后，从「陪伴者这一轮回复」里抽「关于他自己的新软细节」
//   （爱好/口味/小回忆/习惯），带角色卡底座 + 已有增补做冲突自检，通过才落库。
// - touchSelfAdded：提及驱动衰减——用语义匹配判断本轮对话「触碰」了哪些已有增补，刷新活跃度；
//   长期不提及的由 store.archiveStale 归档（用户自己都忘了，退场无感知，不算「你变了」）。

export const SELF_ADDED_TTL_DAYS = 30;       // 长期不提及 → 30 天后归档
export const MENTION_SIM_THRESHOLD = 0.5;    // 提及检测的余弦阈值
const DUP_SIM_THRESHOLD = 0.9;               // 去重阈值：与已有增补近重复则不写

const EXTRACT_SYSTEM_PROMPT = `你是「陪伴者人设增补」助手。读「陪伴者这一轮回复 + 角色卡底座 + 已有增补」，判断陪伴者是否在回复里自然说出了一个新的、关于他自己的软细节（爱好/口味/小回忆/习惯）。只输出 JSON，不要解释、不要 markdown。

规则：
1. 只抽「陪伴者关于自己的、新的软细节」，用第三人称改写成一句具体陈述（如「喜欢爬山」「偏爱苦和酸的味道」）。
2. 必须是底座里没有、已有增补里也没有的新细节；重复的、空泛的（"我喜欢运动"这类没信息量的）不抽。
3. 严禁与底座冲突——底座是角色卡写死的职业/价值观/红线/关键经历，绝不推翻（底座是外科医生，就不能说晕血）。
4. 0~1 条，宁缺毋滥。没有就输出 null。

只输出这个 JSON：
{"added": {"category": "回忆|喜好|习惯|口味|其它", "content": "<一句话>"} | null}`;

export async function consolidateSelfAdded(deps: {
  llm: DeepSeek;
  model: string;
  store: SelfAddedStore;
  userId: string;
  characterId: string;
  agentText: string;
  personaSystemPrompt: string;
  embedder?: Embedder;
}): Promise<number> {
  const { llm, model, store, userId, characterId, agentText, personaSystemPrompt, embedder } = deps;
  if (!agentText.trim()) return 0;

  // 已有增补（供冲突自检 + 去重）。查询失败按无处理，不阻断。
  let existing: SelfAdded[] = [];
  try {
    existing = await store.listActive(characterId, userId);
  } catch (e) {
    console.warn('[self-add] 查已有增补失败，按无处理：', e);
  }

  const existingBlock = existing.length
    ? existing.map((s) => `- [${s.category}] ${s.content}`).join('\n')
    : '（无）';

  let parsed: { category: string; content: string } | null = null;
  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `【角色卡底座】${personaSystemPrompt}`,
            `【已有增补】\n${existingBlock}`,
            `【陪伴者这一轮回复】${agentText}`,
          ].join('\n\n'),
        },
      ],
      { model, temperature: 0, maxTokens: 200 },
    );
    parsed = parseSelfAdded(raw);
  } catch (e) {
    console.warn('[self-add] 抽取失败，跳过：', e);
    return 0;
  }

  if (!parsed) return 0;
  const content = parsed.content.trim();
  if (!content) return 0;

  // 程序兜底去重：与已有增补语义近重复则不写（LLM 自检之外的确定性保险）。
  if (embedder && existing.length > 0) {
    try {
      const [qv] = await embedder.embed([content]);
      const vecs = await embedder.embed(existing.map((s) => s.content));
      const maxSim = Math.max(...existing.map((_, i) => cosine(qv, vecs[i])));
      if (maxSim >= DUP_SIM_THRESHOLD) {
        console.log('[self-add] 与已有增补近重复，跳过：', content);
        return 0;
      }
    } catch (e) {
      console.warn('[self-add] 去重向量失败，放行：', e);
    }
  }

  try {
    await store.write(characterId, userId, { category: parsed.category, content });
    return 1;
  } catch (e) {
    console.warn('[self-add] 写增补失败：', e);
    return 0;
  }
}

// 纯函数：解析抽取输出 { added }，非法/缺失返回 null。可单测。
export function parseSelfAdded(raw: string): { category: string; content: string } | null {
  const o = parseJsonish(raw);
  if (!o) return null;
  const added = o.added as Record<string, unknown> | null | undefined;
  if (!added) return null;
  const content = String(added.content ?? '').trim();
  if (!content) return null;
  const category = String(added.category ?? '').trim() || '其它';
  return { category, content };
}

// 提及驱动衰减：用本轮对话文本做语义匹配，命中视为「提及」，刷新 last_mentioned_at。
// 长期不被提及的由调用方 archiveStale 归档。best-effort，失败不阻断。
export async function touchSelfAdded(deps: {
  embedder: Embedder;
  store: SelfAddedStore;
  userId: string;
  characterId: string;
  text: string;
}): Promise<number> {
  const { embedder, store, userId, characterId, text } = deps;
  if (!text.trim()) return 0;
  const active = await store.listActive(characterId, userId);
  if (active.length === 0) return 0;
  try {
    const [qv] = await embedder.embed([text]);
    const vecs = await embedder.embed(active.map((s) => s.content));
    const ids = active
      .filter((_, i) => cosine(qv, vecs[i]) >= MENTION_SIM_THRESHOLD)
      .map((s) => s.id);
    await store.touch(characterId, userId, ids);
    return ids.length;
  } catch (e) {
    console.warn('[self-add] 提及检测失败：', e);
    return 0;
  }
}
