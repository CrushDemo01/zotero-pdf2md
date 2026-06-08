# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Zotero 7 plugin for converting PDF attachments into Markdown and translated Markdown drafts. Core TypeScript code lives in `src/`: `src/hooks.ts` wires plugin lifecycle events, `src/modules/pdfActions.ts` registers PDF menu commands, `src/modules/runner.ts` invokes the local `pdf-to-md-zh` skill scripts, and `src/modules/resultNote.ts` writes results back into Zotero notes. Static addon files live in `addon/`, including `manifest.json`, `prefs.js`, and the preferences UI under `addon/content/`. Tests currently live in `test/`, with `startup.test.ts` covering plugin startup.

## Build, Test, and Development Commands

- `npm install`: install Node dependencies for the Zotero plugin scaffold.
- `npm run build`: build the production addon and run `tsc --noEmit`; output goes to `.scaffold/build/`.
- `npm start`: launch the scaffold dev server with hot reload for Zotero development.
- `./node_modules/.bin/tsc --noEmit`: fast type-check for TypeScript-only validation.
- `npm run lint:check`: run Prettier and ESLint checks.
- `npm run lint:fix`: auto-format and apply safe lint fixes.

## Coding Style & Naming Conventions

Use TypeScript with 2-space indentation and keep modules focused. Prefer `camelCase` for functions and variables, `PascalCase` for classes, and concise file names that match responsibility, for example `pdfActions.ts` or `resultNote.ts`. User-facing strings shown in Zotero should be written in Chinese. Formatting is handled by Prettier; lint rules come from `@zotero-plugin/eslint-config`.

## Testing Guidelines

Add tests under `test/` and keep names aligned with behavior, for example `pdf-actions.test.ts` or `runner.test.ts`. Run `./node_modules/.bin/tsc --noEmit` before every change, and use `npm run build` before release to verify the scaffold can package the addon. Prefer small, behavior-driven tests around menu registration, preference handling, and runner command construction.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes such as `build(deps): ...` and `build(deps-dev): ...`; follow the same pattern with clear scopes, for example `feat(pdf): add final markdown action`. Pull requests should include a short summary, affected Zotero UI entry points, manual test steps, and screenshots when preferences or menus change. Link related issues when applicable.

## Security & Configuration Tips

Do not hardcode API keys. Store `MISTRAL_API_KEY` and optional `OPENAI_API_KEY` in plugin preferences, and keep local paths such as the `pdf-to-md-zh` skill directory configurable through the preferences pane.
