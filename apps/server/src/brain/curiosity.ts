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
};

// 每个维度的评分明细（记录进聊天记录，便于后续调权重）。
export type ScoredDimension = {
  dimension: string;
  understanding: number; // 了解程度（越低越好，这里已转成越高越好）
  freshness: number;     // 新鲜感（越近越高）
  interest: number;      // 兴趣（越深越高）
  score: number;         // 三者简单相加
};

export type CuriosityResult = CuriosityPick & { scored: ScoredDimension[] };

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
}): Promise<CuriosityResult | null> {
  const rng = deps.rng ?? Math.random;
  const dims = allTopicDimensions();

  // 1. 每个维度算分（三值简单相加），明细一并保留供记录
  const scored: ScoredDimension[] = dims.map((d) => {
    const understanding = understandingScore(deps.coverage, d.dimension);
    const freshness = freshnessScore(deps.latestEventAt.get(d.dimension) ?? null);
    const interest = deps.engagement.get(d.dimension) ?? 0;
    return { dimension: d.dimension, understanding, freshness, interest, score: understanding + freshness + interest };
  });

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
        candidates.push({ id: q.id, dimension: dim.dimension, aspect: a.aspect, question: q.text });
      }
    }
  }
  if (candidates.length === 0) return null;

  // 4. 随机选一个
  return { ...candidates[Math.floor(rng() * candidates.length)], scored };
}
