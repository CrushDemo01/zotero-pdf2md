#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

from workflow_common import DEFAULT_CHUNK_CHARS


DEFAULT_MODEL = "gpt-5-mini"
DEFAULT_API_BASE = "https://api.openai.com/v1"
IMAGE_TOKEN_RE = r"\[\[\[PDF2MD_IMAGE_(\d+)\]\]\]"
SYSTEM_PROMPT = (
    "You are reviewing academic markdown after a local HTML preview was generated. "
    "Return only corrected markdown for the current chunk. Preserve the current "
    "language and do not translate. Keep citations, equations, markdown tables, "
    "links, and image syntax intact unless fixing a clear error. Fix only obvious "
    "issues such as broken image references reported by the renderer, malformed OCR "
    "captions, duplicated image lines, placeholder text, and clearly corrupted "
    "equation text. If uncertain, keep the original wording."
)


def get_env_or_raise(name: str) -> str:
    import os

    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def _build_endpoint(api_base: str, default_path: str) -> str:
    base = api_base.rstrip("/")
    if base.endswith("/chat/completions") or base.endswith("/responses"):
        return base
    return f"{base}{default_path}"


def call_chat_completions_api(
    *,
    api_key: str,
    model: str,
    api_base: str,
    prompt: str,
) -> str:
    url = _build_endpoint(api_base, "/chat/completions")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(
            f"Chat Completions API request failed: {exc.code} {detail}"
        ) from exc

    choices = body.get("choices") or []
    message = (choices[0] or {}).get("message", {}) if choices else {}
    content = message.get("content", "")
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        text = "\n".join(part for part in parts if part).strip()
    else:
        text = str(content or "").strip()
    if not text:
        raise RuntimeError("Chat Completions API returned empty content")
    return text


def protect_image_syntax(text: str) -> tuple[str, dict[str, str]]:
    image_map: dict[str, str] = {}
    counter = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal counter
        counter += 1
        token = f"[[[PDF2MD_IMAGE_{counter}]]]"
        image_map[token] = match.group(0)
        return token

    patterns = [r"!\[[^\]]*\]\([^)]+\)", r'<img\b[^>]*?>']
    protected = text
    for pattern in patterns:
        protected = re.sub(pattern, repl, protected, flags=re.IGNORECASE)
    return protected, image_map


def restore_image_syntax(text: str, image_map: dict[str, str]) -> str:
    restored = text
    for token, original in image_map.items():
        restored = restored.replace(token, original)
        restored = restored.replace(f"`{token}`", original)
        restored = restored.replace(f"` {token} `", original)

    token_line_re = re.compile(rf"`?\s*{IMAGE_TOKEN_RE}\s*`?")

    def repl(match: re.Match[str]) -> str:
        token = f"[[[PDF2MD_IMAGE_{match.group(1)}]]]"
        return image_map.get(token, match.group(0))

    return token_line_re.sub(repl, restored)


def build_html_diagnostics(html_text: str) -> str:
    diagnostics: list[str] = []
    file_srcs = re.findall(r'<img\b[^>]*\bsrc="(file://[^"]+)"', html_text, flags=re.IGNORECASE)
    data_srcs = re.findall(r'<img\b[^>]*\bsrc="(data:[^"]+)"', html_text, flags=re.IGNORECASE)
    raw_tex_hits = re.findall(r"(\\[a-zA-Z]+(?:\{[^}]*\})?)", html_text)

    diagnostics.append(f"- HTML image count with inlined data URIs: {len(data_srcs)}")
    diagnostics.append(f"- HTML image count with local file:// URIs: {len(file_srcs)}")
    if file_srcs:
        for src in file_srcs[:20]:
            diagnostics.append(f"- Broken-or-local image URI seen in HTML: {src}")
    if raw_tex_hits:
        preview = ", ".join(raw_tex_hits[:12])
        diagnostics.append(f"- Raw TeX fragments still visible in HTML: {preview}")
    else:
        diagnostics.append("- No obvious raw TeX fragments detected in HTML preview.")
    return "\n".join(diagnostics)


def build_review_prompt(
    *,
    title: str,
    markdown_body: str,
    html_path: Path,
    diagnostics: str,
) -> str:
    return (
        f"Document title: {title}\n\n"
        f"Rendered HTML preview path: {html_path}\n\n"
        "HTML diagnostics:\n"
        f"{diagnostics}\n\n"
        "Review the following full markdown document. Preserve the original language and "
        "structure. Do not translate. Correct only clear issues that would improve "
        "the generated HTML preview or fix obvious OCR/formatting mistakes. Keep "
        "image markers and markdown image syntax unchanged unless removing an exact "
        "duplicate or moving an image to a clearly better nearby position.\n\n"
        "Document source markdown:\n"
        f"{markdown_body}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Review markdown after HTML generation using an OpenAI-compatible Chat Completions API."
    )
    parser.add_argument("--markdown", required=True, type=Path, help="Markdown file to review")
    parser.add_argument("--html", required=True, type=Path, help="Rendered HTML preview file")
    parser.add_argument("--out-md", required=True, type=Path, help="Reviewed markdown output path")
    parser.add_argument("--title", help="Document title used in prompts")
    parser.add_argument(
        "--chunk-chars",
        type=int,
        default=DEFAULT_CHUNK_CHARS,
        help="Reserved for future chunked review flow",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Chat Completions model name")
    parser.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        help="Chat Completions API base URL or full endpoint URL",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    markdown_path = args.markdown.resolve()
    html_path = args.html.resolve()
    out_md = args.out_md.resolve()
    title = args.title or markdown_path.stem

    if not markdown_path.exists():
        raise FileNotFoundError(f"Markdown file not found: {markdown_path}")
    if not html_path.exists():
        raise FileNotFoundError(f"HTML preview file not found: {html_path}")

    api_key = get_env_or_raise("OPENAI_API_KEY")
    source_text = markdown_path.read_text(encoding="utf-8")
    html_text = html_path.read_text(encoding="utf-8")
    diagnostics = build_html_diagnostics(html_text)
    if not source_text.strip():
        raise RuntimeError(f"No usable content found in {markdown_path}")

    out_md.parent.mkdir(parents=True, exist_ok=True)
    protected_body, image_map = protect_image_syntax(source_text)
    prompt = build_review_prompt(
        title=title,
        markdown_body=protected_body,
        html_path=html_path,
        diagnostics=diagnostics,
    )
    reviewed = call_chat_completions_api(
        api_key=api_key,
        model=args.model,
        api_base=args.api_base,
        prompt=prompt,
    )
    restored = restore_image_syntax(reviewed.strip(), image_map)
    out_md.write_text(restored.rstrip() + "\n", encoding="utf-8")
    print(out_md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
