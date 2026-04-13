#!/usr/bin/env python3
import argparse
from pathlib import Path


HEADER_NOTE = (
    "> 分块写入稿：请按“阅读当前块 → 翻译当前块 → 立即写入”的方式持续完成全文。\n"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-md", required=True, help="Target markdown file")
    ap.add_argument("--body-file", required=True, help="Markdown body file for the current chunk")
    ap.add_argument("--title", default="论文", help="Document title used when initializing a new file")
    ap.add_argument("--chunk-label", help="Optional chunk heading, e.g. 第2块（P3-P4）")
    ap.add_argument("--append", action="store_true", help="Append to existing markdown instead of overwriting")
    args = ap.parse_args()

    out_md = Path(args.out_md)
    body_file = Path(args.body_file)
    if not body_file.exists():
        raise FileNotFoundError(f"missing: {body_file}")

    body = body_file.read_text(encoding="utf-8").strip()
    if not body:
        raise RuntimeError("body markdown is empty")

    if args.append and out_md.exists():
        parts = ["\n\n---\n\n"]
        if args.chunk_label:
            parts.append(f"## {args.chunk_label}\n\n")
        parts.append(body)
        with out_md.open("a", encoding="utf-8") as f:
            f.write("".join(parts))
    else:
        parts = [f"# {args.title}（中文译稿）\n\n", HEADER_NOTE, "\n"]
        if args.chunk_label:
            parts.append(f"## {args.chunk_label}\n\n")
        parts.append(body)
        parts.append("\n")
        out_md.write_text("".join(parts), encoding="utf-8")

    print(f"written: {out_md}")


if __name__ == "__main__":
    main()
