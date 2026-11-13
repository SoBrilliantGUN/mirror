"""分层抽样 —— 从自动打分的大池子里挑 N 条人工金标，重点保住「不一致/逞强」稀有样本。

随机抽 500 会严重稀释 incongruence（真实对话里逞强约占 5~15%），
所以按 consistency_level + VAD 象限分层，超额采 strong mismatch。
"""
from __future__ import annotations

import random
from typing import Optional

from schema import Sample, ConsistencyLevel

# 默认配额（可传参覆盖）
DEFAULT_BUDGET = {
    ConsistencyLevel.STRONG_MISMATCH: 0.40,  # 杀手锏，重点保
    ConsistencyLevel.WEAK_MISMATCH: 0.20,
    ConsistencyLevel.CONGRUENT: 0.40,
}


def _quadrant(s: Sample) -> str:
    """VAD 象限：效价高低 × 唤起高低。用于把 congruent 铺开，防止全抽到同一种。"""
    v = "pos" if s.affect.valence >= 0.5 else "neg"
    a = "hi" if s.affect.arousal >= 0.5 else "lo"
    return f"{v}-{a}"


def _pick_congruent(pool: list[Sample], target: int, rng: random.Random) -> list[Sample]:
    """congruent 里按 VAD 象限轮转抽取，保证情绪覆盖。"""
    by_quad: dict[str, list[Sample]] = {}
    for s in pool:
        by_quad.setdefault(_quadrant(s), []).append(s)
    quad_pools = [list(q) for q in by_quad.values()]
    for q in quad_pools:
        rng.shuffle(q)
    selected: list[Sample] = []
    idx = 0
    while len(selected) < target and any(quad_pools):
        q = quad_pools[idx % len(quad_pools)]
        if q:
            selected.append(q.pop())
        idx += 1
        if idx > 100 * max(target, 1) + len(quad_pools):  # 防死循环
            break
    return selected


def stratify(samples: list[Sample], n: int = 500,
             budget: Optional[dict] = None, seed: int = 42) -> list[Sample]:
    budget = budget or DEFAULT_BUDGET
    rng = random.Random(seed)

    by_level: dict[ConsistencyLevel, list[Sample]] = {lv: [] for lv in budget}
    for s in samples:
        if s.consistency_level in by_level:
            by_level[s.consistency_level].append(s)

    picked: list[Sample] = []
    for lv, ratio in budget.items():
        target = int(round(n * ratio))
        pool = by_level[lv]
        if not pool:
            continue
        if lv == ConsistencyLevel.CONGRUENT:
            picked.extend(_pick_congruent(pool, target, rng)[:target])
        else:
            rng.shuffle(pool)
            picked.extend(pool[:target])

    # 若某桶不足，用剩余样本补齐
    remaining = [s for s in samples if s not in picked]
    if len(picked) < n:
        rng.shuffle(remaining)
        picked.extend(remaining[: n - len(picked)])
    return picked[:n]


def summarize(samples: list[Sample]) -> dict:
    """抽样后分布统计，供核对。"""
    counts = {lv.value: 0 for lv in ConsistencyLevel}
    for s in samples:
        counts[s.consistency_level.value] += 1
    total = len(samples)
    return {k: (v, round(v / total, 3) if total else 0) for k, v in counts.items()}
