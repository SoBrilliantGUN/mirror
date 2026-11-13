"""采集 —— 把字幕/剧本文件转成 pipeline 认识的 texts.jsonl。

支持：
  .srt / .ass / .ssa  字幕：去掉时间轴与 HTML 标记，连续文本行拼成一句
  .txt / .md          剧本：支持「角色：台词」或「角色　台词」格式；也可每行一条

用法：
  python emotion-gold/collect.py --input <文件或目录> --output texts.jsonl

输出每行：{"id","text","speaker"(可选),"context"(上一句，供推断潜台词),"source"}
"""
from __future__ import annotations

import argparse
import json
import os
import re


def _is_timestamp(line: str) -> bool:
    return "-->" in line


def parse_srt(path: str) -> list[dict]:
    items: list[dict] = []
    with open(path, encoding="utf-8", errors="ignore") as f:
        lines = f.read().splitlines()
    buf: list[str] = []
    for ln in lines:
        s = ln.strip()
        if not s:
            if buf:
                items.append({"text": " ".join(buf)})
                buf = []
            continue
        if s.isdigit() or _is_timestamp(s):
            continue
        s = re.sub(r"<[^>]+>", "", s)  # 去字幕 HTML 标签
        if s:
            buf.append(s)
    if buf:
        items.append({"text": " ".join(buf)})
    return items


def parse_txt(path: str) -> list[dict]:
    items: list[dict] = []
    with open(path, encoding="utf-8", errors="ignore") as f:
        for ln in f:
            s = ln.strip()
            if not s or s.startswith("#") or s.startswith("//"):
                continue
            m = re.match(r"^(.{1,12}?)[：:\t　]\s*(.+)$", s)
            if m:
                items.append({"speaker": m.group(1), "text": m.group(2)})
            else:
                items.append({"text": s})
    return items


def collect(path: str) -> list[dict]:
    if os.path.isdir(path):
        out: list[dict] = []
        for root, _, files in os.walk(path):
            for fn in sorted(files):
                out.extend(collect(os.path.join(root, fn)))
        return out
    ext = os.path.splitext(path)[1].lower()
    if ext == ".srt":
        return parse_srt(path)
    if ext in (".ass", ".ssa"):
        return parse_srt(path)
    if ext in (".txt", ".md"):
        return parse_txt(path)
    return []


def attach_context(items: list[dict]) -> list[dict]:
    """上一句作为 context，供 LLM 推断潜台词。"""
    out: list[dict] = []
    for i, it in enumerate(items):
        d = dict(it)
        d["id"] = d.get("id", f"{i:04d}")
        if i > 0 and "context" not in d:
            prev = items[i - 1]
            ctx = f"{prev.get('speaker', '')}：{prev['text']}".strip("：")
            d["context"] = ctx
        d["source"] = d.get("source", "")
        out.append(d)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    items = attach_context(collect(args.input))
    with open(args.output, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    print(f"采集 {len(items)} 条 → {args.output}")


if __name__ == "__main__":
    main()
