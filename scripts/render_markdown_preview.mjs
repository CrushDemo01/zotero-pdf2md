#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";

function usage() {
  console.error(
    "Usage: node scripts/render_markdown_preview.mjs <input.md> [output.html]",
  );
}

function isAbsoluteLink(target) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

function isAbsoluteFileSystemPath(target) {
  return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
}

function splitTargetParts(target) {
  const trimmed = String(target || "").trim();
  const hashIndex = trimmed.indexOf("#");
  const queryIndex = trimmed.indexOf("?");
  const splitIndex =
    hashIndex >= 0 && queryIndex >= 0
      ? Math.min(hashIndex, queryIndex)
      : Math.max(hashIndex, queryIndex);
  return {
    rawPath: splitIndex >= 0 ? trimmed.slice(0, splitIndex) : trimmed,
    suffix: splitIndex >= 0 ? trimmed.slice(splitIndex) : "",
  };
}

function resolveMarkdownTarget(markdownPath, target) {
  const trimmed = String(target || "").trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return trimmed;
  }
  if (isAbsoluteLink(trimmed) || isAbsoluteFileSystemPath(trimmed)) {
    return trimmed;
  }

  const { rawPath, suffix } = splitTargetParts(trimmed);
  return path.join(path.dirname(markdownPath), rawPath) + suffix;
}

function toFileUri(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return `file://${normalized}`;
}

function getMimeType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function readBinaryDataUri(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    return `data:${getMimeType(filePath)};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getFallbackSearchRoots(markdownPath) {
  const roots = [
    path.dirname(markdownPath),
    process.cwd(),
    path.join(process.env.HOME || "", "Zotero", "storage"),
  ];
  return Array.from(
    new Set(
      roots
        .filter(Boolean)
        .map((root) => path.resolve(root))
        .filter((root) => fsSync.existsSync(root)),
    ),
  );
}

const recursiveSearchCache = new Map();

async function findFileUnderRoot(rootDir, relativeTarget) {
  const normalizedSuffix = relativeTarget.replace(/\\/g, "/").replace(/^\/+/, "");
  const cacheKey = `${rootDir}::${normalizedSuffix}`;
  if (recursiveSearchCache.has(cacheKey)) {
    return recursiveSearchCache.get(cacheKey);
  }

  const basename = path.basename(normalizedSuffix);
  const stack = [rootDir];
  while (stack.length) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const normalizedFullPath = fullPath.replace(/\\/g, "/");
      if (
        entry.name === basename ||
        normalizedFullPath.endsWith(`/${normalizedSuffix}`)
      ) {
        recursiveSearchCache.set(cacheKey, fullPath);
        return fullPath;
      }
    }
  }

  recursiveSearchCache.set(cacheKey, undefined);
  return undefined;
}

async function resolveExistingLocalFile(markdownPath, target) {
  const trimmed = String(target || "").trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const resolved = resolveMarkdownTarget(markdownPath, trimmed);
  if (isAbsoluteLink(resolved) && !resolved.startsWith("file://")) {
    return undefined;
  }

  const directPath = resolved.startsWith("file://")
    ? new URL(resolved).pathname
    : resolved;
  if (directPath && (await pathExists(directPath))) {
    return directPath;
  }

  if (isAbsoluteFileSystemPath(trimmed)) {
    return undefined;
  }

  const { rawPath } = splitTargetParts(trimmed);
  for (const rootDir of getFallbackSearchRoots(markdownPath)) {
    const candidate = path.join(rootDir, rawPath);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  for (const rootDir of getFallbackSearchRoots(markdownPath)) {
    const discovered = await findFileUnderRoot(rootDir, rawPath);
    if (discovered) {
      return discovered;
    }
  }

  return undefined;
}

async function replaceAsync(input, pattern, replacer) {
  const matches = Array.from(input.matchAll(pattern));
  if (!matches.length) {
    return input;
  }

  let cursor = 0;
  const pieces = [];
  for (const match of matches) {
    const index = match.index ?? 0;
    pieces.push(input.slice(cursor, index));
    pieces.push(await replacer(...match));
    cursor = index + match[0].length;
  }
  pieces.push(input.slice(cursor));
  return pieces.join("");
}

async function inlineLocalImages(markdownPath, markdown) {
  return replaceAsync(
    markdown,
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    async (full, alt, target, title) => {
      const resolved = resolveMarkdownTarget(markdownPath, target);
      if (isAbsoluteLink(resolved) && !resolved.startsWith("file://")) {
        return full;
      }
      const filePath = await resolveExistingLocalFile(markdownPath, target);
      const dataUri = await readBinaryDataUri(filePath);
      if (!dataUri) {
        return full;
      }
      const titlePart = title ? ` "${title}"` : "";
      return `![${alt}](${dataUri}${titlePart})`;
    },
  );
}

function createMarkdownRenderer() {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
  });

  md.use(texmath, {
    engine: katex,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: {
      throwOnError: false,
      output: "mathml",
      strict: "ignore",
    },
  });

  const defaultImageRule =
    md.renderer.rules.image ||
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));
  const defaultLinkOpenRule =
    md.renderer.rules.link_open ||
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet("src") || "";
    const markdownPath = typeof env?.markdownPath === "string" ? env.markdownPath : "";
    const resolved = resolveMarkdownTarget(markdownPath, src);
    token.attrSet("src", isAbsoluteLink(resolved) ? resolved : toFileUri(resolved));
    return defaultImageRule(tokens, idx, options, env, self);
  };

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet("href") || "";
    const markdownPath = typeof env?.markdownPath === "string" ? env.markdownPath : "";
    const resolved = resolveMarkdownTarget(markdownPath, href);
    token.attrSet("href", isAbsoluteLink(resolved) ? resolved : toFileUri(resolved));
    return defaultLinkOpenRule(tokens, idx, options, env, self);
  };

  return md;
}

function wrapHtml(title, bodyHtml) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0 auto;
      max-width: 980px;
      padding: 32px 24px 80px;
      background: #171717;
      color: #f3f3f3;
      font: 18px/1.7 "Georgia", "Times New Roman", serif;
    }
    img { max-width: 100%; height: auto; display: block; margin: 1em 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #666; padding: 0.45em 0.6em; vertical-align: top; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #111; padding: 12px 14px; border-radius: 8px; }
    code { background: rgba(255,255,255,0.08); padding: 0.08em 0.3em; border-radius: 4px; }
    pre code { background: transparent; padding: 0; }
    blockquote { border-left: 4px solid #888; margin: 1em 0; padding: 0.1em 1em; color: #ddd; }
    a { color: #9ecbff; }
    hr { border: none; border-top: 1px solid #555; margin: 1.5em 0; }
    .katex-display { overflow-x: auto; overflow-y: hidden; padding: 0.4em 0; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input) {
    usage();
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  const outputPath = output
    ? path.resolve(output)
    : path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.preview.html`);
  const markdown = await fs.readFile(inputPath, "utf8");
  const prepared = await inlineLocalImages(inputPath, markdown);
  const renderer = createMarkdownRenderer();
  const htmlBody = renderer.render(prepared, { markdownPath: inputPath });
  const html = wrapHtml(path.basename(inputPath), htmlBody);
  await fs.writeFile(outputPath, html, "utf8");
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
