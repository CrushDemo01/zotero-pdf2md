#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_MODEL = "gpt-5-mini"
DEFAULT_API_BASE = "https://api.openai.com/v1"
SYSTEM_PROMPT = (
    "You are validating whether academic formulas and structural math blocks are likely "
    "to display correctly in a Zotero note generated from markdown. "
    "Return strict JSON only with keys: status, summary, issues. "
    "Use status=pass when formulas appear structurally safe, warn when there are suspicious "
    "signs, and fail when there are clear raw-TeX or broken-math indicators."
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
    from urllib.parse import urlparse
    path = urlparse(base).path
    if "/v1" not in path:
        base = f"{base}/v1"
    return f"{base}{default_path}"


def call_chat_completions_api(*, api_key: str, model: str, api_base: str, prompt: str) -> str:
    url = _build_endpoint(api_base, "/chat/completions")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
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


def strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 2 and lines[-1].strip() == "```":
            return "\n".join(lines[1:-1]).strip()
    return stripped


def extract_math_samples(markdown_text: str) -> list[str]:
    samples: list[str] = []

    for match in re.finditer(r"\$\$(.*?)\$\$", markdown_text, flags=re.DOTALL):
        block = match.group(1).strip()
        if block:
            samples.append(block[:600])

    for line in markdown_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("\\begin{") or (
            "\\" in stripped
            and any(
                token in stripped
                for token in (
                    "\\mathbf",
                    "\\mathbb",
                    "\\mathcal",
                    "\\operatorname",
                    "\\tag",
                    "\\frac",
                    "\\sum",
                    "\\left",
                    "\\right",
                )
            )
        ):
            samples.append(stripped[:600])

    deduped: list[str] = []
    seen: set[str] = set()
    for sample in samples:
        key = sample.strip()
        if key and key not in seen:
            seen.add(key)
            deduped.append(key)
    return deduped[:16]


def build_diagnostics(markdown_text: str, html_text: str) -> str:
    display_blocks = len(re.findall(r"\$\$(.*?)\$\$", markdown_text, flags=re.DOTALL))
    inline_math = len(re.findall(r"(?<!\$)\$(?!\$).*?(?<!\$)\$(?!\$)", markdown_text))
    raw_tex_lines = [
        line.strip()
        for line in html_text.splitlines()
        if line.strip().startswith("\\begin{") or "\\operatorname" in line or "\\mathbf" in line
    ]
    katex_nodes = len(re.findall(r'class="katex"', html_text))
    mathml_nodes = len(re.findall(r"<math[\s>]", html_text))

    lines = [
        f"- Markdown display math block count: {display_blocks}",
        f"- Markdown inline math count: {inline_math}",
        f"- HTML katex node count: {katex_nodes}",
        f"- HTML mathml node count: {mathml_nodes}",
        f"- Raw TeX-looking HTML line count: {len(raw_tex_lines)}",
    ]
    for line in raw_tex_lines[:12]:
        lines.append(f"- Raw TeX line in HTML: {line[:240]}")
    return "\n".join(lines)


def build_prompt(title: str, diagnostics: str, math_samples: list[str]) -> str:
    samples = "\n\n".join(
        f"[Sample {idx + 1}]\n{sample}" for idx, sample in enumerate(math_samples)
    ) or "(no explicit math samples extracted)"
    return (
        f"Document title: {title}\n\n"
        "Validation goal: judge whether formulas are structurally likely to render correctly "
        "inside a Zotero note generated from markdown.\n\n"
        "Diagnostics:\n"
        f"{diagnostics}\n\n"
        "Extracted math samples from markdown:\n"
        f"{samples}\n\n"
        "Return strict JSON only. Example:\n"
        '{"status":"warn","summary":"...","issues":["...","..."]}\n\n'
        "Rules:\n"
        "- status=pass only when there is no obvious sign of raw or broken TeX remaining.\n"
        "- status=warn when most formulas look okay but there are suspicious leftovers or risky structures.\n"
        "- status=fail when raw TeX is clearly leaking into rendered HTML or multiple display formulas look broken.\n"
        "- issues must be short concrete strings, max 6 items.\n"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate markdown-to-note formula structure using an OpenAI-compatible Chat Completions API."
    )
    parser.add_argument("--markdown", required=True, type=Path, help="Source markdown file")
    parser.add_argument("--html", required=True, type=Path, help="Rendered HTML preview file")
    parser.add_argument("--out-json", required=True, type=Path, help="Validation result JSON path")
    parser.add_argument("--title", help="Document title used in prompts")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Chat Completions model name")
    parser.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        help="Chat Completions API base URL or full endpoint URL",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    markdown_path = args.markdown.resolve()
    html_path = args.html.resolve()
    out_json = args.out_json.resolve()
    title = args.title or markdown_path.stem

    if not markdown_path.exists():
        raise FileNotFoundError(f"Markdown file not found: {markdown_path}")
    if not html_path.exists():
        raise FileNotFoundError(f"HTML preview file not found: {html_path}")

    api_key = get_env_or_raise("OPENAI_API_KEY")
    markdown_text = markdown_path.read_text(encoding="utf-8")
    html_text = html_path.read_text(encoding="utf-8")
    diagnostics = build_diagnostics(markdown_text, html_text)
    samples = extract_math_samples(markdown_text)
    prompt = build_prompt(title, diagnostics, samples)

    raw = call_chat_completions_api(
      api_key=api_key,
      model=args.model,
      api_base=args.api_base,
      prompt=prompt,
    )
    parsed = json.loads(strip_code_fences(raw))
    status = parsed.get("status")
    if status not in {"pass", "warn", "fail"}:
        raise RuntimeError(f"Unexpected validation status: {status}")

    result = {
        "status": status,
        "summary": str(parsed.get("summary") or "").strip(),
        "issues": [
            str(item).strip()
            for item in (parsed.get("issues") or [])
            if str(item).strip()
        ][:6],
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(out_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
