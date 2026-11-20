import type { Frame, MemoryKind, MemoryStore, GrowthGoalStore, SelfAddedStore } from '@mirror/contracts';
import type { DeepSeek } from '../../llm/deepseek';
import type { Embedder } from '../../llm/embedding';
import type { PrefetchCache } from '../assemble';
import { consolidateTurn, prefetchNextTurn } from './memoryTurn';
import { consolidateGoal } from './goalTurn';
import { consolidateSelfAdded, touchSelfAdded, SELF_ADDED_TTL_DAYS } from './selfAddTurn';

// 一轮结束后的「后台巩固」总入口：把散落在 session.ts 里的 6 个 fire-and-forget 归拢成一个调用。
// - 主写 consolidateTurn（await）：抽取 + 分类兜底 + 落库，返回本轮写入 id + 事实（供会话「小笔记本」用）。
// - 其余（预取 / 课题巩固 / 人设增补 / 提及检测 / 过期归档）全部 best-effort、失败只告警不阻断。
// 不阻塞热路径：调用方 `.then/.catch` 处理主写结果，其余后台跑。

export type AfterTurnDeps = {
  llm: DeepSeek;
  model: string;
  memory: MemoryStore;
  goals: GrowthGoalStore;
  selfAdded: SelfAddedStore;
  embedder: Embedder;
  classify: (raw: string) => Promise<MemoryKind | null>;
  userId: string;
  characterId: string;
  userText: string;
  agentText: string;
  personaSystemPrompt: string;
  frame: Frame;           // coach 时额外巩固课题
  prefetchCache: PrefetchCache;
  retractIds: string[];   // 上一轮写入的记忆 id（本轮纠正时先精确撤销）
};

export async function consolidateAfterTurn(deps: AfterTurnDeps): Promise<{ writtenIds: string[]; facts: string[] }> {
  const {
    llm, model, memory, goals, selfAdded, embedder, classify,
    userId, characterId, userText, agentText, personaSystemPrompt, frame, prefetchCache, retractIds,
  } = deps;

  // 主写（await）：返回本轮写入 id + 事实，供会话更新 prevTurnMemoryIds / userSaid。
  const main = consolidateTurn({
    llm, model, store: memory, classify, userId, characterId, userText, agentText, retractIds,
  });

  // 其余后台巩固：fire-and-forget。
  prefetchNextTurn({ store: memory, userId, characterId, query: userText }, prefetchCache)
    .catch((e) => console.warn('[memory] 后台预取失败：', e));
  if (frame === 'coach') {
    consolidateGoal({ llm, model, store: goals, userId, characterId, userText, agentText })
      .catch((e) => console.warn('[goal] 后台课题巩固失败：', e));
  }
  consolidateSelfAdded({ llm, model, store: selfAdded, userId, characterId, agentText, personaSystemPrompt, embedder })
    .catch((e) => console.warn('[self-add] 后台写增补失败：', e));
  touchSelfAdded({ embedder, store: selfAdded, userId, characterId, text: `${userText}\n${agentText}` })
    .catch((e) => console.warn('[self-add] 后台提及检测失败：', e));
  selfAdded.archiveStale(characterId, userId, SELF_ADDED_TTL_DAYS)
    .catch((e) => console.warn('[self-add] 归档过期失败：', e));

  return main;
}
