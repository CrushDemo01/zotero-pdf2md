import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";

type ResultNoteSourceItem = Zotero.Item & {
  id?: number;
  parentItemID?: number;
  isAttachment?: () => boolean;
  isNote?: () => boolean;
  getNote?: () => string;
  setNote?: (html: string) => void;
  saveTx?: () => Promise<unknown>;
};

export interface ResultNoteMetadata {
  title: string;
  statusText: string;
  outputDir: string;
  markdownPaths: string[];
  excerptChars?: number;
  noteKey?: string;
  existingNoteID?: number;
}

const NOTE_MARKER = "zotero-pdf2md-result-note";
const PREVIEW_NOTE_MARKER = "zotero-pdf2md-markdown-preview";
const PREVIEW_RENDERER_VERSION = "mdit-v4";
const discoveredFileCache = new Map<string, string | undefined>();
const LATEX_COMMAND_RE =
  /\\(?:begin|end|operatorname|mathbf|mathbb|mathcal|mathrm|left|right|frac|sum|prod|tag|cdot|odot|hat|quad|dots|leq|geq|sigma|log|exp|text|in|forall|limits|tau|top|mid|Softmax|Dec|Fuse|triangleq)\b/;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

function basename(filePath: string) {
  const normalized = normalizePath(filePath);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function dirname(filePath: string) {
  const normalized = normalizePath(filePath);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : "";
}

function toFileURI(filePath: string) {
  try {
    const uri = (Zotero as any).File?.pathToFileURI?.(filePath);
    return typeof uri === "string" ? uri : `file://${normalizePath(filePath)}`;
  } catch (_error) {
    return `file://${normalizePath(filePath)}`;
  }
}

function buildPathLink(path: string, label?: string) {
  const href = escapeHtml(toFileURI(path));
  const text = escapeHtml(label || path);
  return `<a href="${href}">${text}</a>`;
}

function getMimeType(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function isAbsoluteLink(target: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

function isAbsoluteFileSystemPath(target: string) {
  return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
}

function resolveMarkdownTarget(markdownPath: string, target: string) {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return trimmed;
  }
  if (isAbsoluteLink(trimmed)) {
    return trimmed;
  }
  if (isAbsoluteFileSystemPath(trimmed)) {
    return trimmed;
  }

  const hashIndex = trimmed.indexOf("#");
  const queryIndex = trimmed.indexOf("?");
  const splitIndex =
    hashIndex >= 0 && queryIndex >= 0
      ? Math.min(hashIndex, queryIndex)
      : Math.max(hashIndex, queryIndex);
  const rawPath = splitIndex >= 0 ? trimmed.slice(0, splitIndex) : trimmed;
  const suffix = splitIndex >= 0 ? trimmed.slice(splitIndex) : "";
  const baseDir = dirname(markdownPath);
  if (!baseDir || !rawPath) {
    return trimmed;
  }

  try {
    return `${PathUtils.join(baseDir, rawPath)}${suffix}`;
  } catch (_error) {
    return trimmed;
  }
}

function splitTargetParts(target: string) {
  const trimmed = target.trim();
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

function fileUriToPath(target: string) {
  try {
    const url = new URL(target);
    return decodeURIComponent(url.pathname);
  } catch (_error) {
    return target.replace(/^file:\/\//, "");
  }
}

function slugifyKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveParentID(item: ResultNoteSourceItem) {
  if (typeof item.parentItemID === "number" && item.parentItemID > 0) {
    return item.parentItemID;
  }
  if (typeof item.id === "number" && item.id > 0) {
    return item.id;
  }
  return undefined;
}

function buildNoteKey(parentID: number, metadata: ResultNoteMetadata) {
  if (metadata.noteKey) {
    return metadata.noteKey;
  }
  return [
    parentID,
    slugifyKey(metadata.title),
    slugifyKey(metadata.outputDir),
  ].join(":");
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  const file = (Components.classes as any)[
    "@mozilla.org/file/local;1"
  ].createInstance((Components.interfaces as any).nsIFile);
  file.initWithPath(filePath);
  if (!file.exists()) {
    return undefined;
  }

  if (typeof (Zotero as any).File?.getContentsAsync === "function") {
    return await (Zotero as any).File.getContentsAsync(filePath);
  }

  return await new Promise<string>((resolve, reject) => {
    const inputStream = (Components.classes as any)[
      "@mozilla.org/network/file-input-stream;1"
    ].createInstance((Components.interfaces as any).nsIFileInputStream);
    const converter = (Components.classes as any)[
      "@mozilla.org/intl/converter-input-stream;1"
    ].createInstance((Components.interfaces as any).nsIConverterInputStream);

    try {
      inputStream.init(file, 0x01, 0o444, 0);
      converter.init(inputStream, "UTF-8", 0, 0);

      const data = { value: "" };
      let text = "";
      while (converter.readString(0x1000, data) !== 0) {
        text += data.value;
      }
      resolve(text);
    } catch (error) {
      reject(error);
    } finally {
      try {
        converter.close();
      } catch (_error) {
        // ignore close errors
      }
      try {
        inputStream.close();
      } catch (_error) {
        // ignore close errors
      }
    }
  });
}

async function readBinaryDataUri(filePath: string) {
  try {
    const bytes = await IOUtils.read(filePath);
    const byteArray = bytes as Uint8Array & {
      toBase64?: (options?: { omitPadding?: boolean }) => string;
    };
    let base64 = "";
    if (typeof byteArray.toBase64 === "function") {
      base64 = byteArray.toBase64({ omitPadding: false });
    } else {
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.slice(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
      }
      base64 = btoa(binary);
    }
    return `data:${getMimeType(filePath)};base64,${base64}`;
  } catch (_error) {
    return undefined;
  }
}

function pathExists(filePath: string) {
  try {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance((Components.interfaces as any).nsIFile);
    file.initWithPath(filePath);
    return file.exists();
  } catch (_error) {
    return false;
  }
}

function getHomeDir() {
  try {
    const homeDir = (Services as any).dirsvc.get(
      "Home",
      (Components.interfaces as any).nsIFile,
    );
    return typeof homeDir?.path === "string" ? homeDir.path : "";
  } catch (_error) {
    return "";
  }
}

function getFallbackSearchRoots(markdownPath: string) {
  const roots = [
    dirname(markdownPath),
    PathUtils.parent(markdownPath),
    PathUtils.parent(dirname(markdownPath)),
    PathUtils.join(getHomeDir(), "Zotero", "storage"),
  ];
  return Array.from(
    new Set(
      roots.filter(
        (root): root is string =>
          !!root && typeof root === "string" && pathExists(root),
      ),
    ),
  );
}

async function findFileUnderRoot(rootDir: string, relativeTarget: string) {
  const normalizedSuffix = normalizePath(relativeTarget).replace(/^\/+/, "");
  const cacheKey = `${rootDir}::${normalizedSuffix}`;
  if (discoveredFileCache.has(cacheKey)) {
    return discoveredFileCache.get(cacheKey);
  }

  const targetName = basename(normalizedSuffix);
  const stack = [rootDir];
  while (stack.length) {
    const currentDir = stack.pop()!;
    let children: string[] = [];
    try {
      children = await IOUtils.getChildren(currentDir);
    } catch (_error) {
      continue;
    }

    for (const child of children) {
      if (!pathExists(child)) {
        continue;
      }
      let stat: Awaited<ReturnType<typeof IOUtils.stat>> | undefined;
      try {
        stat = await IOUtils.stat(child);
      } catch (_error) {
        continue;
      }
      if (stat?.type === "directory") {
        stack.push(child);
        continue;
      }
      if (stat?.type !== "regular") {
        continue;
      }
      const normalizedChild = normalizePath(child);
      if (
        basename(normalizedChild) === targetName ||
        normalizedChild.endsWith(`/${normalizedSuffix}`)
      ) {
        discoveredFileCache.set(cacheKey, child);
        return child;
      }
    }
  }

  discoveredFileCache.set(cacheKey, undefined);
  return undefined;
}

async function resolveExistingLocalFile(markdownPath: string, target: string) {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const resolved = resolveMarkdownTarget(markdownPath, trimmed);
  if (isAbsoluteLink(resolved) && !resolved.startsWith("file://")) {
    return undefined;
  }

  const directPath = resolved.startsWith("file://")
    ? fileUriToPath(resolved)
    : resolved;
  if (directPath && pathExists(directPath)) {
    return directPath;
  }

  if (isAbsoluteFileSystemPath(trimmed)) {
    return undefined;
  }

  const { rawPath } = splitTargetParts(trimmed);
  for (const rootDir of getFallbackSearchRoots(markdownPath)) {
    try {
      const candidate = PathUtils.join(rootDir, rawPath);
      if (pathExists(candidate)) {
        return candidate;
      }
    } catch (_error) {
      // ignore bad candidate joins
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

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (...args: any[]) => Promise<string>,
) {
  const matches = Array.from(input.matchAll(pattern));
  if (!matches.length) {
    return input;
  }

  let cursor = 0;
  const pieces: string[] = [];
  for (const match of matches) {
    const index = match.index ?? 0;
    pieces.push(input.slice(cursor, index));
    pieces.push(await replacer(...match));
    cursor = index + match[0].length;
  }
  pieces.push(input.slice(cursor));
  return pieces.join("");
}

async function inlineLocalImages(markdownPath: string, markdown: string) {
  return replaceAsync(
    markdown,
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    async (full: string, alt: string, target: string, title?: string) => {
      const filePath = await resolveExistingLocalFile(markdownPath, target);
      if (!filePath) {
        return full;
      }
      const dataUri = await readBinaryDataUri(filePath);
      if (!dataUri) {
        return full;
      }
      const titlePart = title ? ` "${title}"` : "";
      return `![${alt}](${dataUri}${titlePart})`;
    },
  );
}

async function readMarkdownExcerpt(markdownPath: string, excerptChars: number) {
  const text = await readTextFile(markdownPath);
  if (!text) {
    return undefined;
  }

  const cleaned = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!cleaned) {
    return undefined;
  }

  if (cleaned.length <= excerptChars) {
    return cleaned;
  }

  const clipped = cleaned.slice(0, excerptChars);
  const lastParagraphBreak = clipped.lastIndexOf("\n\n");
  if (lastParagraphBreak > Math.max(0, excerptChars * 0.6)) {
    return `${clipped.slice(0, lastParagraphBreak).trimEnd()}\n\n[...]`;
  }

  const lastLineBreak = clipped.lastIndexOf("\n");
  if (lastLineBreak > Math.max(0, excerptChars * 0.75)) {
    return `${clipped.slice(0, lastLineBreak).trimEnd()}\n\n[...]`;
  }

  return `${clipped.trimEnd()}\n\n[...]`;
}

function buildMarkdownExcerptSection(markdownPath: string, excerpt: string) {
  return [
    `<details>`,
    `<summary>${buildPathLink(markdownPath, basename(markdownPath))}</summary>`,
    `<p><code>${escapeHtml(markdownPath)}</code></p><p>${buildPathLink(markdownPath, "打开文件")}</p>`,
    `<pre>${escapeHtml(excerpt)}</pre>`,
    `</details>`,
  ].join("");
}

function buildResultNoteHtml(
  metadata: ResultNoteMetadata,
  noteKey: string,
  excerptMap: Map<string, string>,
) {
  const markdownItems = metadata.markdownPaths
    .filter(Boolean)
    .map((markdownPath) => {
      const excerpt = excerptMap.get(markdownPath);
      const excerptHtml = excerpt
        ? buildMarkdownExcerptSection(markdownPath, excerpt)
        : `<p><code>${escapeHtml(markdownPath)}</code></p><p>${buildPathLink(markdownPath, "打开文件")}</p><p><em>暂无摘要。</em></p>`;

      return `<li>${excerptHtml}</li>`;
    })
    .join("");

  return [
    `<!-- ${NOTE_MARKER} key="${escapeHtml(noteKey)}" -->`,
    `<section class="zotero-pdf2md-result">`,
    `<h1>${escapeHtml(metadata.title)}</h1>`,
    `<p><strong>状态：</strong>${escapeHtml(metadata.statusText)}</p>`,
    `<dl>`,
    `<dt><strong>输出目录</strong></dt><dd><code>${escapeHtml(metadata.outputDir)}</code><br/>${buildPathLink(metadata.outputDir, "打开输出目录")}</dd>`,
    `<dt><strong>Markdown 文件</strong></dt><dd>${metadata.markdownPaths.length}</dd>`,
    `</dl>`,
    metadata.markdownPaths.length
      ? `<h2>生成的 Markdown</h2><ul>${markdownItems}</ul>`
      : `<p><em>未提供 Markdown 文件。</em></p>`,
    `</section>`,
  ].join("");
}

function createMarkdownRenderer() {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
  });

  md.use(texmath as any, {
    engine: katex,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: {
      throwOnError: false,
      output: "mathml",
      strict: "ignore",
    },
  });

  // Customize texmath rendering to output Markdown-style formulas
  // that Zotero 7 can recognize as math nodes or plain MD text.
  md.renderer.rules.math_inline = (tokens, idx) => {
    const content = tokens[idx].content;
    return `<span class="math-node" data-math-src="${escapeHtml(content)}" data-math-inline="true">$${escapeHtml(content)}$</span>`;
  };

  md.renderer.rules.math_block = (tokens, idx) => {
    const content = tokens[idx].content;
    return `<div class="math-node math-block" data-math-src="${escapeHtml(content)}" data-math-display="true">$$\n${escapeHtml(content)}\n$$</div>`;
  };

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
    const markdownPath =
      typeof env?.markdownPath === "string" ? env.markdownPath : "";
    const resolved = resolveMarkdownTarget(markdownPath, src);
    if (src.startsWith("data:")) {
      return defaultImageRule(tokens, idx, options, env, self);
    }
    if (isAbsoluteLink(resolved)) {
      token.attrSet("src", resolved);
      return defaultImageRule(tokens, idx, options, env, self);
    }
    if (resolved && pathExists(resolved)) {
      token.attrSet("src", toFileURI(resolved));
    }
    return defaultImageRule(tokens, idx, options, env, self);
  };

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet("href") || "";
    const markdownPath =
      typeof env?.markdownPath === "string" ? env.markdownPath : "";
    const resolved = resolveMarkdownTarget(markdownPath, href);
    if (isAbsoluteLink(resolved)) {
      token.attrSet("href", resolved);
    } else if (resolved && pathExists(resolved)) {
      token.attrSet("href", toFileURI(resolved));
    }
    return defaultLinkOpenRule(tokens, idx, options, env, self);
  };

  return md;
}

const markdownRenderer = createMarkdownRenderer();

function collapseSpacedAsciiTokens(value: string) {
  const trimmed = value.trim();
  if (!trimmed.includes(" ")) {
    return value;
  }
  if (!/^[A-Za-z0-9@._+\- ]+$/.test(trimmed)) {
    return value;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return value;
  }
  const mostlySingleChar = tokens.every((token) => token.length <= 2);
  if (!mostlySingleChar) {
    return value;
  }
  return tokens.join("");
}

function normalizeLatexExpression(input: string) {
  let normalized = input;

  normalized = normalized.replace(
    /\\(big|Big|bigg|Bigg)\s*\{\s*([()[\]{}|])\s*\}/g,
    "\\$1$2",
  );
  normalized = normalized.replace(
    /\\(left|right)\s*\{\s*([()[\]{}|])\s*\}/g,
    "\\$1$2",
  );

  normalized = normalized.replace(
    /\\(operatorname|mathrm|mathbf|mathbb|mathcal)\s*\{([^{}]+)\}/g,
    (full, command: string, content: string) => {
      const collapsed = collapseSpacedAsciiTokens(content);
      return `\\${command}{${collapsed}}`;
    },
  );

  normalized = normalized.replace(
    /\\([A-Za-z]+)\s+\{/g,
    (_full, command: string) => `\\${command}{`,
  );

  return normalized;
}

function normalizeMarkdownMath(markdown: string) {
  let normalized = markdown.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (full, expression: string) =>
      `$$\n${normalizeLatexExpression(expression.trim())}\n$$`,
  );

  normalized = normalized.replace(
    /(?<!\$)\$([^$\n]+?)\$(?!\$)/g,
    (_full, expression: string) => `$${normalizeLatexExpression(expression)}$`,
  );

  return normalized;
}

function countMatches(value: string, pattern: RegExp) {
  return (value.match(pattern) || []).length;
}

function isMarkdownStructuralLine(trimmed: string) {
  return /^(?:#{1,6}\s|>\s|[-*_]{3,}\s*$|!\[|`{3,}|~{3,}|<!--|\||\d+\.\s|[-+*]\s)/.test(
    trimmed,
  );
}

const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u3400-\u4dbf]/;

