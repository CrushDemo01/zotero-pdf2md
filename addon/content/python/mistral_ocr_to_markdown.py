#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_MODEL = "mistral-ocr-latest"
FILES_API_URL = "https://api.mistral.ai/v1/files"
OCR_API_URL = "https://api.mistral.ai/v1/ocr"
DEFAULT_MARKDOWN_NAME = "mistral.md"
DEFAULT_RESPONSE_JSON_NAME = "ocr.json"
DEFAULT_IMAGES_DIR_NAME = "images"


def get_api_key() -> str:
    api_key = os.getenv("MISTRAL_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Missing MISTRAL_API_KEY environment variable. "
            "Export it first, e.g. `export MISTRAL_API_KEY=...`"
        )
    return api_key.strip()


def split_data_url(value: str) -> tuple[str | None, str]:
    if value.startswith("data:") and "," in value:
        header, payload = value.split(",", 1)
        return header, payload
    return None, value


def guess_extension(blob: bytes, header: str | None, default: str = ".bin") -> str:
    if header:
        if "image/png" in header:
            return ".png"
        if "image/jpeg" in header or "image/jpg" in header:
            return ".jpg"
        if "image/webp" in header:
            return ".webp"
        if "image/gif" in header:
            return ".gif"
    if blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if blob.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if blob.startswith(b"GIF87a") or blob.startswith(b"GIF89a"):
        return ".gif"
    if blob.startswith(b"RIFF") and blob[8:12] == b"WEBP":
        return ".webp"
    return default


