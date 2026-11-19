import type { MemoryKind, MemoryStore } from '@mirror/contracts';
import type { DeepSeek } from '../llm/deepseek';
import type { Embedder } from '../llm/embedding';
import { reflectOnMemory } from './reflect';
import { parseJsonish } from './parse';

// 做梦（空闲时自动巩固记忆）——三步：
// ① 抽象升级：episodic → fact + persona（复用 reflect 的高层综合）；
// ② 合并去重：同型里语义近重复的记忆，保留最早、归档其余（确定性，不烧 LLM）；
// ③ 清理矛盾：LLM 找出互相冲突/已被推翻的 fact/preference/persona，归档被取代的那条。
// 全部 best-effort，失败只告警不阻断；软删除（superseded），可审计不硬删。

const MERGE_SIM = 0.9; // 合并阈值：余弦相似度达到即视为同一事实的近重复（对齐写入侧 PERSONA_DUP_SIM=0.9；实测真近重复≈0.88~0.95，0.95 会全漏）

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export type DreamResult = {
  abstractedFacts: number;
  abstractedProfile: number;
  merged: number;
  resolved: number;
};

export async function dreamOnMemory(deps: {
  llm: DeepSeek;
  model: string;
  store: MemoryStore;
  embedder: Embedder;
  userId: string;
  characterId: string;
}): Promise<DreamResult> {
  const { llm, model, store, embedder, userId, characterId } = deps;

  // ① 抽象升级
  let abstractedFacts = 0;
  let abstractedProfile = 0;
  try {
    const r = await reflectOnMemory({ llm, model, store, userId, characterId });
    abstractedFacts = r.factsWritten;
    abstractedProfile = r.profileWritten;
  } catch (e) {
    console.warn('[dream] 抽象升级失败：', e);
  }

  // ② 合并去重（确定性，逐型）
  let merged = 0;
  for (const kind of ['fact', 'preference', 'episodic', 'profile'] as MemoryKind[]) {
    try {
      const list = await store.listAll(characterId, userId, { kind });
      if (list.length < 2) continue;
      const embs = await embedder.embed(list.map((m) => m.content));
      const ordered = list
        .map((m, i) => ({ m, emb: embs[i] }))
        .sort((a, b) => a.m.createdAt.localeCompare(b.m.createdAt));
      for (let i = 0; i < ordered.length; i++) {
        for (let j = i + 1; j < ordered.length; j++) {
          if (cosine(ordered[i].emb, ordered[j].emb) >= MERGE_SIM) {
            await store.remove(characterId, userId, ordered[j].m.id);
            merged++;
          }
        }
      }
    } catch (e) {
      console.warn(`[dream] 合并去重失败（${kind}）：`, e);
    }
  }

  // ③ 清理矛盾（LLM）
  let resolved = 0;
  try {
    resolved = await resolveContradictions({ llm, model, store, userId, characterId });
  } catch (e) {
    console.warn('[dream] 清理矛盾失败：', e);
  }

  return { abstractedFacts, abstractedProfile, merged, resolved };
}

async function resolveContradictions(deps: {
  llm: DeepSeek;
  model: string;
  store: MemoryStore;
  userId: string;
  characterId: string;
}): Promise<number> {
  const { llm, model, store, userId, characterId } = deps;
  const all: { id: string; kind: MemoryKind; content: string }[] = [];
  for (const kind of ['fact', 'preference', 'profile'] as MemoryKind[]) {
    const list = await store.listAll(characterId, userId, { kind });
    all.push(...list.map((m) => ({ id: m.id, kind: m.kind, content: m.content })));
  }
  if (all.length < 2) return 0;

  const numbered = all.map((m, i) => `${i + 1}. [${m.kind}] ${m.content}`).join('\n');
  const system =
    '你是记忆清理助手。读下面这份「关于对方」的记忆列表，找出互相矛盾、或已被后来发生的事推翻（过时）的条目。只输出需要作废的那一条的编号（矛盾里更旧/更不可能成立的那条）。没有矛盾就输出空数组。只输出 JSON：\n{"supersede": [<编号数字>]}';
  const raw = await llm.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: numbered },
    ],
    { model, temperature: 0, maxTokens: 200 },
  );
  const ids = parseSupersede(raw);
  let removed = 0;
  for (const n of ids) {
    const target = all[n - 1];
    if (!target) continue;
    await store.remove(characterId, userId, target.id);
    removed++;
  }
  return removed;
}

function parseSupersede(raw: string): number[] {
  const o = parseJsonish(raw);
  if (!o) return [];
  const arr = Array.isArray(o.supersede) ? (o.supersede as unknown[]) : [];
  return arr.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
}
