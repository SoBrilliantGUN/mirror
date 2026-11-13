"""LLM 双通道 VAD 打分器 —— 用 DeepSeek 打 text_vad + audio_vad(潜台词) + incongruence。

复用项目 L3 大脑配置（.env 的 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / SCORE_MODEL）。
OpenAI 兼容客户端，改 base_url 即可换任何厂商。

文本样本的「audio_vad」= 从上下文/潜台词/舞台说明推断的「真实情绪」——
这正是「嘴上说没事、心里在哭」的逞强/反讽信号，也是本产品的杀手锏。
"""
from __future__ import annotations

import json
import os
import re
from typing import Optional

from schema import Sample, VAD, ConsistencyLevel


def _load_dotenv(path: str = None) -> None:
    """轻量 .env 加载：把项目根 .env 合并进 os.environ（已存在的环境变量优先）。"""
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


_load_dotenv()

SYSTEM_PROMPT = """你是情绪标注专家。给中文台词打 PAD 三维情绪标签，三个维度都取 0~1：
- valence 效价：0=极度负面，0.5=中性，1=极度正面
- arousal 唤起：0=完全平静，1=极度激动
- dominance 支配：0=完全被动/无力，1=完全主动/掌控

对每条台词判断【两个通道】：
1. text_vad —— 这句话「字面上」表达的情绪
2. audio_vad —— 说话人「真实」的情绪（从上下文、潜台词、舞台说明推断；若有声音特征则信声音）
   关键：很多人嘴上说没事，真实情绪相反（逞强/反讽/掩饰）。别把字面当真。
3. incongruence —— text_vad 与 audio_vad 是否明显矛盾（true/false）

只输出 JSON，不要任何解释或代码块：
{"text_vad":{"valence":0.0,"arousal":0.0,"dominance":0.0},
 "audio_vad":{"valence":0.0,"arousal":0.0,"dominance":0.0},
 "incongruence":false,
 "rationale":"一句中文依据"}"""


def _client():
    from openai import OpenAI  # 延迟导入，便于纯逻辑模块在无 openai 环境下也能用
    return OpenAI(
        api_key=os.environ.get("DEEPSEEK_API_KEY"),
        base_url=os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    )


def _model() -> str:
    return os.environ.get("SCORE_MODEL", "deepseek-chat")


def _strip_fence(s: str) -> str:
    s = s.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    return s.strip()


def score_one(text: str, context: Optional[str] = None,
              sample_id: str = "?", source: str = "",
              speaker: Optional[str] = None,
              max_retries: int = 3) -> Optional[Sample]:
    """给单条文本打双通道 VAD。失败（解析/越界）重试，仍失败返回 None。"""
    user = ""
    if context:
        user += f"<上下文>\n{context}\n</上下文>\n"
    if speaker:
        user += f"<说话人>{speaker}</说话人>\n"
    user += f"<台词>\n{text}\n</台词>"

    client = _client()
    for attempt in range(max_retries):
        try:
            resp = client.chat.completions.create(
                model=_model(),
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user},
                ],
                temperature=0.0,
            )
            raw = resp.choices[0].message.content or ""
            data = json.loads(_strip_fence(raw))
            tv = VAD(**{k: float(data["text_vad"][k]) for k in ("valence", "arousal", "dominance")})
            av = VAD(**{k: float(data["audio_vad"][k]) for k in ("valence", "arousal", "dominance")})
            inc = bool(data.get("incongruence", False))
            return Sample(
                id=sample_id, text=text, text_vad=tv, audio_vad=av,
                incongruence=inc, speaker=speaker, context=context,
                source=source, rationale=str(data.get("rationale", "")),
            )
        except Exception as e:  # noqa: BLE001 —— 网络/解析/越界都重试
            last = e
    print(f"[score_one] 失败 {sample_id}: {last}")
    return None


def score_many(items: list[dict], verbose: bool = True) -> list[Sample]:
    """批量打分。items 每项含 text，可选 id/context/speaker/source。"""
    out: list[Sample] = []
    for i, it in enumerate(items):
        s = score_one(
            text=it.get("text", ""),
            context=it.get("context"),
            sample_id=str(it.get("id", i)),
            source=it.get("source", ""),
            speaker=it.get("speaker"),
        )
        if s is not None:
            out.append(s)
        if verbose and (i + 1) % 10 == 0:
            print(f"  …已打 {i + 1}/{len(items)}")
    return out