function hasCjkOutsideLatex(line: string) {
  const stripped = line.replace(/\\[a-zA-Z]+\{[^}]*\}/g, "");
  return CJK_RE.test(stripped);
}

function wrapInlineLatexSpans(line: string) {
  if (/\$/.test(line)) {
    return line;
  }
  if (!LATEX_COMMAND_RE.test(line)) {
    return line;
  }
  if (!hasCjkOutsideLatex(line)) {
    return line;
  }

  const segments = line.split(
    /([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u3400-\u4dbf\uff0c\u3001\u3002\uff1b\uff1a\uff01\uff1f\u300a\u300b\u201c\u201d]+)/,
  );
  return segments
    .map((seg) => {
      if (CJK_RE.test(seg)) {
        return seg;
      }
      const trimmed = seg.trim();
      if (!trimmed) {
        return seg;
      }
      if (!LATEX_COMMAND_RE.test(trimmed)) {
        return seg;
      }
      const lead = seg.match(/^\s*/)?.[0] || "";
      const trail = seg.match(/\s*$/)?.[0] || "";
      return `${lead}$${trimmed}$${trail}`;
    })
    .join("");
}

function isLikelyAsciiEquationLine(trimmed: string) {
  if (!/[=+\-*/^_()[\]{}]/.test(trimmed)) {
    return false;
  }
  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    return false;
  }
  if (/[.;:?!]\s*$/.test(trimmed)) {
    return false;
  }

  const operatorCount = countMatches(trimmed, /[=+\-*/^_]/g);
  const bracketCount = countMatches(trimmed, /[()[\]{}]/g);
  const commaCount = countMatches(trimmed, /[,;]/g);
  return operatorCount + bracketCount + commaCount >= 5;
}

