"""Tier 2 语料获取 —— 下载/导入中文影视台词，转成 texts.jsonl。

来源 1（自动下载）OPUS OpenSubtitles 中文单语字幕：
  zh_cn（简体，首选）/ zh_tw（繁体，兜底，已确认可下、约 15MB）
  URL：https://object.pouta.csc.fi/OPUS-OpenSubtitles/v2018/mono/{lang}.txt.gz
  全量很大，用 --limit 做 reservoir 抽样（默认 5000），不把全量装进内存。

来源 2（手动下载后导入）chinese-chatbot-corpus 电视剧对白：
  百度网盘下 raw_chat_corpus → 跑官方 main.py → 得 query\\tanswer 的 *.tsv，
  用 --tsv 传入本脚本转 texts.jsonl。

用法：
  python emotion-gold/fetch_subtitles.py --limit 5000 --output texts.jsonl          # 自动试 zh_cn→zh_tw
  python emotion-gold/fetch_subtitles.py --lang zh_tw --limit 5000 --output texts.jsonl
  python emotion-gold/fetch_subtitles.py --tsv ./clean_chat_corpus/subtitle.tsv --limit 5000 --output texts.jsonl

产出即 pipeline 的 score 输入（含上一句作 context）。
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import random
import re
import sys
import urllib.request

OPUS_URL = "https://object.pouta.csc.fi/OPUS-OpenSubtitles/v2018/mono/{lang}.txt.gz"
LANGS = ["zh_cn", "zh_tw"]  # 首选简体，兜底繁体
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")

# 私用区（U+E000–F8FF）与替换符（U+FFFD）：OpenSubtitles 常见编码噪声，直接丢
_PUA = re.compile(r"[-�]")


# 简繁转换（可选：装了 opencc-python-reimplemented 才生效）
def _get_opencc():
    try:
        from opencc import OpenCC
        return OpenCC("t2s")
    except Exception:
        return None


_CC = _get_opencc()


def _simplify(s: str) -> str:
    return _CC.convert(s) if _CC else s


def _clean(line: str) -> str | None:
    """噪声过滤 + 轻清洗。"""
    s = line.strip()
    s = re.sub(r"\{[^}]*\}", "", s)          # 去 ASS/SSA 特效标签
    s = s.lstrip("-·・ ").strip()
    if not s or len(s) < 3 or len(s) > 200:
        return None
    if "http" in s or "www." in s:
        return None
    if _PUA.search(s):
        return None
    s = re.sub(r"(?<=[一-鿿])\s+(?=[一-鿿])", "", s)  # 去 tokenize 空格
    if not any(ch.isalnum() or "一" <= ch <= "鿿" for ch in s):
        return None
    return s


def _reservoir_sample(stream, limit: int, seed: int) -> list[str]:
    rng = random.Random(seed)
    out: list[str] = []
    n = 0
    for raw in stream:
        s = _clean(raw)
        if s is None:
            continue
        n += 1
        if n <= limit:
            out.append(s)
        else:
            j = rng.randrange(n)
            if j < limit:
                out[j] = s
    return out


def fetch_opus(limit: int, seed: int, lang: str | None = None) -> list[str]:
    os.makedirs(CACHE_DIR, exist_ok=True)
    langs = [lang] if lang else LANGS
    last_err = None
    for lg in langs:
        url = OPUS_URL.format(lang=lg)
        cache = os.path.join(CACHE_DIR, f"opus_{lg}.txt.gz")
        try:
            if not os.path.exists(cache):
                print(f"下载 {url} …", file=sys.stderr)
                urllib.request.urlretrieve(url, cache)
            with gzip.open(cache, "rt", encoding="utf-8", errors="ignore") as f:
                return _reservoir_sample(f, limit, seed)
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"  {lg} 失败：{e}", file=sys.stderr)
    raise RuntimeError(f"OPUS 下载全部失败：{last_err}")


def load_tsv(path: str, limit: int, seed: int) -> list[str]:
    """chinese-chatbot-corpus 的 query\\tanswer → 展平成一句一句。"""
    lines: list[str] = []
    with open(path, encoding="utf-8", errors="ignore") as f:
        for ln in f:
            for p in ln.rstrip("\n").split("\t"):
                s = _clean(p)
                if s:
                    lines.append(s)
    if len(lines) > limit:
        lines = random.Random(seed).sample(lines, limit)
    return lines


def to_jsonl(texts: list[str], output: str, simplify: bool = True) -> int:
    seen: set[str] = set()
    prev: str | None = None
    count = 0
    with open(output, "w", encoding="utf-8") as f:
        for t in texts:
            if simplify:
                t = _simplify(t)
            if t in seen:
                continue
            seen.add(t)
            d = {"id": f"{count:06d}", "text": t, "source": "opensubtitles"}
            if prev is not None:
                d["context"] = prev
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
            prev = t
            count += 1
    return count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["opus", "tsv"], default="opus")
    ap.add_argument("--lang", choices=["zh_cn", "zh_tw"], default=None,
                    help="OPUS 语种（默认自动：先 zh_cn 再 zh_tw）")
    ap.add_argument("--tsv", help="chinese-chatbot-corpus 的 query\\tanswer 文件路径")
    ap.add_argument("--limit", type=int, default=5000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-simplify", action="store_true", help="不做繁体→简体转换")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    if args.source == "opus":
        texts = fetch_opus(args.limit, args.seed, args.lang)
    else:
        if not args.tsv:
            ap.error("--source tsv 需要 --tsv 文件路径")
        texts = load_tsv(args.tsv, args.limit, args.seed)

    n = to_jsonl(texts, args.output, simplify=not args.no_simplify)
    print(f"得到 {n} 条（去重/简繁后）→ {args.output}")


if __name__ == "__main__":
    main()
