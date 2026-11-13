"""层 A 金标测试集的数据模型 —— 对齐 scoreAffect 的输出。

产品里 scoreAffect 输出：
  affect          —— PAD 三维（效价 valence / 唤起 arousal / 支配 dominance）
  incongruence    —— 跨通道不一致 bool（文字 vs 声音 打架）
  acoustic / vocalizations —— 声学特征 / 哭笑事件

本文件定义金标样本 Schema，保证「LLM 自动打分」与「人工金标」同构、可对账。

效价/唤起/支配 均取 0~1 连续值（PAD 模型，1 端 = 正效价 / 高唤起 / 高支配）。
「不一致」由双通道 VAD 的距离量化：text_vad（字面） vs audio_vad（语气/真实）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict, field
from enum import Enum
from typing import Optional


class ConsistencyLevel(str, Enum):
    """跨通道一致性（比 bool 更细，可回退到 incongruence）。"""
    CONGRUENT = "congruent"       # 文字与语气一致
    WEAK_MISMATCH = "weak"        # 弱矛盾
    STRONG_MISMATCH = "strong"    # 强烈掩饰（嘴上没事、心里/声音在哭）


@dataclass
class VAD:
    """PAD 三维。0~1。"""
    valence: float
    arousal: float
    dominance: float

    def __post_init__(self):
        for name in ("valence", "arousal", "dominance"):
            v = float(getattr(self, name))
            if not (0.0 <= v <= 1.0):
                raise ValueError(f"{name} 越界: {v}（须 0~1）")
            setattr(self, name, round(v, 3))

    @staticmethod
    def distance(a: "VAD", b: "VAD") -> float:
        """两通道 VAD 的欧氏距离，衡量「不一致」程度。"""
        return round(((a.valence - b.valence) ** 2
                      + (a.arousal - b.arousal) ** 2
                      + (a.dominance - b.dominance) ** 2) ** 0.5, 3)

    @staticmethod
    def neutral() -> "VAD":
        return VAD(0.5, 0.3, 0.5)


# 距离 → 一致性分档的阈值（可调；人工金标可显式覆盖）
WEAK_THRESHOLD = 0.25
STRONG_THRESHOLD = 0.50


@dataclass
class Sample:
    id: str
    text: str
    text_vad: VAD          # 字面表达的情绪
    audio_vad: VAD         # 语气/真实情绪（文本样本=潜台词推断；音频样本=声学）
    # 以下可选，缺省由距离自动推导
    incongruence: Optional[bool] = None
    consistency_level: Optional[ConsistencyLevel] = None
    # 元信息
    speaker: Optional[str] = None
    context: Optional[str] = None      # 前文 / 舞台说明，供推断潜台词
    source: str = ""                   # 话剧 / 影视 / EmotionTalk / …
    has_audio: bool = False
    audio_path: Optional[str] = None
    rationale: Optional[str] = None    # 一句依据（自动打分带，金标可不带）
    human_gold: bool = False           # 是否人工金标

    def __post_init__(self):
        d = VAD.distance(self.text_vad, self.audio_vad)
        if self.consistency_level is None:
            if d < WEAK_THRESHOLD:
                self.consistency_level = ConsistencyLevel.CONGRUENT
            elif d < STRONG_THRESHOLD:
                self.consistency_level = ConsistencyLevel.WEAK_MISMATCH
            else:
                self.consistency_level = ConsistencyLevel.STRONG_MISMATCH
        if self.incongruence is None:
            self.incongruence = d >= WEAK_THRESHOLD

    @property
    def affect(self) -> VAD:
        """scoreAffect 应输出的「真实情绪判定」：不一致时信语气，一致时二者相同。"""
        return self.audio_vad if self.incongruence else self.text_vad

    def to_dict(self) -> dict:
        d = asdict(self)
        d["consistency_level"] = (
            self.consistency_level.value if self.consistency_level else None
        )
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Sample":
        d = dict(d)
        d["text_vad"] = VAD(**d["text_vad"])
        d["audio_vad"] = VAD(**d["audio_vad"])
        if d.get("consistency_level"):
            d["consistency_level"] = ConsistencyLevel(d["consistency_level"])
        return cls(**d)


def save(samples: list[Sample], path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s.to_dict(), ensure_ascii=False) + "\n")


def load(path: str) -> list[Sample]:
    samples = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                samples.append(Sample.from_dict(json.loads(line)))
    return samples
