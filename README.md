# zotero-pdf2md

[简体中文](doc/README-zhCN.md)

`zotero-pdf2md` is a Zotero 7 plugin that converts PDF attachments into Markdown packages, translated Markdown, and HTML previews.

It uses:

- Mistral OCR for PDF-to-Markdown extraction
- an OpenAI-compatible LLM API for translation and optional review
- local HTML preview generation with images inlined for reliable viewing inside and outside Zotero

## Features

- Right-click a PDF attachment to run:
  - `PDF 转 Markdown`
  - `PDF 转 Markdown 并翻译`
- Right-click a Markdown attachment to run:
  - `Markdown→HTML（快速）`
  - `Markdown→HTML（复核增强）`
- Attach generated `mistral.md`, `target.md`, `asset_index.md`, and `*.preview.html` files under the parent Zotero item
- Create Zotero child notes for result summaries and HTML previews
- Preserve OCR images and render formulas with native MathML for better Zotero compatibility

## Current limitations

- HTML preview formulas are still not fully reliable inside Zotero note rendering.
- In particular, some MathML/TeX expressions may not render correctly in Zotero's built-in HTML note view.
- If formula fidelity matters, prefer opening the generated `*.preview.html` file externally in a browser, or use the Markdown output as the source of truth.

## Requirements

- Zotero 7
- Node.js 20+ for development
- Python 3.10+ for the bundled OCR/translation scripts
- A `MISTRAL_API_KEY`
- An OpenAI-compatible API key, base URL, and model for translation or HTML review

## Install

### End users

1. Download the latest `.xpi` from Releases.
2. In Zotero, open `Tools -> Plugins`.
3. Install the `.xpi`.
4. Open the plugin settings and fill in:
   - `Mistral API 密钥`
   - `LLM API 密钥`
   - `LLM Base URL`
   - `模型名称`

### From source

```bash
npm install
npm run build
```

The packaged add-on is generated at:

```text
.scaffold/build/zotero-pdf-2-md.xpi
```

## Development

Copy `.env.example` to `.env`, set your Zotero binary/profile paths, then run:

```bash
npm start
```

Or use the helper script:

```bash
./start-dev.sh
```

Useful commands:

- `npm start`: run dev build and hot reload
- `npm run build`: production build + TypeScript check
- `npm run test`: run scaffold tests
- `npm run lint:check`: check formatting and lint
- `npm run lint:fix`: auto-fix formatting and lint issues

## Configuration

The preference pane exposes:

- source language
- target language
- Python path
- `Mistral API 密钥`
- `LLM API 密钥`
- `LLM Base URL`
- `模型名称`
- `生成 HTML 后使用 LLM 复核 Markdown`
- `将 OCR 内联图片保存为本地文件`

No API keys are stored in the repository. Keep them in Zotero plugin preferences or your local environment only.

## Repository layout

- `src/`: TypeScript plugin code
- `addon/`: Zotero manifest, prefs, locales, and bundled Python scripts
- `addon/content/python/`: OCR, translation, and HTML review scripts
- `scripts/`: local development helpers
- `doc/`: localized README files

## Release checklist

Before publishing:

1. Make sure `.env`, logs, generated previews, and local test files are not committed.
2. Run `npm run build`.
3. Test the four main menu actions in Zotero.
4. Verify plugin settings text and generated attachments.
5. Upload `.scaffold/build/zotero-pdf-2-md.xpi` to GitHub Releases.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
