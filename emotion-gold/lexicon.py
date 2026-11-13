"""词典锚点 —— 用现成情感词典给文本打 VAD 底，替代「从零编造」。

三层锚定（见 README）：
  L1 词级骨架：大连理工情感词汇本体（DUTIR）—— 类别 + 强度 + 极性 → 粗略 valence/arousal
  L2 词级补 VAD：NRC-VAD（英文）—— Valence/Arousal/Dominance 三维 0~1 连续值
  L3 句级锚点：EmotionTalk 的 5 维情感 / continuous label（另在采集阶段用，不在此模块）

词典只是「锚点」而非最终真值；最终金标 = LLM 打底 + 人工校对。

词典文件请自行放到 emotion-gold/lexicons/ 下：
  dutir.csv   —— 大连理工情感词汇本体（表头需含：词语/词、极性、强度；情感分类可选）
  nrc_vad.csv —— NRC-VAD（表头：Word, Valence, Arousal, Dominance）
缺文件时相应词典为空，anchor_vad 返回 None，不影响主流程。
"""
from __future__ import annotations

import csv
import os
from typing import Optional

from schema import VAD

LEXICON_DIR = os.path.join(os.path.dirname(__file__), "lexicons")

# DUTIR 极性 → 基准效价（0中性 1褒 2贬 3褒贬兼有）
_DUTIR_POLARITY_VALENCE = {0: 0.5, 1: 0.7, 2: 0.3, 3: 0.5}


def _norm(s: str) -> str:
    return s.strip()


# 内置中文情绪种子词（dutir.csv 缺失时的兜底锚点，非权威真值）
_BUILTIN_SEED: dict[str, tuple[float, float]] = {
    # 正面
    "开心": (0.8, 0.7), "高兴": (0.8, 0.7), "快乐": (0.85, 0.7), "喜悦": (0.85, 0.6),
    "幸福": (0.9, 0.5), "兴奋": (0.75, 0.9), "激动": (0.7, 0.9), "满意": (0.7, 0.4),
    "欣慰": (0.75, 0.45), "轻松": (0.7, 0.25), "平静": (0.6, 0.15), "安心": (0.7, 0.2),
    "温暖": (0.75, 0.35), "感动": (0.7, 0.6),
    # 悲伤
    "难过": (0.15, 0.6), "伤心": (0.1, 0.65), "悲伤": (0.1, 0.6), "痛苦": (0.05, 0.8),
    "绝望": (0.02, 0.9), "崩溃": (0.05, 0.95), "委屈": (0.15, 0.6), "心酸": (0.15, 0.55),
    "孤独": (0.2, 0.5), "空虚": (0.2, 0.4), "无助": (0.15, 0.6), "疲惫": (0.25, 0.3),
    # 愤怒
    "生气": (0.2, 0.8), "愤怒": (0.1, 0.9), "气死": (0.1, 0.9), "烦躁": (0.25, 0.7),
    "恼火": (0.2, 0.75), "讨厌": (0.25, 0.6),
    # 恐惧 / 焦虑
    "害怕": (0.2, 0.8), "恐惧": (0.15, 0.85), "焦虑": (0.3, 0.7), "担心": (0.35, 0.6),
    "紧张": (0.35, 0.7), "不安": (0.35, 0.6),
    # 中性
    "无所谓": (0.45, 0.2), "麻木": (0.4, 0.15), "淡然": (0.5, 0.15), "淡定": (0.55, 0.2),
}


def load_dutir(path: Optional[str] = None) -> dict[str, tuple[float, float]]:
    """返回 {词: (valence, arousal)}。强度映射到 arousal=强度/9，效价随强度外扩。"""
    path = path or os.path.join(LEXICON_DIR, "dutir.csv")
    lex: dict[str, tuple[float, float]] = {}
    if not os.path.exists(path):
        return dict(_BUILTIN_SEED)
    with open(path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        # 表头可能有别名
        col_word = _pick(reader.fieldnames or [], {"词语", "词", "word", "Word", "单词"})
        col_polarity = _pick(reader.fieldnames or [], {"极性", "polarity", "情感极性"})
        col_intensity = _pick(reader.fieldnames or [], {"强度", "intensity", "情感强度"})
        for row in reader:
            word = _norm(row.get(col_word, ""))
            if not word:
                continue
            try:
                pol = int(float(row.get(col_polarity, 0) or 0))
                iten = float(row.get(col_intensity, 5) or 5)
            except (TypeError, ValueError):
                pol, iten = 0, 5.0
            strength = min(1.0, iten / 9.0)
            base_valence = _DUTIR_POLARITY_VALENCE.get(pol, 0.5)
            valence = 0.5 + (base_valence - 0.5) * 2.0 * strength
            arousal = strength
            lex[word] = (round(valence, 3), round(arousal, 3))
    return lex


def load_nrc_vad(path: Optional[str] = None) -> dict[str, VAD]:
    """返回 {词: VAD}。NRC-VAD 已是 0~1 连续三维。"""
    path = path or os.path.join(LEXICON_DIR, "nrc_vad.csv")
    lex: dict[str, VAD] = {}
    if not os.path.exists(path):
        return lex
    with open(path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames or []
        col_word = _pick(fields, {"Word", "word", "词语", "词"})
        col_v = _pick(fields, {"Valence", "valence", "效价"})
        col_a = _pick(fields, {"Arousal", "arousal", "唤起"})
        col_d = _pick(fields, {"Dominance", "dominance", "支配"})
        for row in reader:
            word = _norm(row.get(col_word, ""))
            if not word:
                continue
            try:
                v = float(row.get(col_v, 0.5) or 0.5)
                a = float(row.get(col_a, 0.5) or 0.5)
                d = float(row.get(col_d, 0.5) or 0.5)
            except (TypeError, ValueError):
                continue
            lex[word] = VAD(v, a, d)
    return lex


def _pick(fields: list[str], candidates: set[str]) -> str:
    for f in fields:
        if f and f.strip() in candidates:
            return f
    return ""


def anchor_vad(text: str, dutir=None, nrc=None) -> Optional[VAD]:
    """给文本打词典锚点 VAD：对命中的词做加权平均。

    中文不做分词，用「子串命中」粗匹配（够做锚点；要更准可接 jieba）。
    英文对空格分词后匹配。无命中返回 None。
    """
    if dutir is None:
        dutir = load_dutir()
    if nrc is None:
        nrc = load_nrc_vad()

    tokens: list[str] = [text]
    if any(ch.isascii() and ch.isalpha() for ch in text):
        tokens = [w.strip(".,!?;:，。！？；：\"'") for w in text.split() if w.strip()]

    hits_v, hits_a, hits_d = [], [], []
    for tok in tokens:
        if tok in nrc:
            v = nrc[tok]
            hits_v.append(v.valence); hits_a.append(v.arousal); hits_d.append(v.dominance)
        else:
            # 中文子串命中：词典里任一词是 tok 的子串（或反之）
            for w, (val, aro) in dutir.items():
                if w and (w in tok or tok in w):
                    hits_v.append(val); hits_a.append(aro)
                    break  # 每个 token 最多算一次

    if not hits_v:
        return None
    return VAD(
        sum(hits_v) / len(hits_v),
        sum(hits_a) / len(hits_a),
        (sum(hits_d) / len(hits_d)) if hits_d else 0.5,  # 无支配性信息时取中性
    )
