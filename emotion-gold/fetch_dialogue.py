"""Tier 2 多轮对白获取 —— dgk_lost_conv 电视剧对白（多轮，利于抓「言不由衷」）。

源：GitHub raw 直链（无需百度网盘）：
  https://raw.githubusercontent.com/NonvolatileMemory/dgk_lost_conv/master/results/{name}.conv

格式（.conv 纯文本，UTF-8，\r\n 换行）：
  E          —— 对话段落分隔
  M 台词     —— 一句台词（相邻 M 构成一段多轮对白，平均 5.3 轮）

关键：每句台词转 texts.jsonl 时，context 带上同段对话里**前面的轮次**（默认 3 轮），
让 LLM 能依据上下文推断潜台词 / 反讽 / 逞强——这正是单句字幕给不了的东西。

用法：
  python emotion-gold/fetch_dialogue.py --files lost,prisonb --limit 5000 --output texts.jsonl
  python emotion-gold/fetch_dialogue.py --all --limit 20000 --output texts.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from fetch_subtitles import _clean, _simplify  # 复用清洗 + 简繁转换

BASE = "https://raw.githubusercontent.com/NonvolatileMemory/dgk_lost_conv/master/results/"
FILES = {
    "lost": "lost.conv",        # 美剧《迷失》1.8MB
    "prisonb": "prisonb.conv",  # 《越狱》542KB
    "juemds": "juemds.conv",    # 792KB
    "haosys": "haosys.conv",    # 1.3MB
    "laoyj": "laoyj.conv",      # 1.5MB
    "fanzxl": "fanzxl.conv",    # 2.3MB
    "fk24": "fk24.conv",        # 4.5MB
}
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")


def download(name: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, FILES[name])
    if not os.path.exists(path):
        url = BASE + FILES[name]
        print(f"下载 {url} …", file=sys.stderr)
        urllib.request.urlretrieve(url, path)
    return path


def _read_text(path: str) -> str:
    """dgk_lost_conv 文件编码混杂（有 UTF-8 也有 GBK），逐个探测。"""
    raw = open(path, "rb").read()
    for enc in ("utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def parse_conv(path: str) -> list[list[str]]:
    """把 .conv 拆成多轮对话：每个段落 = [台词1, 台词2, ...]。"""
    dialogues: list[list[str]] = []
    cur: list[str] = []
    for line in _read_text(path).splitlines():
        line = line.rstrip("\r\n").strip()
        if not line:
            continue
        if line == "E":
            if cur:
                dialogues.append(cur)
                cur = []
            continue
        if line.startswith("M"):
            utt = line[1:].lstrip()
            utt = re.sub(r"(?<=[一-鿿])\s+(?=[一-鿿])", "", utt)  # 去分词空格
            if utt:
                cur.append(utt)
    if cur:
        dialogues.append(cur)
    return dialogues


def dialogues_to_turns(dialogues: list[list[str]], window: int = 3) -> list[dict]:
    """每句台词带前 window 轮上下文。"""
    items: list[dict] = []
    for d in dialogues:
        for i, utt in enumerate(d):
            ctx = d[max(0, i - window):i]
            item = {"text": utt}
            if ctx:
                item["context"] = "\n".join(ctx)
            items.append(item)
    return items


def finalize(items: list[dict], limit: int, seed: int, simplify: bool, output: str) -> int:
    """清洗 + 简繁 + 去重 + reservoir 抽样，落 texts.jsonl。"""
    rng = random.Random(seed)
    seen: set[str] = set()
    picked: list[dict] = []
    n = 0
    for it in items:
        t = _clean(it["text"])
        if t is None:
            continue
        if simplify:
            t = _simplify(t)
        if t in seen:
            continue
        seen.add(t)
        n += 1
        d = {"text": t}
        if it.get("context"):
            d["context"] = it["context"]
        if n <= limit:
            picked.append(d)
        else:
            j = rng.randrange(n)
            if j < limit:
                picked[j] = d
    with open(output, "w", encoding="utf-8") as f:
        for i, d in enumerate(picked):
            out = {"id": f"{i:06d}", "text": d["text"], "source": "dgk_lost_conv"}
            if d.get("context"):
                out["context"] = d["context"]
            f.write(json.dumps(out, ensure_ascii=False) + "\n")
    return len(picked)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", help="逗号分隔的剧名，见 FILES 键（默认 lost,prisonb）")
    ap.add_argument("--all", action="store_true", help="下全部小 .conv")
    ap.add_argument("--window", type=int, default=3, help="上下文轮数（默认 3）")
    ap.add_argument("--limit", type=int, default=5000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-simplify", action="store_true")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    if args.all:
        names = list(FILES.keys())
    elif args.files:
        names = [x.strip() for x in args.files.split(",") if x.strip()]
    else:
        names = ["lost", "prisonb"]

    dialogues: list[list[str]] = []
    for name in names:
        if name not in FILES:
            print(f"未知剧名 {name}，可用：{list(FILES.keys())}", file=sys.stderr)
            continue
        dialogues.extend(parse_conv(download(name)))
    print(f"解析 {len(dialogues)} 段多轮对白", file=sys.stderr)

    items = dialogues_to_turns(dialogues, window=args.window)
    n = finalize(items, args.limit, args.seed, simplify=not args.no_simplify, output=args.output)
    print(f"得到 {n} 条 → {args.output}")


if __name__ == "__main__":
    main()
