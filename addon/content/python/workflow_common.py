#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


DEFAULT_CHUNK_CHARS = 5000
DEFAULT_MISTRAL_MD_NAME = "mistral.md"
DEFAULT_OCR_JSON_NAME = "ocr.json"

HEADER_NOTE = (
    "> 分块写入稿：请按“阅读当前块 → 翻译当前块 → 立即写入”的方式持续完成全文。\n"
)


@dataclass
class Chunk:
    title: str
    body: str


def run_step(cmd: list[str]) -> None:
    print("running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def load_manifest(outdir: Path) -> dict:
    manifest_path = outdir / "translation_prep.json"
    if not manifest_path.exists():
        return {}
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_markdown_sections(text: str) -> list[Chunk]:
    text = normalize_text(text)
    if not text:
        return []

    heading_re = re.compile(r"(?m)^(#{1,6})\s+(.+?)\s*$")
    matches = list(heading_re.finditer(text))
    if not matches:
        return [Chunk(title="全文初稿", body=text)]

    chunks: list[Chunk] = []
    preface = text[: matches[0].start()].strip()
    if preface:
        chunks.append(Chunk(title="前置内容", body=preface))

    for idx, match in enumerate(matches):
        title = match.group(2).strip()
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if body:
            chunks.append(Chunk(title=title, body=body))
    return chunks


def split_large_chunk(chunk: Chunk, max_chars: int) -> list[Chunk]:
    body = chunk.body.strip()
    if len(body) <= max_chars:
        return [chunk]

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    if not paragraphs:
        return [Chunk(title=chunk.title, body=body[:max_chars])]

    out: list[Chunk] = []
    part = 1
    current: list[str] = []
    current_len = 0

    for para in paragraphs:
        addition = len(para) + (2 if current else 0)
        if current and current_len + addition > max_chars:
            out.append(Chunk(title=f"{chunk.title}（第{part}段）", body="\n\n".join(current)))
            part += 1
            current = [para]
            current_len = len(para)
            continue
        current.append(para)
        current_len += addition

    if current:
        suffix = f"（第{part}段）" if part > 1 else ""
        out.append(Chunk(title=f"{chunk.title}{suffix}", body="\n\n".join(current)))

    return out


def chunk_source_text(text: str, max_chars: int) -> list[Chunk]:
    chunks: list[Chunk] = []
    for section in split_markdown_sections(text):
        chunks.extend(split_large_chunk(section, max_chars=max_chars))
    return chunks


def read_asset_index(asset_index: Path) -> str:
    if not asset_index.exists():
        return "- 未找到 `asset_index.md`，请直接参考原 PDF 页面。"

    lines = asset_index.read_text(encoding="utf-8").splitlines()
    bullet_lines = [ln for ln in lines if ln.startswith("- ")]
    if not bullet_lines:
        return f"- 资产索引存在，但没有可用条目：`{asset_index.name}`"

    preview = bullet_lines[:12]
    if len(bullet_lines) > 12:
        preview.append(f"- 其余条目请见 `{asset_index.name}`")
    return "\n".join(preview)


def write_markdown_chunk(
    *,
    out_md: Path,
    title: str,
    body: str,
    append: bool,
    chunk_label: str | None = None,
) -> None:
    body = body.strip()
    if not body:
        raise RuntimeError("body markdown is empty")

    if append and out_md.exists():
        parts = ["\n\n---\n\n"]
        if chunk_label:
            parts.append(f"## {chunk_label}\n\n")
        parts.append(body)
        with out_md.open("a", encoding="utf-8") as handle:
            handle.write("".join(parts))
        return

    parts = [f"# {title}（中文译稿）\n\n", HEADER_NOTE, "\n"]
    if chunk_label:
        parts.append(f"## {chunk_label}\n\n")
    parts.append(body)
    parts.append("\n")
    out_md.write_text("".join(parts), encoding="utf-8")
