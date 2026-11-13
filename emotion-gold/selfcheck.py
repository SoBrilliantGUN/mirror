"""自检 —— 不依赖 API / 词典，验证 schema / stratify / agreement 三个纯逻辑模块。

用法：python emotion-gold/selfcheck.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from schema import Sample, VAD, ConsistencyLevel, save, load  # noqa: E402
from stratify import stratify, summarize  # noqa: E402
from agreement import agree  # noqa: E402


def make_sample(id_: str, valence_text, arousal_text, valence_audio, arousal_audio):
    return Sample(
        id=id_, text=f"台词{id_}",
        text_vad=VAD(valence_text, arousal_text, 0.5),
        audio_vad=VAD(valence_audio, arousal_audio, 0.5),
    )


def test_schema():
    # 逞强：字面正向，真实负面高唤起 → incongruence=true
    s = make_sample("a", 0.8, 0.3, 0.2, 0.9)
    assert s.incongruence is True, s.incongruence
    assert s.consistency_level == ConsistencyLevel.STRONG_MISMATCH
    assert s.affect.valence == 0.2, "不一致时 affect 应信语气"
    # 一致：字面负面，真实也负面
    c = make_sample("b", 0.2, 0.7, 0.25, 0.65)
    assert c.incongruence is False
    assert c.consistency_level == ConsistencyLevel.CONGRUENT
    # 往返
    save([s, c], "_tmp.jsonl")
    loaded = load("_tmp.jsonl")
    os.remove("_tmp.jsonl")
    assert len(loaded) == 2 and loaded[0].incongruence == True
    print("[ok] schema：双通道 VAD / 不一致推导 / affect / 往返")


def test_stratify():
    pool = []
    for i in range(100):  # 逞强（稀有）
        pool.append(make_sample(f"s{i}", 0.8, 0.2, 0.2, 0.9))
    for i in range(300):  # 一致
        pool.append(make_sample(f"c{i}", 0.8, 0.7, 0.8, 0.7))
    picked = stratify(pool, n=50, seed=1)
    dist = summarize(picked)
    strong = dist["strong"][1]
    print(f"[ok] stratify：50 条中 strong={dist['strong'][0]} ({strong:.0%})", "| 分布", summarize(picked))
    assert strong >= 0.3, "应超额采到不一致样本"


def test_agreement():
    gold = [make_sample("1", 0.8, 0.3, 0.2, 0.9),
            make_sample("2", 0.2, 0.7, 0.25, 0.65),
            make_sample("3", 0.5, 0.5, 0.5, 0.5)]
    # 自动打分：前两条对，第三条错（把一致误判成不一致）
    auto = [make_sample("1", 0.8, 0.3, 0.2, 0.9),
            make_sample("2", 0.2, 0.7, 0.25, 0.65),
            Sample(id="3", text="台词3", text_vad=VAD(0.5, 0.5, 0.5), audio_vad=VAD(0.1, 0.9, 0.5))]
    rep = agree(gold, auto)
    assert rep["matched"] == 3
    assert abs(rep["incongruence_accuracy"] - 2 / 3) < 0.001, rep
    print("[ok] agreement：", rep)


if __name__ == "__main__":
    test_schema()
    test_stratify()
    test_agreement()
    print("全部通过 ✓")
