# Contributing

Thanks for contributing to `zotero-pdf2md`.

## Development setup

1. Install Node.js 20+ and Python 3.10+.
2. Copy `.env.example` to `.env` and configure your local Zotero development profile.
3. Install dependencies:

```bash
npm install
```

4. Start the development server:

```bash
npm start
```

## Before opening a pull request

Run:

```bash
npm run build
npm run lint:check
```

If you changed workflow behavior, test these actions inside Zotero:

- `PDF 转 Markdown`
- `PDF 转 Markdown 并翻译`
- `Markdown→HTML（快速）`
- `Markdown→HTML（复核增强）`

## Contribution guidelines

- Keep user-facing strings in Chinese unless there is a strong reason not to.
- Do not commit API keys, `.env`, local preview outputs, or personal paths.
- Prefer small, focused pull requests.
- If you change OCR, translation, or HTML rendering behavior, include:
  - what changed
  - why it changed
  - one concrete before/after example

## Reporting bugs

When reporting a bug, include:

- Zotero version
- plugin version
- operating system
- the exact action you clicked
- whether the failure happened during OCR, translation, or HTML preview
- relevant `prepare.log` / `final_translation.log` / `*.review.log` output if available
