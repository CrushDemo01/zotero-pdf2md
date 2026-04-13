#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from workflow_common import (
    DEFAULT_CHUNK_CHARS,
    DEFAULT_MISTRAL_MD_NAME,
    DEFAULT_OCR_JSON_NAME,
    Chunk,
    chunk_source_text,
    load_manifest,
    read_asset_index,
    run_step,
)


def build_markdown(
    *,
    title: str,
    pdf_path: Path,
    source_md: Path,
    ocr_json: Path,
    asset_index: Path,
    pages_dir: Path,
    chunks: list[Chunk],
) -> str:
    lines: list[str] = [
        f"# {title}（中文分块草稿）",
        "",
        "> 本文件是基于富 OCR 原文包生成的翻译工作稿。",
        "> 请同时参考原文 Markdown、OCR JSON、Mistral 图片与 PDF 页面图进行翻译和校对。",
        "",
        "## 使用说明",
        "",
        "- 逐块处理，不要一次性全文翻译。",
        "- 先参考 `原文骨架`，再对照 PDF 页面图修正标题、公式、图注和表格。",
        "- 优先使用 `images/` 与 OCR 返回表格，不依赖启发式裁图。",
        "- 完成一块后立即将中文内容整理到正式译稿。",
        "",
        "## 输入来源",
        "",
        f"- PDF: `{pdf_path}`",
        f"- Source Markdown: `{source_md}`",
        f"- OCR JSON: `{ocr_json}`",
        f"- 资产索引: `{asset_index}`",
        f"- PDF 页面图: `{pages_dir}`",
        "",
        "## 资产索引摘要",
        "",
        read_asset_index(asset_index),
        "",
    ]

    for idx, chunk in enumerate(chunks, start=1):
        lines.extend(
            [
                f"## 第{idx}块：{chunk.title}",
                "",
                "> 校对要求：结合 PDF 页面图、OCR 图片与 OCR JSON，修正原文骨架中的明显 OCR 错误。",
                "",
                "### 中文译文",
                "",
                "[待翻译]",
                "",
                "### 原文骨架",
                "",
                "```text",
                chunk.body.strip(),
                "```",
                "",
            ]
        )

    return "\n".join(lines).rstrip() + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Build a chunked Chinese translation working draft from a rich OCR "
            "source package. This helper creates a draft, not a fully translated final zh.md."
        )
    )
    parser.add_argument("--pdf", required=True, type=Path, help="Path to source PDF")
    parser.add_argument("--outdir", required=True, type=Path, help="Working output directory")
    parser.add_argument("--out-md", required=True, type=Path, help="Draft markdown output path")
    parser.add_argument("--title", help="Document title used in the generated draft")
    parser.add_argument(
        "--ocr-md",
        type=Path,
        help="Optional existing Mistral OCR markdown path; defaults to <outdir>/mistral.md",
    )
    parser.add_argument(
        "--ocr-json",
        type=Path,
        help="Optional OCR response JSON path; defaults to <outdir>/ocr.json",
    )
    parser.add_argument(
        "--chunk-chars",
        type=int,
        default=DEFAULT_CHUNK_CHARS,
        help="Approximate maximum characters per chunk",
    )
    parser.add_argument(
        "--skip-prepare",
        action="store_true",
        help="Do not run prepare_translation_inputs.py first",
    )
    parser.add_argument(
        "--skip-mistral",
        action="store_true",
        help="Pass through to prepare_translation_inputs.py",
    )
    parser.add_argument(
        "--skip-assets",
        action="store_true",
        help="Pass through to prepare_translation_inputs.py",
    )
    parser.add_argument("--model", default="mistral-ocr-latest", help="Mistral OCR model name")
    parser.add_argument(
        "--signed-url-expiry-minutes",
        type=int,
        default=10,
        help="Signed URL expiry passed to the Mistral files API",
    )
    parser.add_argument(
        "--inline-images",
        action="store_true",
        help=(
            "Request OCR image data from Mistral and let the OCR script save them "
            "as local files referenced from markdown"
        ),
    )
    parser.add_argument(
        "--keep-inline-images",
        action="store_true",
        help="Keep OCR image data inline in markdown instead of writing local image files",
    )
    parser.add_argument(
        "--table-format",
        choices=["markdown", "html", "none"],
        default="markdown",
        help="Request table extraction format from Mistral OCR during preparation",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    pdf_path = args.pdf.resolve()
    outdir = args.outdir.resolve()
    out_md = args.out_md.resolve()
    title = args.title or pdf_path.stem
    outdir.mkdir(parents=True, exist_ok=True)
    out_md.parent.mkdir(parents=True, exist_ok=True)

    scripts_dir = Path(__file__).resolve().parent
    prepare_script = scripts_dir / "prepare_translation_inputs.py"

    if not args.skip_prepare:
        prepare_cmd = [
            sys.executable,
            str(prepare_script),
            "--pdf",
            str(pdf_path),
            "--outdir",
            str(outdir),
            "--model",
            args.model,
            "--signed-url-expiry-minutes",
            str(args.signed_url_expiry_minutes),
        ]
        if args.inline_images:
            prepare_cmd.append("--inline-images")
        if args.keep_inline_images:
            prepare_cmd.append("--keep-inline-images")
        prepare_cmd.extend(["--table-format", args.table_format])
        if args.skip_mistral:
            prepare_cmd.append("--skip-mistral")
        if args.skip_assets:
            prepare_cmd.append("--skip-assets")
        run_step(prepare_cmd)

    manifest = load_manifest(outdir)

    source_md = (
        args.ocr_md.resolve()
        if args.ocr_md
        else Path(manifest.get("mistral_markdown") or (outdir / DEFAULT_MISTRAL_MD_NAME))
    )
    ocr_json = (
        args.ocr_json.resolve()
        if args.ocr_json
        else Path(manifest.get("mistral_response_json") or (outdir / DEFAULT_OCR_JSON_NAME))
    )
    asset_index = Path(manifest.get("asset_index") or (outdir / "asset_index.md"))
    pages_dir = Path(manifest.get("pages_dir") or (outdir / "pages"))

    if not source_md.exists():
        raise FileNotFoundError(
            f"OCR markdown not found: {source_md}. "
            "Run preparation first or provide --ocr-md."
        )

    source_text = source_md.read_text(encoding="utf-8")
    chunks = chunk_source_text(source_text, max_chars=args.chunk_chars)
    if not chunks:
        raise RuntimeError(f"No usable content found in {source_md}")

    draft = build_markdown(
        title=title,
        pdf_path=pdf_path,
        source_md=source_md,
        ocr_json=ocr_json,
        asset_index=asset_index,
        pages_dir=pages_dir,
        chunks=chunks,
    )
    out_md.write_text(draft, encoding="utf-8")
    print(out_md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