function isLikelyStandaloneMathLine(trimmed: string) {
  if (!trimmed || isMarkdownStructuralLine(trimmed)) {
    return false;
  }
  if (trimmed.includes("$$")) {
    return false;
  }
  if (/^\$.*\$$/.test(trimmed)) {
    return false;
  }
  // Include explicit LaTeX environments so they are grouped in mathBuffer
  if (trimmed.startsWith("\\begin{") || trimmed.startsWith("\\end{")) {
    return true;
  }
  if (hasCjkOutsideLatex(trimmed)) {
    return false;
  }
  if (LATEX_COMMAND_RE.test(trimmed)) {
    return true;
  }
  return isLikelyAsciiEquationLine(trimmed);
}

function wrapStandaloneMathBlocks(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let inFence = false;
  let mathBuffer: string[] = [];

  const flushMathBuffer = () => {
    if (!mathBuffer.length) {
      return;
    }
    const firstLine = mathBuffer[0].trim();
    if (firstLine.startsWith("\\begin{")) {
      // It's already an explicit environment, no need to wrap in $$
      output.push(...mathBuffer);
    } else {
      output.push("$$", ...mathBuffer, "$$");
    }
    mathBuffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      flushMathBuffer();
      inFence = !inFence;
      output.push(line);
      continue;
    }

    if (inFence) {
      output.push(line);
      continue;
    }

    if (isLikelyStandaloneMathLine(trimmed)) {
      mathBuffer.push(trimmed);
      continue;
    }

    flushMathBuffer();
    output.push(wrapInlineLatexSpans(line));
  }

  flushMathBuffer();
  return output.join("\n");
}

