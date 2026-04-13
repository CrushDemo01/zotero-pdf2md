# zotero-pdf2md v0.1.0

First public release of `zotero-pdf2md`.

## Highlights

- Convert Zotero PDF attachments to OCR Markdown with Mistral OCR
- Translate OCR Markdown into a target language with an OpenAI-compatible LLM API
- Generate local HTML previews for Markdown attachments
- Create Zotero child notes for result summaries and HTML previews
- Attach generated Markdown, HTML preview, and asset index files under the parent item

## Right-click actions

- `PDF 转 Markdown`
- `PDF 转 Markdown 并翻译`
- `Markdown→HTML（快速）`
- `Markdown→HTML（复核增强）`

## Rendering improvements

- Inline local images into HTML previews when possible
- Fallback image lookup for relocated Markdown files
- Native MathML output for more stable formula rendering in Zotero/Firefox-based views

## Configuration

The plugin settings support:

- source language
- target language
- Python path
- Mistral API key
- LLM API key
- LLM Base URL
- model name
- optional HTML review after generation

## Notes

- Mistral OCR requires a valid `MISTRAL_API_KEY`
- translation and review require an OpenAI-compatible API
- generated logs may appear as attachments when workflow steps fail
