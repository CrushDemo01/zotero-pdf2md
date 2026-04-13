#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import fitz  # PyMuPDF
from PyPDF2 import PdfReader


IMAGE_MD_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
TABLE_MD_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def write_text(pdf_path: Path, out_txt: Path):
    reader = PdfReader(str(pdf_path))
    with out_txt.open("w", encoding="utf-8") as f:
        for i, page in enumerate(reader.pages, 1):
            f.write(f"\n\n===== PAGE {i} =====\n")
            f.write((page.extract_text() or "").replace("\x00", ""))


def render_pages(doc: fitz.Document, pages_dir: Path, zoom: float = 3.0):
    pages_dir.mkdir(parents=True, exist_ok=True)
    for i, page in enumerate(doc, 1):
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        pix.save(str(pages_dir / f"page_{i:02d}.png"))


def load_json(path: Path | None) -> dict:
    if not path or not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def collect_markdown_refs(ocr_md: Path | None):
    if not ocr_md or not ocr_md.exists():
        return [], []

    text = ocr_md.read_text(encoding="utf-8")
    image_refs = []
    table_refs = []
    seen_images: set[str] = set()
    seen_tables: set[str] = set()

    for ref in IMAGE_MD_RE.findall(text):
        ref = ref.strip()
        if ref and ref not in seen_images:
            seen_images.add(ref)
            image_refs.append(ref)

    for label, ref in TABLE_MD_RE.findall(text):
        ref = ref.strip()
        if not ref or ref in seen_tables:
            continue
        if ref.endswith((".md", ".html", ".htm", ".json")) or ref.startswith("tbl-"):
            seen_tables.add(ref)
            table_refs.append((label.strip(), ref))

    return image_refs, table_refs


def build_index(
    outdir: Path,
    *,
    image_refs: list[str],
    table_items: list[tuple[str, str]],
    ocr_payload: dict,
):
    lines = ["# Asset Index", "", "## OCR Images (from Mistral markdown)"]
    if not image_refs:
        lines.append("- none")
    else:
        for ref in image_refs:
            lines.append(f"- `{ref}`")

    lines += ["", "## OCR Tables (from Mistral OCR response)"]
    if not table_items:
        lines.append("- none")
    else:
        for label, ref in table_items:
            lines.append(f"- {label or Path(ref).name}: `{ref}`")

    lines += ["", "## OCR Metadata"]
    model = ocr_payload.get("model")
    usage = ocr_payload.get("usage_info")
    if model:
        lines.append(f"- model: `{model}`")
    if usage:
        lines.append(f"- usage_info: `{json.dumps(usage, ensure_ascii=False)}`")

    lines += ["", "## Page images", ""]
    for p in sorted((outdir / "pages").glob("page_*.png")):
        lines.append(f"- `{p.relative_to(outdir)}`")

    (outdir / "asset_index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="Input PDF")
    ap.add_argument("--outdir", required=True, help="Output directory")
    ap.add_argument("--ocr-md", help="OCR markdown path")
    ap.add_argument("--ocr-json", help="OCR response json path")
    ap.add_argument(
        "--page-zoom",
        type=float,
        default=3.0,
        help="Zoom factor used when rendering PDF pages to PNG",
    )
    args = ap.parse_args()

    pdf_path = Path(args.pdf).resolve()
    outdir = Path(args.outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(str(pdf_path))
    write_text(pdf_path, outdir / "extracted_text.txt")
    render_pages(doc, outdir / "pages", zoom=args.page_zoom)

    ocr_md = Path(args.ocr_md).resolve() if args.ocr_md else None
    ocr_json = Path(args.ocr_json).resolve() if args.ocr_json else None
    image_refs, table_items = collect_markdown_refs(ocr_md)
    ocr_payload = load_json(ocr_json)
    build_index(outdir, image_refs=image_refs, table_items=table_items, ocr_payload=ocr_payload)

    print(
        f"done: pages={len(doc)}, mistral_images={len(image_refs)}, "
        f"mistral_tables={len(table_items)}"
    )
    print(f"see: {outdir / 'asset_index.md'}")


if __name__ == "__main__":
    main()