async function renderMarkdownToHtml(markdownPath: string, markdown: string) {
  const preparedMarkdown = wrapStandaloneMathBlocks(
    normalizeMarkdownMath(await inlineLocalImages(markdownPath, markdown)),
  );
  return markdownRenderer.render(preparedMarkdown, { markdownPath });
}

function stripExtension(filePath: string) {
  return filePath.replace(/\.[^.]+$/, "");
}

function wrapPreviewHtmlDocument(title: string, bodyHtml: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
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
    .math-node { display: inline-block; }
    .math-block { display: block; width: 100%; text-align: center; margin: 1em 0; }
    .katex-display { overflow-x: auto; overflow-y: hidden; padding: 0.4em 0; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export async function writeMarkdownPreviewHtmlFile(
  markdownPath: string,
  title: string,
) {
  const markdown = await readTextFile(markdownPath);
  if (!markdown?.trim()) {
    return undefined;
  }
  const contentHtml = await renderMarkdownToHtml(markdownPath, markdown);
  const html = wrapPreviewHtmlDocument(title, contentHtml);
  const htmlPath = `${stripExtension(markdownPath)}.preview.html`;
  await (Zotero as any).File.putContentsAsync(htmlPath, html, "utf-8");
  return htmlPath;
}

export interface MarkdownPreviewNoteMetadata {
  title: string;
  markdownPath: string;
  noteKey?: string;
  existingNoteID?: number;
  validation?: {
    status: "pass" | "warn" | "fail";
    summary?: string;
    issues?: string[];
    reportPath?: string;
  };
}

async function loadExcerptMap(markdownPaths: string[], excerptChars: number) {
  const excerptMap = new Map<string, string>();
  for (const markdownPath of markdownPaths) {
    try {
      const excerpt = await readMarkdownExcerpt(markdownPath, excerptChars);
      if (excerpt) {
        excerptMap.set(markdownPath, excerpt);
      }
    } catch (error) {
      ztoolkit.log("result-note excerpt read failed", markdownPath, error);
    }
  }
  return excerptMap;
}

function itemLooksLikeNote(item: any) {
  return typeof item?.isNote === "function"
    ? item.isNote()
    : item?.itemType === "note";
}

function getNoteText(item: any) {
  if (typeof item?.getNote === "function") {
    return item.getNote();
  }
  return typeof item?.note === "string" ? item.note : "";
}

async function findExistingChildNote(
  parentID: number,
  noteKey: string,
  existingNoteID?: number,
  marker = NOTE_MARKER,
) {
  const itemsApi = (Zotero as any).Items;

  if (existingNoteID && typeof itemsApi?.getAsync === "function") {
    return await itemsApi.getAsync(existingNoteID);
  }
  if (existingNoteID && typeof itemsApi?.get === "function") {
    return itemsApi.get(existingNoteID);
  }

  const childRecords =
    typeof itemsApi?.getByParentID === "function"
      ? itemsApi.getByParentID(parentID)
      : [];

  const children = Array.isArray(childRecords) ? childRecords : [];
  for (const child of children) {
    const note =
      typeof child === "number"
        ? typeof itemsApi?.get === "function"
          ? itemsApi.get(child)
          : undefined
        : child;
    if (!itemLooksLikeNote(note)) {
      continue;
    }
    const text = getNoteText(note);
    if (
      text.includes(marker) &&
      text.includes(`key="${escapeHtml(noteKey)}"`)
    ) {
      return note;
    }
  }

  return undefined;
}

export async function upsertMarkdownPreviewNote(
  sourceItem: ResultNoteSourceItem,
  metadata: MarkdownPreviewNoteMetadata,
) {
  const parentID = resolveParentID(sourceItem);
  if (!parentID) {
    return undefined;
  }

  const markdown = await readTextFile(metadata.markdownPath);
  if (!markdown?.trim()) {
    return undefined;
  }

  const noteKey =
    metadata.noteKey ||
    [
      parentID,
      PREVIEW_RENDERER_VERSION,
      slugifyKey(metadata.title),
      slugifyKey(metadata.markdownPath),
    ].join(":");
  const contentHtml = await renderMarkdownToHtml(
    metadata.markdownPath,
    markdown,
  );
  const validationHtml =
    metadata.validation && metadata.validation.status !== "pass"
      ? [
          `<aside class="zotero-pdf2md-validation zotero-pdf2md-validation-${escapeHtml(metadata.validation.status)}">`,
          `<strong>结构校验提示：</strong>${escapeHtml(metadata.validation.summary || "检测到可能影响 Zotero Note 公式显示的问题。")}`,
          ...(metadata.validation.issues?.length
            ? [
                `<ul>${metadata.validation.issues
                  .slice(0, 6)
                  .map((issue) => `<li>${escapeHtml(issue)}</li>`)
                  .join("")}</ul>`,
              ]
            : []),
          metadata.validation.reportPath
            ? `<p>${buildPathLink(metadata.validation.reportPath, "打开校验报告")}</p>`
            : "",
          `</aside>`,
        ].join("")
      : "";
  const html = [
    `<!-- ${PREVIEW_NOTE_MARKER} key="${escapeHtml(noteKey)}" -->`,
    `<section class="zotero-pdf2md-preview-note">`,
    `<style>
      .zotero-pdf2md-preview-note img { max-width: 100%; height: auto; display: block; margin: 0.75em 0; }
      .zotero-pdf2md-preview-note table { border-collapse: collapse; width: 100%; margin: 0.75em 0; }
      .zotero-pdf2md-preview-note th, .zotero-pdf2md-preview-note td { border: 1px solid #999; padding: 0.35em 0.5em; vertical-align: top; }
      .zotero-pdf2md-preview-note pre { white-space: pre-wrap; overflow-wrap: anywhere; }
      .zotero-pdf2md-preview-note .katex-display { overflow-x: auto; overflow-y: hidden; padding: 0.25em 0; }
      .zotero-pdf2md-preview-note .zotero-pdf2md-validation { border: 1px solid #d0a000; background: #fff7d6; color: #333; padding: 0.75em 0.9em; margin: 1em 0; border-radius: 6px; }
      .zotero-pdf2md-preview-note .zotero-pdf2md-validation-fail { border-color: #c44; background: #ffe3e3; }
      .zotero-pdf2md-preview-note .zotero-pdf2md-validation ul { margin: 0.6em 0 0 1.2em; }
    </style>`,
    `<h1>${escapeHtml(metadata.title)}</h1>`,
    `<p><em>渲染器版本：${PREVIEW_RENDERER_VERSION}</em></p>`,
    `<p>${buildPathLink(metadata.markdownPath, "打开对应 Markdown 文件")}</p>`,
    validationHtml,
    contentHtml || "<p><em>内容为空。</em></p>",
    `</section>`,
  ].join("");

  let note = (await findExistingChildNote(
    parentID,
    noteKey,
    metadata.existingNoteID,
    PREVIEW_NOTE_MARKER,
  )) as ResultNoteSourceItem | undefined;

  if (!note) {
    note = new Zotero.Item("note") as ResultNoteSourceItem;
    note.parentID = parentID;
  }

  note.setNote?.(html);
  await note.saveTx?.();
  return note;
}

export async function upsertResultNote(
  sourceItem: ResultNoteSourceItem,
  metadata: ResultNoteMetadata,
) {
  const parentID = resolveParentID(sourceItem);
  if (!parentID) {
    return undefined;
  }

  const noteKey = buildNoteKey(parentID, metadata);
  const excerptChars = metadata.excerptChars ?? 1200;
  const excerptMap = await loadExcerptMap(metadata.markdownPaths, excerptChars);
  const html = buildResultNoteHtml(metadata, noteKey, excerptMap);

  let note = (await findExistingChildNote(
    parentID,
    noteKey,
    metadata.existingNoteID,
  )) as ResultNoteSourceItem | undefined;

  if (!note) {
    note = new Zotero.Item("note") as ResultNoteSourceItem;
    note.parentID = parentID;
  }

  note.setNote?.(html);
  await note.saveTx?.();
  return note;
}
