// 好奇心机制：三个值简单相加 → 维度分数 → 加权随机选一个维度 → 维度下随机选一个未回答话题。
// 三个值：
//   了解程度 = 该维度覆盖数越少越高（1/(1+count)）
//   新鲜感   = 该维度最近一次「事情实际发生的时间」距今越近越高（30 天线性衰减）
//   兴趣     = 该维度下自由主题深入聊过的会话数（topic_engagements 归维度后聚合）
import type { CoverageEntry, Memory } from '@mirror/contracts';
import { allTopicDimensions, getTopicDimension } from '../topics';

export type CuriosityPick = {
  id: string;
  dimension: string;
  aspect: string;
  question: string;
  material: string;
};

// 了解程度：覆盖数越少越高（0 覆盖 = 1，覆盖越多趋近 0）。
function understandingScore(coverage: CoverageEntry[], dimension: string): number {
  const count = coverage.filter((c) => c.dimension === dimension).reduce((n, c) => n + c.count, 0);
  return 1 / (1 + count);
}

// 新鲜感：最新事件时间距今越近越高（30 天内线性衰减到 0）。
function freshnessScore(latestEventAt: string | null): number {
  if (!latestEventAt) return 0;
  const days = (Date.now() - new Date(latestEventAt).getTime()) / 86_400_000;
  return Math.max(0, 1 - days / 30);
}

// 从「带时间锚点的记忆」里聚出每个维度的最新「绝对事件时间」（新鲜感用）。
export function latestEventByDimension(memories: Memory[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const m of memories) {
    if (m.anchor?.kind !== 'absolute' || !m.dimension) continue;
    const at = m.anchor.at;
    const prev = map.get(m.dimension);
    if (prev == null || at > prev) map.set(m.dimension, at);
  }
  return map;
}

export async function pickCuriosityTopic(deps: {
  coverage: CoverageEntry[];
  engagement: Map<string, number>;           // dimension → 深入聊过的会话数
  latestEventAt: Map<string, string | null>; // dimension → 最新事件时间（YYYY-MM-DD 或 null）
  askedIds: Set<string>;
  rng?: () => number;
}): Promise<CuriosityPick | null> {
  const rng = deps.rng ?? Math.random;
  const dims = allTopicDimensions();

  // 1. 每个维度算分（三值简单相加）
  const scored = dims.map((d) => ({
    dimension: d.dimension,
    score:
      understandingScore(deps.coverage, d.dimension) +
      freshnessScore(deps.latestEventAt.get(d.dimension) ?? null) +
      (deps.engagement.get(d.dimension) ?? 0),
  }));

  // 2. 加权随机选一个维度（分数全 0 时退化为均匀随机）
  const total = scored.reduce((n, s) => n + s.score, 0);
  let pickedDim = scored[0].dimension;
  if (total <= 0) {
    pickedDim = scored[Math.floor(rng() * scored.length)].dimension;
  } else {
    let r = rng() * total;
    for (const s of scored) {
      r -= s.score;
      if (r <= 0) { pickedDim = s.dimension; break; }
    }
  }

  // 3. 懒加载该维度 → 收集未回答的问题
  const dim = getTopicDimension(pickedDim);
  if (!dim) return null;
  const candidates: CuriosityPick[] = [];
  for (const a of dim.aspects) {
    for (const q of a.questions) {
      if (!deps.askedIds.has(q.id)) {
        candidates.push({ id: q.id, dimension: dim.dimension, aspect: a.aspect, question: q.text, material: q.material });
      }
    }
  }
  if (candidates.length === 0) return null;

  // 4. 随机选一个
  return candidates[Math.floor(rng() * candidates.length)];
}