def sanitize_stem(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", value or "")
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned or "asset"


def write_image_asset(image_id: str, image_base64: str, image_dir: Path) -> Path:
    header, payload = split_data_url(image_base64)
    image_bytes = base64.b64decode(payload)
    suffix = guess_extension(image_bytes, header, ".bin")
    image_dir.mkdir(parents=True, exist_ok=True)
    image_path = image_dir / f"{sanitize_stem(Path(image_id).stem)}{suffix}"
    image_path.write_bytes(image_bytes)
    return image_path


def write_table_asset(
    *,
    table_id: str,
    table_payload: dict,
    markdown_dir: Path,
    html_dir: Path,
) -> tuple[str, Path] | None:
    markdown = table_payload.get("markdown")
    html = table_payload.get("html")
    stem = sanitize_stem(Path(table_id).stem)

    if isinstance(markdown, str) and markdown.strip():
        markdown_dir.mkdir(parents=True, exist_ok=True)
        path = markdown_dir / f"{stem}.md"
        path.write_text(markdown.strip() + "\n", encoding="utf-8")
        return "markdown", path

    if isinstance(html, str) and html.strip():
        html_dir.mkdir(parents=True, exist_ok=True)
        path = html_dir / f"{stem}.html"
        path.write_text(html.strip() + "\n", encoding="utf-8")
        return "html", path

    return None


def replace_image_placeholders(markdown: str, image_refs: dict[str, str]) -> str:
    def repl(match: re.Match[str]) -> str:
        alt = match.group(1)
        target = match.group(2)
        replacement = image_refs.get(target) or image_refs.get(Path(target).name)
        if not replacement:
            return match.group(0)
        return f"![{alt}]({replacement})"

    return re.sub(r"!\[(.*?)\]\((.*?)\)", repl, markdown)


def replace_table_placeholders(markdown: str, table_refs: dict[str, str], inline_tables: dict[str, str]) -> str:
    def repl(match: re.Match[str]) -> str:
        label = match.group(1)
        target = match.group(2)
        norm_target = target.strip()
        if norm_target in inline_tables:
            return inline_tables[norm_target]
        replacement = table_refs.get(norm_target) or table_refs.get(Path(norm_target).name)
        if replacement:
            return f"[{label}]({replacement})"
        return match.group(0)

    return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", repl, markdown)


def upload_file_via_rest(api_key: str, pdf_path: Path) -> str:
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        upload_json = Path(tmp.name)

    try:
        with upload_json.open("wb") as stdout:
            subprocess.run(
                [
                    "curl",
                    "--silent",
                    "--show-error",
                    "-X",
                    "POST",
                    FILES_API_URL,
                    "-H",
                    f"Authorization: Bearer {api_key}",
                    "-F",
                    f"file=@{pdf_path}",
                    "-F",
                    "purpose=ocr",
                    "-F",
                    "visibility=user",
                ],
                check=True,
                stdout=stdout,
            )
        data = json.loads(upload_json.read_text(encoding="utf-8"))
    finally:
        upload_json.unlink(missing_ok=True)

    file_id = data.get("id")
    if not file_id:
        raise RuntimeError(f"Upload succeeded but response has no file id: {data}")
    return file_id


def call_ocr_via_rest(
    *,
    api_key: str,
    file_id: str,
    model: str,
    include_image_base64: bool,
    table_format: str | None,
    extract_header: bool,
    extract_footer: bool,
    confidence_scores_granularity: str | None,
) -> dict:
    payload = {
        "model": model,
        "document": {"type": "file", "file_id": file_id},
        "include_image_base64": include_image_base64,
        "extract_header": extract_header,
        "extract_footer": extract_footer,
    }
    if table_format:
        payload["table_format"] = table_format
    if confidence_scores_granularity:
        payload["confidence_scores_granularity"] = confidence_scores_granularity

    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        OCR_API_URL,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Mistral OCR request failed: {exc.code} {detail}") from exc


def format_page_metadata(page: dict) -> list[str]:
    lines: list[str] = []
    page_idx = page.get("index")
    lines.extend([f"<!-- page:{page_idx} -->", ""])

    header = page.get("header")
    if header:
        lines.extend([f"> Header: {header.strip()}", ""])

    hyperlinks = page.get("hyperlinks") or []
    if hyperlinks:
        lines.append("<!-- hyperlinks")
        for link in hyperlinks:
            lines.append(json.dumps(link, ensure_ascii=False))
        lines.extend(["-->", ""])

    return lines


def format_page_footer(page: dict) -> list[str]:
    footer = page.get("footer")
    if not footer:
        return []
    return ["", f"> Footer: {footer.strip()}", ""]


def get_combined_markdown(
    ocr_response: dict,
    *,
    output_path: Path,
    save_local_images: bool,
    save_tables: bool,
) -> tuple[str, dict]:
    image_dir = output_path.parent / DEFAULT_IMAGES_DIR_NAME
    tables_md_dir = output_path.parent / "tables_md"
    tables_html_dir = output_path.parent / "tables_html"
    pages: list[str] = []
    asset_index = {"images": [], "tables": []}

    for page_idx, page in enumerate(ocr_response.get("pages", []), start=1):
        markdown = page.get("markdown", "") or ""
        images = page.get("images", []) or []
        tables = page.get("tables", []) or []

        image_refs: dict[str, str] = {}
        if save_local_images:
            for image in images:
                image_id = image.get("id")
                image_base64 = image.get("image_base64")
                if not image_id or not image_base64:
                    continue
                safe_id = f"page_{page_idx:02d}_{sanitize_stem(image_id)}"
                image_path = write_image_asset(safe_id, image_base64, image_dir)
                rel = os.path.relpath(image_path, output_path.parent)
                image_refs[image_id] = rel
                image_refs[Path(image_id).name] = rel
                asset_index["images"].append(
                    {
                        "page": page_idx,
                        "id": image_id,
                        "path": rel,
                    }
                )
            markdown = replace_image_placeholders(markdown, image_refs)

        table_refs: dict[str, str] = {}
        inline_tables: dict[str, str] = {}
        if save_tables:
            for table_idx, table in enumerate(tables, start=1):
                table_id = (
                    table.get("id")
                    or table.get("table_id")
                    or f"page_{page_idx:02d}_tbl_{table_idx}"
                )
                written = write_table_asset(
                    table_id=table_id,
                    table_payload=table,
                    markdown_dir=tables_md_dir,
                    html_dir=tables_html_dir,
                )
                if not written:
                    continue
                kind, path = written
                rel = os.path.relpath(path, output_path.parent)
                table_refs[table_id] = rel
                table_refs[Path(table_id).name] = rel
                if kind == "markdown":
                    content = path.read_text(encoding="utf-8").strip()
                    if content:
                        inline_tables[table_id] = f"\n\n{content}\n\n"
                        inline_tables[Path(table_id).name] = f"\n\n{content}\n\n"
                asset_index["tables"].append(
                    {
                        "page": page_idx,
                        "id": table_id,
                        "path": rel,
                        "format": kind,
                    }
                )
            markdown = replace_table_placeholders(markdown, table_refs, inline_tables)

        page_lines: list[str] = []
        page_lines.extend(format_page_metadata(page))
        page_lines.append(markdown.strip())
        page_lines.extend(format_page_footer(page))
        pages.append("\n".join(line for line in page_lines if line is not None).strip())

    return "\n\n".join(part for part in pages if part).strip() + "\n", asset_index


def build_asset_index(
    *,
    output_path: Path,
    asset_index: dict,
    response_json_path: Path,
):
    lines = [
        "# Asset Index",
        "",
        "## OCR Images (from Mistral)",
    ]
    if not asset_index["images"]:
        lines.append("- none")
    else:
        for item in asset_index["images"]:
            lines.append(f"- page {item['page']}: `{item['path']}`")

    lines += ["", "## OCR Tables (from Mistral)"]
    if not asset_index["tables"]:
        lines.append("- none")
    else:
        for item in asset_index["tables"]:
            lines.append(
                f"- page {item['page']}: `{item['path']}` ({item['format']})"
            )

    lines += ["", "## OCR Response", "", f"- `{response_json_path.name}`", ""]
    asset_index_path = output_path.parent / "asset_index.md"
    asset_index_path.write_text("\n".join(lines), encoding="utf-8")
    return asset_index_path


def convert_pdf_to_markdown(
    pdf_path: Path,
    *,
    output_path: Path | None = None,
    model: str = DEFAULT_MODEL,
    include_image_base64: bool = False,
    save_local_images: bool = True,
    signed_url_expiry_minutes: int = 10,
    table_format: str = "markdown",
    extract_header: bool = True,
    extract_footer: bool = True,
    confidence_scores_granularity: str = "page",
    save_response_json: bool = True,
) -> dict:
    del signed_url_expiry_minutes

    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    final_output = output_path or (pdf_path.parent / DEFAULT_MARKDOWN_NAME)
    final_output.parent.mkdir(parents=True, exist_ok=True)

    api_key = get_api_key()
    file_id = upload_file_via_rest(api_key, pdf_path)
    ocr_response = call_ocr_via_rest(
        api_key=api_key,
        file_id=file_id,
        model=model,
        include_image_base64=include_image_base64,
        table_format=table_format,
        extract_header=extract_header,
        extract_footer=extract_footer,
        confidence_scores_granularity=confidence_scores_granularity,
    )

    response_json_path = final_output.parent / DEFAULT_RESPONSE_JSON_NAME
    if save_response_json:
        response_json_path.write_text(
            json.dumps(ocr_response, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    combined_markdown, asset_index = get_combined_markdown(
        ocr_response,
        output_path=final_output,
        save_local_images=include_image_base64 and save_local_images,
        save_tables=bool(table_format),
    )
    final_output.write_text(combined_markdown, encoding="utf-8")
    asset_index_path = build_asset_index(
        output_path=final_output,
        asset_index=asset_index,
        response_json_path=response_json_path,
    )
    return {
        "markdown_path": final_output,
        "response_json_path": response_json_path,
        "asset_index_path": asset_index_path,
        "images_dir": final_output.parent / DEFAULT_IMAGES_DIR_NAME,
        "tables_md_dir": final_output.parent / "tables_md",
        "tables_html_dir": final_output.parent / "tables_html",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert a PDF to a rich Markdown draft using Mistral OCR REST API."
    )
    parser.add_argument("pdf", type=Path, help="Path to the PDF file")
    parser.add_argument("-o", "--output", type=Path, help="Output markdown path")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="OCR model name")
    parser.add_argument(
        "--signed-url-expiry-minutes",
        type=int,
        default=10,
        help="Deprecated option kept for compatibility; ignored in REST mode",
    )
    parser.add_argument(
        "--inline-images",
        action="store_true",
        help=(
            "Request image base64 from Mistral OCR, save those images beside the "
            "markdown file, and rewrite markdown references to local image paths"
        ),
    )
    parser.add_argument(
        "--keep-inline-images",
        action="store_true",
        help="Keep base64 image data inline in markdown instead of saving local image files",
    )
    parser.add_argument(
        "--table-format",
        choices=["markdown", "html", "none"],
        default="markdown",
        help="Request table extraction from Mistral OCR",
    )
    parser.add_argument(
        "--no-header-footer",
        action="store_true",
        help="Disable header/footer extraction",
    )
    parser.add_argument(
        "--confidence-scores-granularity",
        choices=["page", "word", "none"],
        default="page",
        help="Confidence score granularity",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    result = convert_pdf_to_markdown(
        args.pdf,
        output_path=args.output,
        model=args.model,
        include_image_base64=args.inline_images,
        save_local_images=not args.keep_inline_images,
        signed_url_expiry_minutes=args.signed_url_expiry_minutes,
        table_format=None if args.table_format == "none" else args.table_format,
        extract_header=not args.no_header_footer,
        extract_footer=not args.no_header_footer,
        confidence_scores_granularity=(
            None
            if args.confidence_scores_granularity == "none"
            else args.confidence_scores_granularity
        ),
    )
    print(result["markdown_path"])
    print(result["response_json_path"])
    print(result["asset_index_path"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
