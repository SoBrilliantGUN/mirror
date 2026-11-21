import type { Frame, MemoryKind, MemoryStore, GrowthGoalStore, SelfAddedStore } from '@mirror/contracts';
import type { DeepSeek } from '../../llm/deepseek';
import type { Embedder } from '../../llm/embedding';
import type { PrefetchCache } from '../assemble';
import { consolidateTurn, prefetchNextTurn } from './memoryTurn';
import { consolidateGoal } from './goalTurn';
import { consolidateSelfAdded, touchSelfAdded, SELF_ADDED_TTL_DAYS } from './selfAddTurn';

// consolidate/ 目录：一轮结束后的「后台巩固」。本文件是唯一对外入口（consolidateAfterTurn），
// 把散落在 session.ts 里的多个 fire-and-forget 归拢成一个调用。文件关系图：
//
//   index.ts（本文件，每轮结束后触发）
//     ├─ await 主写   consolidateTurn（memoryTurn.ts）── 抽取 + 分类兜底 + 落库，返回写入 id + 事实
//     └─ best-effort（失败只告警，不阻断）：
//         ├─ prefetchNextTurn（memoryTurn.ts）── look-ahead 预取下一轮记忆
//         ├─ consolidateGoal（goalTurn.ts）──── 教练轮结束巩固课题（frame=coach 才跑）
//         ├─ consolidateSelfAdded（selfAddTurn.ts）── 抽取陪伴者自己的软细节
//         ├─ touchSelfAdded（selfAddTurn.ts）──── 提及驱动衰减
//         └─ selfAdded.archiveStale ──────────── 过期归档
//   dream.ts（空闲时触发，非每轮）── dreamOnMemory：抽象升级(reflect) + 合并去重 + 清理矛盾
//
// 主写（consolidateTurn）await 拿结果（供会话更新 prevTurnMemoryIds / userSaid），其余后台跑。

export type AfterTurnDeps = {
  llm: DeepSeek;
  model: string;
  memory: MemoryStore;
  goals: GrowthGoalStore;
  selfAdded: SelfAddedStore;
  embedder: Embedder;
  classify: (raw: string) => Promise<MemoryKind | null>;
  userId: string;
  personaName: string;
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
    userId, personaName, userText, agentText, personaSystemPrompt, frame, prefetchCache, retractIds,
  } = deps;

  // 主写（await）：返回本轮写入 id + 事实，供会话更新 prevTurnMemoryIds / userSaid。
  const main = consolidateTurn({
    llm, model, store: memory, classify, userId, personaName, userText, agentText, retractIds,
  });

  // 其余后台巩固：fire-and-forget。
  prefetchNextTurn({ store: memory, userId, personaName, query: userText }, prefetchCache)
    .catch((e) => console.warn('[memory] 后台预取失败：', e));
  if (frame === 'coach') {
    consolidateGoal({ llm, model, store: goals, userId, personaName, userText, agentText })
      .catch((e) => console.warn('[goal] 后台课题巩固失败：', e));
  }
  consolidateSelfAdded({ llm, model, store: selfAdded, userId, personaName, agentText, personaSystemPrompt, embedder })
    .catch((e) => console.warn('[self-add] 后台写增补失败：', e));
  touchSelfAdded({ embedder, store: selfAdded, userId, personaName, text: `${userText}\n${agentText}` })
    .catch((e) => console.warn('[self-add] 后台提及检测失败：', e));
  selfAdded.archiveStale(personaName, userId, SELF_ADDED_TTL_DAYS)
    .catch((e) => console.warn('[self-add] 归档过期失败：', e));

  return main;
}
