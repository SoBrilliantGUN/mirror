"""层 A 金标管线 CLI —— score / stratify / agreement 三件事。

用法（在项目根，.env 已含 DEEPSEEK_* 时）：
  python emotion-gold/pipeline.py score      --input texts.jsonl --output scored.jsonl
  python emotion-gold/pipeline.py stratify   --input scored.jsonl --output gold_pick.jsonl --n 500
  python emotion-gold/pipeline.py agreement  --gold gold.jsonl --auto scored.jsonl --output report.json

texts.jsonl 每行：{"id":"..","text":"..","context":".."(可选),"speaker":".."(可选),"source":".."(可选)}
也接受纯文本文件（每行一条，id 自动编号）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import schema  # noqa: E402


def _read_items(path: str) -> list[dict]:
    items: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    if path.endswith(".jsonl") or content.lstrip().startswith("{"):
        for line in content.split("\n"):
            line = line.strip()
            if line:
                items.append(json.loads(line))
    else:  # 纯文本，每行一条
        for i, line in enumerate(content.split("\n")):
            line = line.strip()
            if line:
                items.append({"id": str(i), "text": line})
    return items


def cmd_score(args):
    from vad_scorer import score_many
    items = _read_items(args.input)
    print(f"共 {len(items)} 条，开始打分（模型 {os.environ.get('SCORE_MODEL', 'deepseek-chat')}）…")
    samples = score_many(items)
    schema.save(samples, args.output)
    print(f"完成 {len(samples)}/{len(items)} 条 → {args.output}")


def cmd_stratify(args):
    from stratify import stratify, summarize
    samples = schema.load(args.input)
    picked = stratify(samples, n=args.n, seed=args.seed)
    schema.save(picked, args.output)
    print(f"从 {len(samples)} 条里挑 {len(picked)} 条 → {args.output}")
    print("分布:", summarize(picked))


def cmd_agreement(args):
    from agreement import agree
    gold = schema.load(args.gold)
    auto = schema.load(args.auto)
    report = agree(gold, auto)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("score")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.set_defaults(func=cmd_score)

    p = sub.add_parser("stratify")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--n", type=int, default=500)
    p.add_argument("--seed", type=int, default=42)
    p.set_defaults(func=cmd_stratify)

    p = sub.add_parser("agreement")
    p.add_argument("--gold", required=True)
    p.add_argument("--auto", required=True)
    p.add_argument("--output", required=True)
    p.set_defaults(func=cmd_agreement)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
