"""对账 —— 人工金标 vs LLM 自动打分，算 VAD 三维 MAE/相关系数 + incongruence 准确率/kappa。

这 N 条人工金标「一鱼两吃」：既是最终测试真值，又反推自动打分有多准。
输入两份 JSONL（按 id 对齐），输出 report dict。
"""
from __future__ import annotations

from schema import Sample


def _pearson(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    if dx == 0 or dy == 0:
        return 0.0
    return num / (dx * dy)


def _kappa(a: list[bool], b: list[bool]) -> float:
    n = len(a)
    if n == 0:
        return 0.0
    po = sum(1 for x, y in zip(a, b) if x == y) / n
    pa = sum(a) / n
    pb = sum(b) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    return (po - pe) / (1 - pe) if pe < 1 else 0.0


def agree(gold: list[Sample], auto: list[Sample]) -> dict:
    auto_by_id = {s.id: s for s in auto}
    dims = ("valence", "arousal", "dominance")

    gold_vals = {d: [] for d in dims}
    auto_vals = {d: [] for d in dims}
    inc_gold: list[bool] = []
    inc_auto: list[bool] = []

    for g in gold:
        a = auto_by_id.get(g.id)
        if a is None:
            continue
        for d in dims:
            gold_vals[d].append(getattr(g.affect, d))
            auto_vals[d].append(getattr(a.affect, d))
        inc_gold.append(bool(g.incongruence))
        inc_auto.append(bool(a.incongruence))

    matched = len(inc_gold)
    mae = {
        d: round(sum(abs(g - a) for g, a in zip(gold_vals[d], auto_vals[d])) / matched, 3)
        if matched else None
        for d in dims
    }
    corr = {d: round(_pearson(gold_vals[d], auto_vals[d]), 3) for d in dims}
    inc_acc = round(sum(1 for x, y in zip(inc_gold, inc_auto) if x == y) / matched, 3) if matched else 0.0
    inc_kappa = round(_kappa(inc_gold, inc_auto), 3)

    return {
        "matched": matched,
        "mae": mae,
        "pearson": corr,
        "incongruence_accuracy": inc_acc,
        "incongruence_kappa": inc_kappa,
        "incongruence_counts": {
            "gold_true": sum(inc_gold),
            "gold_false": matched - sum(inc_gold),
            "auto_true": sum(inc_auto),
            "auto_false": matched - sum(inc_auto),
        },
    }
