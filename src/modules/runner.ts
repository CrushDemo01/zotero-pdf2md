import { getPref } from "../utils/prefs";

const BUNDLED_SCRIPT_FILES = [
  "build_translation_draft.py",
  "extract_pdf_assets.py",
  "mistral_ocr_to_markdown.py",
  "prepare_translation_inputs.py",
  "review_markdown_html.py",
  "translate_markdown_chunks.py",
  "workflow_common.py",
  "write_md_chunk.py",
];

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getStringPref(name: string) {
  const value = (getPref as any)(name);
  return typeof value === "string" ? value : undefined;
}

function getBooleanPref(name: string, fallback = false) {
  const value = (getPref as any)(name);
  return typeof value === "boolean" ? value : fallback;
}

function ensureParentDir(dirPath: string) {
  const dir = (Components.classes as any)[
    "@mozilla.org/file/local;1"
  ].createInstance(
    (Components.interfaces as any).nsIFile,
  );
  dir.initWithPath(dirPath);
  if (!dir.exists()) {
    dir.create((Components.interfaces as any).nsIFile.DIRECTORY_TYPE, 0o755);
  }
}

function slugify(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w\u4e00-\u9fff.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parentDir(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : normalized;
}

function stripExtension(filePath: string) {
  return filePath.replace(/\.[^.]+$/, "");
}

export function getOutputDirForPdf(pdfPath: string) {
  const pdfFile = PathUtils.filename(pdfPath);
  const stem = slugify(pdfFile || "paper");
  const parent = PathUtils.parent(pdfPath) || parentDir(pdfPath);
  return PathUtils.join(parent, `${stem}_pdf2md`);
}

async function readTextFile(filePath: string) {
  try {
    const text = await (Zotero as any).File.getContentsAsync(filePath, "utf-8");
    return typeof text === "string" ? text : "";
  } catch (_error) {
    return "";
  }
}

async function readLogTail(filePath: string, maxChars = 1200) {
  const text = await readTextFile(filePath);
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(-maxChars).trim();
}

function getProfileDir() {
  const profileDir = (Services as any).dirsvc.get(
    "ProfD",
    (Components.interfaces as any).nsIFile,
  );
  return profileDir.path as string;
}

async function ensureBundledScriptsDir() {
  const scriptsDir = PathUtils.join(
    getProfileDir(),
    "zotero-pdf2md-python",
  );
  await (Zotero as any).File.createDirectoryIfMissingAsync(scriptsDir);

  for (const fileName of BUNDLED_SCRIPT_FILES) {
    const sourceURL = `${rootURI}content/python/${fileName}`;
    const targetPath = PathUtils.join(scriptsDir, fileName);
    const content = await (Zotero as any).File.getContentsFromURLAsync(sourceURL);
    await (Zotero as any).File.putContentsAsync(targetPath, content, "utf-8");
  }

  return scriptsDir;
}

async function ensureOutputDir(outDir: string) {
  await (Zotero as any).File.createDirectoryIfMissingAsync(outDir);
}

function pathExists(filePath: string) {
  try {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance(
      (Components.interfaces as any).nsIFile,
    );
    file.initWithPath(filePath);
    return file.exists();
  } catch (_error) {
    return false;
  }
}

function hasPreparedArtifacts(outDir: string) {
  return (
    pathExists(PathUtils.join(outDir, "mistral.md")) &&
    pathExists(PathUtils.join(outDir, "ocr.json")) &&
    pathExists(PathUtils.join(outDir, "pages")) &&
    pathExists(PathUtils.join(outDir, "asset_index.md"))
  );
}

function buildPrepareCommand(
  pdfPath: string,
  outDir: string,
  scriptsDir: string,
) {
  const shellPath = getPref("shellPath") || "/bin/zsh";
  const pythonPath = getPref("pythonPath") || "python3";
  const mistralApiKey = getPref("mistralApiKey");
  const inlineImages = getPref("inlineImages");

  if (!mistralApiKey) {
    throw new Error("MISTRAL_API_KEY is not configured in plugin preferences.");
  }

  const scriptPath = PathUtils.join(scriptsDir, "prepare_translation_inputs.py");
  const logPath = PathUtils.join(outDir, "prepare.log");
  const parts = [
    `export MISTRAL_API_KEY=${shellQuote(mistralApiKey)}`,
    `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --pdf ${shellQuote(pdfPath)} --outdir ${shellQuote(outDir)} --table-format markdown`,
  ];
  if (inlineImages) {
    parts[1] += " --inline-images";
  }

  return {
    executable: shellPath,
    args: ["-lc", `${parts.join("; ")} > ${shellQuote(logPath)} 2>&1`],
    logPath,
  };
}

function buildFinalTranslationCommand(
  pdfPath: string,
  outDir: string,
  scriptsDir: string,
  sourceLanguage: string,
  targetLanguage: string,
  skipPrepare: boolean,
) {
  const shellPath = getPref("shellPath") || "/bin/zsh";
  const pythonPath = getPref("pythonPath") || "python3";
  const mistralApiKey = getPref("mistralApiKey");
  const llmApiKey = getStringPref("llmApiKey") || getStringPref("OPENAI_API_KEY");
  const llmApiUrl = getStringPref("llmApiUrl") || "https://api.openai.com/v1";
  const llmModel = getStringPref("llmModel") || "gpt-5-mini";
  const inlineImages = getPref("inlineImages");
  const pdfFile = PathUtils.filename(pdfPath) || "paper.pdf";
  const stem = slugify(pdfFile);

  if (!mistralApiKey) {
    throw new Error("MISTRAL_API_KEY is not configured in plugin preferences.");
  }
  if (!llmApiKey) {
    throw new Error("LLM API key is not configured in plugin preferences.");
  }

  const scriptPath = PathUtils.join(scriptsDir, "translate_markdown_chunks.py");
  const outMd = PathUtils.join(outDir, "target.md");
  const logPath = PathUtils.join(outDir, "final_translation.log");
  const parts = [
    `export MISTRAL_API_KEY=${shellQuote(mistralApiKey)}`,
    `export OPENAI_API_KEY=${shellQuote(llmApiKey)}`,
    `export SOURCE_LANGUAGE=${shellQuote(sourceLanguage)}`,
    `export TARGET_LANGUAGE=${shellQuote(targetLanguage)}`,
    `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --pdf ${shellQuote(pdfPath)} --outdir ${shellQuote(outDir)} --out-md ${shellQuote(outMd)} --title ${shellQuote(stem)} --api-base ${shellQuote(llmApiUrl)} --model ${shellQuote(llmModel)} --table-format markdown`,
  ];
  if (inlineImages) {
    parts[4] += " --inline-images";
  }
  if (skipPrepare) {
    parts[4] += " --skip-prepare";
  }
  return {
    executable: shellPath,
    args: ["-lc", `${parts.join("; ")} > ${shellQuote(logPath)} 2>&1`],
    outMd,
    logPath,
  };
}

function buildHtmlReviewCommand(
  markdownPath: string,
  htmlPath: string,
  scriptsDir: string,
  title: string,
) {
  const shellPath = getPref("shellPath") || "/bin/zsh";
  const pythonPath = getPref("pythonPath") || "python3";
  const llmApiKey = getStringPref("llmApiKey") || getStringPref("OPENAI_API_KEY");
  const llmApiUrl = getStringPref("llmApiUrl") || "https://api.openai.com/v1";
  const llmModel = getStringPref("llmModel") || "gpt-5-mini";
  const scriptPath = PathUtils.join(scriptsDir, "review_markdown_html.py");
  const logPath = `${stripExtension(htmlPath)}.review.log`;

  if (!llmApiKey) {
    throw new Error("LLM API key is not configured in plugin preferences.");
  }

  const parts = [
    `export OPENAI_API_KEY=${shellQuote(llmApiKey)}`,
    `${shellQuote(pythonPath)} ${shellQuote(scriptPath)} --markdown ${shellQuote(markdownPath)} --html ${shellQuote(htmlPath)} --out-md ${shellQuote(markdownPath)} --title ${shellQuote(title)} --api-base ${shellQuote(llmApiUrl)} --model ${shellQuote(llmModel)}`,
  ];

  return {
    executable: shellPath,
    args: ["-lc", `${parts.join("; ")} > ${shellQuote(logPath)} 2>&1`],
    logPath,
  };
}

function runProcess(executable: string, args: string[], logPath?: string) {
  const withLogPath = (message: string) => {
    if (!logPath) {
      return message;
    }
    return `${message}\n\n日志文件：${logPath}`;
  };

  return new Promise<void>((resolve, reject) => {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance(
      (Components.interfaces as any).nsIFile,
    );
    file.initWithPath(executable);

    const process = (Components.classes as any)[
      "@mozilla.org/process/util;1"
    ].createInstance(
      (Components.interfaces as any).nsIProcess,
    );
    process.init(file);
    process.runwAsync(args, args.length, {
      observe: async (_subject: unknown, topic: string) => {
        if (topic === "process-finished") {
          const exitValue = typeof process.exitValue === "number" ? process.exitValue : 0;
          if (exitValue === 0) {
            resolve();
            return;
          }
          const logTail = logPath ? await readLogTail(logPath) : "";
          const fallback = `命令执行失败，退出码 ${exitValue}`;
          reject(
            new Error(
              withLogPath(logTail || fallback),
            ),
          );
        } else {
          const logTail = logPath ? await readLogTail(logPath) : "";
          const fallback = `Process ended with topic: ${topic}`;
          reject(
            new Error(
              withLogPath(logTail || fallback),
            ),
          );
        }
      },
    });
  });
}

export async function preparePdfToMarkdown(pdfPath: string) {
  const outDir = getOutputDirForPdf(pdfPath);
  await ensureOutputDir(outDir);
  const skipPrepare = hasPreparedArtifacts(outDir);
  if (skipPrepare) {
    return {
      outDir,
      skippedPrepare: true,
      markdownPath: PathUtils.join(outDir, "mistral.md"),
      assetIndexPath: PathUtils.join(outDir, "asset_index.md"),
    };
  }
  const scriptsDir = await ensureBundledScriptsDir();
  const command = buildPrepareCommand(pdfPath, outDir, scriptsDir);
  await runProcess(command.executable, command.args, command.logPath);
  return {
    outDir,
    skippedPrepare: false,
    markdownPath: PathUtils.join(outDir, "mistral.md"),
    assetIndexPath: PathUtils.join(outDir, "asset_index.md"),
  };
}

export async function buildFinalTranslatedMarkdown(
  pdfPath: string,
  sourceLanguage: string,
  targetLanguage: string,
) {
  const outDir = getOutputDirForPdf(pdfPath);
  await ensureOutputDir(outDir);
  const scriptsDir = await ensureBundledScriptsDir();
  const skipPrepare = hasPreparedArtifacts(outDir);
  const command = buildFinalTranslationCommand(
    pdfPath,
    outDir,
    scriptsDir,
    sourceLanguage,
    targetLanguage,
    skipPrepare,
  );
  await runProcess(command.executable, command.args, command.logPath);
  return {
    outDir,
    finalMarkdownPath: command.outMd,
    sourceLanguage,
    targetLanguage,
    skippedPrepare: skipPrepare,
    sourceMarkdownPath: PathUtils.join(outDir, "mistral.md"),
    assetIndexPath: PathUtils.join(outDir, "asset_index.md"),
  };
}

export async function reviewMarkdownWithHtml(
  markdownPath: string,
  htmlPath: string,
  title: string,
) {
  const reviewEnabled = getBooleanPref("reviewGeneratedHtml", true);
  const llmApiKey = getStringPref("llmApiKey") || getStringPref("OPENAI_API_KEY");
  if (!reviewEnabled || !llmApiKey) {
    return {
      skipped: true,
      reason: !reviewEnabled ? "disabled" : "missing-llm-api-key",
    };
  }

  const scriptsDir = await ensureBundledScriptsDir();
  const command = buildHtmlReviewCommand(markdownPath, htmlPath, scriptsDir, title);
  await runProcess(command.executable, command.args, command.logPath);
  return {
    skipped: false,
    logPath: command.logPath,
    markdownPath,
    htmlPath,
  };
}
