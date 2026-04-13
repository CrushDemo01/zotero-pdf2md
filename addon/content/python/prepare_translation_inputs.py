#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from workflow_common import run_step

DEFAULT_MISTRAL_MD_NAME = "mistral.md"
DEFAULT_OCR_JSON_NAME = "ocr.json"
DEFAULT_TARGET_MD_NAME = "target.md"
DEFAULT_IMAGES_DIR_NAME = "images"


def default_ocr_output(pdf_path: Path, outdir: Path) -> Path:
    del pdf_path
    return outdir / DEFAULT_MISTRAL_MD_NAME


def write_source_package_summary(outdir: Path, manifest: dict):
    summary_path = outdir / "source_package.md"
    lines = [
        "# Source Package Summary",
        "",
        "## Files",
        "",
        f"- PDF: `{manifest.get('pdf')}`",
        f"- Source Markdown: `{manifest.get('mistral_markdown')}`",
        f"- OCR JSON: `{manifest.get('mistral_response_json')}`",
        f"- OCR Images Dir: `{manifest.get('mistral_images_dir')}`",
        f"- Final Target Markdown: `{manifest.get('target_markdown')}`",
        f"- OCR Tables Markdown Dir: `{manifest.get('mistral_tables_md_dir')}`",
        f"- OCR Tables HTML Dir: `{manifest.get('mistral_tables_html_dir')}`",
        f"- Rendered Pages Dir: `{manifest.get('pages_dir')}`",
        f"- Asset Index: `{manifest.get('asset_index')}`",
        "",
        "## Stage 2 Guidance",
        "",
        "- Use source markdown as the primary draft text source.",
        "- Use rendered PDF pages as the visual ground truth.",
        "- Prefer `images/` for figures.",
        "- Prefer OCR-returned tables when available.",
        "- Correct OCR mistakes during translation instead of copying them blindly.",
        "",
    ]
    summary_path.write_text("\n".join(lines), encoding="utf-8")
    return summary_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare translation inputs for pdf-to-md-zh by generating a "
            "rich Mistral OCR markdown draft and rendering PDF page images."
        )
    )
    parser.add_argument("--pdf", required=True, type=Path, help="Path to source PDF")
    parser.add_argument(
        "--outdir", required=True, type=Path, help="Output directory for extracted assets"
    )
    parser.add_argument(
        "--ocr-md",
        type=Path,
        help="Optional output path for the Mistral OCR markdown draft",
    )
    parser.add_argument(
        "--model",
        default="mistral-ocr-latest",
        help="Mistral OCR model name",
    )
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
        "--skip-mistral",
        action="store_true",
        help="Skip Mistral OCR and only extract PDF assets",
    )
    parser.add_argument(
        "--skip-assets",
        action="store_true",
        help="Skip asset extraction and only generate the Mistral OCR markdown",
    )
    parser.add_argument(
        "--table-format",
        choices=["markdown", "html", "none"],
        default="markdown",
        help="Request table extraction format from Mistral OCR",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    pdf_path = args.pdf.resolve()
    outdir = args.outdir.resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    if args.skip_mistral and args.skip_assets:
        raise RuntimeError("Nothing to do: both --skip-mistral and --skip-assets were set")

    scripts_dir = Path(__file__).resolve().parent
    mistral_script = scripts_dir / "mistral_ocr_to_markdown.py"
    extract_script = scripts_dir / "extract_pdf_assets.py"

    ocr_md = (args.ocr_md.resolve() if args.ocr_md else default_ocr_output(pdf_path, outdir))

    if not args.skip_mistral:
        mistral_cmd = [
            sys.executable,
            str(mistral_script),
            str(pdf_path),
            "-o",
            str(ocr_md),
            "--model",
            args.model,
            "--signed-url-expiry-minutes",
            str(args.signed_url_expiry_minutes),
        ]
        if args.inline_images:
            mistral_cmd.append("--inline-images")
        if args.keep_inline_images:
            mistral_cmd.append("--keep-inline-images")
        mistral_cmd.extend(["--table-format", args.table_format])
        run_step(mistral_cmd)

    if not args.skip_assets:
        extract_cmd = [
            sys.executable,
            str(extract_script),
            "--pdf",
            str(pdf_path),
            "--outdir",
            str(outdir),
            "--ocr-md",
            str(ocr_md),
            "--ocr-json",
            str(outdir / DEFAULT_OCR_JSON_NAME),
        ]
        run_step(extract_cmd)

    manifest = {
        "pdf": str(pdf_path),
        "outdir": str(outdir),
        "mistral_markdown": None if args.skip_mistral else str(ocr_md),
        "mistral_response_json": None if args.skip_mistral else str(outdir / DEFAULT_OCR_JSON_NAME),
        "mistral_images_dir": (
            None
            if args.skip_mistral or not args.inline_images or args.keep_inline_images
            else str(outdir / DEFAULT_IMAGES_DIR_NAME)
        ),
        "target_markdown": str(outdir / DEFAULT_TARGET_MD_NAME),
        "mistral_tables_md_dir": (
            None
            if args.skip_mistral or args.table_format != "markdown"
            else str(outdir / "tables_md")
        ),
        "mistral_tables_html_dir": (
            None
            if args.skip_mistral or args.table_format != "html"
            else str(outdir / "tables_html")
        ),
        "extracted_text": None if args.skip_assets else str(outdir / "extracted_text.txt"),
        "pages_dir": None if args.skip_assets else str(outdir / "pages"),
        "figures_tables_dir": None,
        "tables_md_dir": (
            None
            if args.skip_mistral or args.table_format != "markdown"
            else str(outdir / "tables_md")
        ),
        "asset_index": None if args.skip_assets else str(outdir / "asset_index.md"),
    }
    manifest_path = outdir / "translation_prep.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    summary_path = write_source_package_summary(outdir, manifest)
    print(manifest_path)
    print(summary_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
