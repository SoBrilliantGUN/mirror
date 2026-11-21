import type { IdentityStore, MemoryKind, MemoryStore } from '@mirror/contracts';
import type { DeepSeek } from '../../llm/deepseek';
import type { Embedder } from '../../llm/embedding';
import { cosine } from '../../vector';
import { reflectOnMemory } from './reflect';
import { parseJsonish } from '../parse';

// 做梦（空闲时自动巩固记忆）——三步：
// ① 抽象升级：episodic → fact + 结构化身份 identity + 软特质 profile（复用 reflect 的高层综合）；
// ② 合并去重：同型里语义近重复的记忆，保留最早、归档其余（确定性，不烧 LLM）；
// ③ 清理矛盾：LLM 找出互相冲突/已被推翻的 fact/preference/persona，归档被取代的那条。
// 全部 best-effort，失败只告警不阻断；软删除（superseded），可审计不硬删。

const MERGE_SIM = 0.9; // 合并阈值：余弦相似度达到即视为同一事实的近重复（对齐写入侧 DUP_SIM=0.9；实测真近重复≈0.88~0.95，0.95 会全漏）

// 做梦做了什么——不仅计数，还有实际内容（前端展示用）。
export type DreamDetails = {
  facts: string[];                        // 抽出的近况（内容）
  identity: { field: string; value: string }[]; // 抽出的身份字段
  profile: string[];                      // 抽出的性格观察（内容）
  merged: string[];                       // 被合并掉的重复记忆内容
  resolved: string[];                     // 被清理掉的过时记忆内容
};

export type DreamResult = {
  abstractedFacts: number;
  abstractedIdentity: number;
  abstractedProfile: number;
  merged: number;
  resolved: number;
  details: DreamDetails;
};

export async function dreamOnMemory(deps: {
  llm: DeepSeek;
  model: string;
  store: MemoryStore;
  identity: IdentityStore;
  embedder: Embedder;
  userId: string;
  personaName: string;
}): Promise<DreamResult> {
  const { llm, model, store, identity, embedder, userId, personaName } = deps;

  // ① 抽象升级
  let abstractedFacts = 0;
  let abstractedIdentity = 0;
  let abstractedProfile = 0;
  let learnedFacts: string[] = [];
  let learnedIdentity: { field: string; value: string }[] = [];
  let learnedProfile: string[] = [];
  try {
    const r = await reflectOnMemory({ llm, model, store, identity, userId, personaName });
    abstractedFacts = r.factsWritten;
    abstractedIdentity = r.identityWritten;
    abstractedProfile = r.profileWritten;
    learnedFacts = r.facts;
    learnedIdentity = r.identity;
    learnedProfile = r.profile;
  } catch (e) {
    console.warn('[dream] 抽象升级失败：', e);
  }

  // ② 合并去重（确定性，逐型）
  let merged = 0;
  const mergedContents: string[] = [];
  for (const kind of ['fact', 'preference', 'episodic', 'profile'] as MemoryKind[]) {
    try {
      const list = await store.listAll(personaName, userId, { kind });
      if (list.length < 2) continue;
      const embs = await embedder.embed(list.map((m) => m.content));
      const ordered = list
        .map((m, i) => ({ m, emb: embs[i] }))
        .sort((a, b) => a.m.createdAt.localeCompare(b.m.createdAt));
      for (let i = 0; i < ordered.length; i++) {
        for (let j = i + 1; j < ordered.length; j++) {
          if (cosine(ordered[i].emb, ordered[j].emb) >= MERGE_SIM) {
            await store.remove(personaName, userId, ordered[j].m.id);
            merged++;
            mergedContents.push(ordered[j].m.content);
          }
        }
      }
    } catch (e) {
      console.warn(`[dream] 合并去重失败（${kind}）：`, e);
    }
  }

  // ③ 清理矛盾（LLM）
  let resolved = 0;
  let resolvedContents: string[] = [];
  try {
    const rr = await resolveContradictions({ llm, model, store, userId, personaName });
    resolved = rr.removed;
    resolvedContents = rr.contents;
  } catch (e) {
    console.warn('[dream] 清理矛盾失败：', e);
  }

  return {
    abstractedFacts, abstractedIdentity, abstractedProfile, merged, resolved,
    details: { facts: learnedFacts, identity: learnedIdentity, profile: learnedProfile, merged: mergedContents, resolved: resolvedContents },
  };
}

async function resolveContradictions(deps: {
  llm: DeepSeek;
  model: string;
  store: MemoryStore;
  userId: string;
  personaName: string;
}): Promise<{ removed: number; contents: string[] }> {
  const { llm, model, store, userId, personaName } = deps;
  const all: { id: string; kind: MemoryKind; content: string }[] = [];
  for (const kind of ['fact', 'preference', 'profile'] as MemoryKind[]) {
    const list = await store.listAll(personaName, userId, { kind });
    all.push(...list.map((m) => ({ id: m.id, kind: m.kind, content: m.content })));
  }
  if (all.length < 2) return { removed: 0, contents: [] };

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
  const contents: string[] = [];
  for (const n of ids) {
    const target = all[n - 1];
    if (!target) continue;
    await store.remove(personaName, userId, target.id);
    removed++;
    contents.push(target.content);
  }
  return { removed, contents };
}

function parseSupersede(raw: string): number[] {
  const o = parseJsonish(raw);
  if (!o) return [];
  const arr = Array.isArray(o.supersede) ? (o.supersede as unknown[]) : [];
  return arr.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
}
