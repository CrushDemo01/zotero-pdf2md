import {
  buildFinalTranslatedMarkdown,
  getOutputDirForPdf,
  preparePdfToMarkdown,
  reviewMarkdownWithHtml,
} from "./runner";
import { getPref } from "../utils/prefs";
import {
  upsertMarkdownPreviewNote,
  upsertResultNote,
  writeMarkdownPreviewHtmlFile,
} from "./resultNote";
import { linkOutputFilesAsAttachments } from "./outputAttachments";

function getSelectedItems(): Zotero.Item[] {
  const pane =
    Zotero.getActiveZoteroPane?.() || ztoolkit.getGlobal("ZoteroPane");
  return pane?.getSelectedItems?.() || [];
}

function getItemTitle(item: Zotero.Item) {
  return item.getDisplayTitle?.() || item.getField?.("title") || "所选 PDF";
}

function isPdfAttachment(item: Zotero.Item): boolean {
  if (typeof (item as any).isPDFAttachment === "function") {
    return (item as any).isPDFAttachment();
  }
  return (
    item.isAttachment() &&
    ((item.attachmentContentType as string | undefined) === "application/pdf" ||
      (item.attachmentReaderType as string | undefined) === "pdf")
  );
}

function isMarkdownAttachment(item: Zotero.Item): boolean {
  const contentType = (item.attachmentContentType as string | undefined) || "";
  const readerType = (item.attachmentReaderType as string | undefined) || "";
  const path = typeof (item as any).getFilePath === "function"
    ? ((item as any).getFilePath() as string | undefined)
    : undefined;
  return (
    item.isAttachment() &&
    (contentType === "text/markdown" ||
      readerType === "markdown" ||
      !!path?.toLowerCase?.().endsWith(".md"))
  );
}

async function getAttachmentFilePath(item: Zotero.Item): Promise<string | undefined> {
  if (typeof (item as any).getFilePathAsync === "function") {
    return await (item as any).getFilePathAsync();
  }
  if (typeof (item as any).getFilePath === "function") {
    return (item as any).getFilePath();
  }
  return undefined;
}

function getChildAttachmentIDs(item: Zotero.Item): Array<number | string> {
  if (typeof (item as any).getAttachments === "function") {
    return (item as any).getAttachments() || [];
  }
  return [];
}

function getItemByID(id: number | string): Zotero.Item | undefined {
  const itemsApi = (Zotero as any).Items;
  if (typeof itemsApi?.get === "function") {
    return itemsApi.get(id);
  }
  return undefined;
}

function findPdfAttachmentForItem(item: Zotero.Item): Zotero.Item | undefined {
  if (isPdfAttachment(item)) {
    return item;
  }
  for (const childID of getChildAttachmentIDs(item)) {
    const childItem = getItemByID(childID);
    if (childItem && isPdfAttachment(childItem)) {
      return childItem;
    }
  }
  return undefined;
}

function findMarkdownAttachmentForItem(item: Zotero.Item): Zotero.Item | undefined {
  if (isMarkdownAttachment(item)) {
    return item;
  }
  for (const childID of getChildAttachmentIDs(item)) {
    const childItem = getItemByID(childID);
    if (childItem && isMarkdownAttachment(childItem)) {
      return childItem;
    }
  }
  return undefined;
}

function getSelectedPdfTargets() {
  return getSelectedItems()
    .map((item) => {
      const pdfItem = findPdfAttachmentForItem(item);
      if (!pdfItem) {
        return undefined;
      }
      return {
        sourceItem: item,
        pdfItem,
      };
    })
    .filter(Boolean) as Array<{ sourceItem: Zotero.Item; pdfItem: Zotero.Item }>;
}

function getSelectedMarkdownTargets() {
  return getSelectedItems()
    .map((item) => {
      const markdownItem = findMarkdownAttachmentForItem(item);
      if (!markdownItem) {
        return undefined;
      }
      return {
        sourceItem: item,
        markdownItem,
      };
    })
    .filter(Boolean) as Array<{ sourceItem: Zotero.Item; markdownItem: Zotero.Item }>;
}

function getLanguagePrefs() {
  return {
    sourceLanguage: getPref("sourceLanguage") || "auto",
    targetLanguage: getPref("targetLanguage") || "zh-CN",
  };
}

function getLlmApiKey() {
  const value = getPref("llmApiKey");
  return typeof value === "string" ? value.trim() : "";
}

function getLanguageDisplayName(tag: string) {
  const map: Record<string, string> = {
    auto: "自动检测",
    "zh-CN": "简体中文",
    en: "英语",
    ja: "日语",
    ko: "韩语",
    fr: "法语",
    de: "德语",
    es: "西班牙语",
    ru: "俄语",
    "pt-BR": "葡萄牙语（巴西）",
  };
  return map[tag] || tag;
}

function showMessage(text: string, type: "default" | "success" = "default") {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text,
      type,
      progress: 100,
    })
    .show();
}

function formatErrorForProgress(error: unknown) {
  const raw = String(error || "未知错误");
  const match = raw.match(/日志文件：([^\n]+)/);
  const logPath = match?.[1]?.trim();
  const firstLine = raw
    .replace(/^Error:\s*/i, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0) || "未知错误";

  if (!logPath) {
    return `处理失败：${firstLine}`;
  }
  return `处理失败：${firstLine}\n日志：${logPath}`;
}

function fileExists(filePath: string) {
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

function pickFirstExistingPath(candidates: string[]) {
  for (const path of candidates) {
    if (path && fileExists(path)) {
      return path;
    }
  }
  return undefined;
}

async function buildAttachAndReviewHtmlPreview(
  sourceItem: Zotero.Item,
  markdownPath: string,
  title: string,
  attachmentTitle: string,
  reviewMode: "never" | "auto" | "always" = "auto",
) {
  let htmlPath = await writeMarkdownPreviewHtmlFile(markdownPath, title);
  if (!htmlPath) {
    return undefined;
  }

  const shouldTryReview = reviewMode !== "never";
  if (shouldTryReview) {
    try {
      const reviewResult = await reviewMarkdownWithHtml(
        markdownPath,
        htmlPath,
        title,
      );
      const reviewed =
        reviewMode === "always"
          ? !reviewResult.skipped
          : !reviewResult.skipped;
      if (reviewMode === "always" && reviewResult.skipped) {
        throw new Error("未配置 LLM 接口，无法执行复核增强模式。");
      }
      if (reviewed) {
        htmlPath = await writeMarkdownPreviewHtmlFile(markdownPath, title);
      }
    } catch (reviewError) {
      ztoolkit.log("markdown html review failed", reviewError);
      if (reviewMode === "always") {
        throw reviewError;
      }
    }
  }

  if (!htmlPath) {
    return undefined;
  }

  try {
    await linkOutputFilesAsAttachments(sourceItem as any, [
      { path: htmlPath, title: attachmentTitle },
    ]);
  } catch (attachError) {
    ztoolkit.log("attach html preview failed", attachError);
  }

  return htmlPath;
}

async function findLegacyMarkdownPath(
  outDir: string,
  kind: "source" | "target",
): Promise<string | undefined> {
  try {
    const entries = await IOUtils.getChildren(outDir);
    const files = entries
      .filter((entry) => entry.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
    if (kind === "source") {
      return files.find((p) => p.endsWith(".mistral.md"));
    }
    return (
      files.find((p) => p.endsWith("_target.md")) ||
      files.find((p) => p.includes("_auto_to_")) ||
      files.find((p) => !p.endsWith(".mistral.md") && !p.endsWith("asset_index.md"))
    );
  } catch (_error) {
    return undefined;
  }
}

async function attachFailureLogs(sourceItem: Zotero.Item, pdfPath: string) {
  const outDir = getOutputDirForPdf(pdfPath);
  const prepareLog = PathUtils.join(outDir, "prepare.log");
  const finalLog = PathUtils.join(outDir, "final_translation.log");
  const files: Array<{ path: string; title?: string }> = [];
  if (fileExists(prepareLog)) {
    files.push({ path: prepareLog, title: "pdf2md-准备日志" });
  }
  if (fileExists(finalLog)) {
    files.push({ path: finalLog, title: "pdf2md-翻译日志" });
  }
  if (!files.length) {
    return 0;
  }
  const created = await linkOutputFilesAsAttachments(sourceItem as any, files);
  return created.length;
}

export class PdfActionFactory {
  static registerMenuItems() {
    const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
    ztoolkit.Menu.register("item", {
      tag: "menu",
      id: "zotero-itemmenu-zoteropdf2md",
      label: "PDF 转 Markdown",
      icon: menuIcon,
      children: [
        {
          tag: "menuitem",
          id: "zotero-itemmenu-zoteropdf2md-convert",
          label: "PDF 转 Markdown",
          commandListener: async () => {
            await this.runSelectedPdfToMarkdown();
          },
          icon: menuIcon,
        },
        {
          tag: "menuitem",
          id: "zotero-itemmenu-zoteropdf2md-convert-final",
          label: "PDF 转 Markdown 并翻译",
          commandListener: async () => {
            await this.runSelectedPdfToFinalTranslatedMarkdown();
          },
          icon: menuIcon,
        },
        {
          tag: "menuitem",
          id: "zotero-itemmenu-zoteropdf2md-markdown-html",
          label: "Markdown→HTML（快速）",
          commandListener: async () => {
            await this.runSelectedMarkdownToHtml("never");
          },
          icon: menuIcon,
        },
        {
          tag: "menuitem",
          id: "zotero-itemmenu-zoteropdf2md-markdown-html-review",
          label: "Markdown→HTML（复核增强）",
          commandListener: async () => {
            await this.runSelectedMarkdownToHtml("always");
          },
          icon: menuIcon,
        },
      ],
    });
  }

  static onMainWindowLoad(_win: _ZoteroTypes.MainWindow) {}

  static onMainWindowUnload(_win: Window) {}

  private static async getRunnableTargets() {
    const targets = getSelectedPdfTargets();
    const resolved: Array<{
      sourceItem: Zotero.Item;
      pdfItem: Zotero.Item;
      pdfPath: string;
      title: string;
    }> = [];
    for (const target of targets) {
      const pdfPath = await getAttachmentFilePath(target.pdfItem);
      if (!pdfPath) {
        continue;
      }
      resolved.push({
        sourceItem: target.sourceItem,
        pdfItem: target.pdfItem,
        pdfPath,
        title: getItemTitle(target.pdfItem),
      });
    }
    return resolved;
  }

  private static async getRunnableMarkdownTargets() {
    const targets = getSelectedMarkdownTargets();
    const resolved: Array<{
      sourceItem: Zotero.Item;
      markdownItem: Zotero.Item;
      markdownPath: string;
      title: string;
    }> = [];
    for (const target of targets) {
      const markdownPath = await getAttachmentFilePath(target.markdownItem);
      if (!markdownPath) {
        continue;
      }
      resolved.push({
        sourceItem: target.sourceItem,
        markdownItem: target.markdownItem,
        markdownPath,
        title: getItemTitle(target.markdownItem),
      });
    }
    return resolved;
  }

  static async runSelectedPdfToMarkdown() {
    const targets = await this.getRunnableTargets();
    if (!targets.length) {
      showMessage("未找到可处理的 PDF 附件。请先选择 PDF 附件或包含 PDF 的条目。");
      return;
    }

    for (const target of targets) {
      const progressWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: -1,
      })
        .createLine({
          text: `正在准备 PDF 转 Markdown 任务：${target.title}`,
          type: "default",
          progress: 30,
        })
        .show();

      try {
        const result = await preparePdfToMarkdown(target.pdfPath);
        await this.createResultNote(target.sourceItem, {
          title: target.title,
          statusText: `PDF 转 Markdown 预处理已完成。${
            result.skippedPrepare ? " 已复用现有 OCR 源包。" : ""
          }`,
          outDir: result.outDir,
          markdownPath: result.markdownPath,
          assetIndexPath: result.assetIndexPath,
        });
        progressWin.changeLine({
          progress: 100,
          text: `已完成 ${target.title}\n${result.markdownPath}`,
        });
        progressWin.startCloseTimer(5000);
        ztoolkit.log("pdf-to-md action finished", {
          itemID: target.pdfItem.id,
          title: target.title,
          pdfPath: target.pdfPath,
          outDir: result.outDir,
          skippedPrepare: result.skippedPrepare,
        });
      } catch (error) {
        ztoolkit.log("pdf-to-md action failed", error);
        let logAttachNote = "";
        try {
          const attachedCount = await attachFailureLogs(target.sourceItem, target.pdfPath);
          if (attachedCount > 0) {
            logAttachNote = "\n已自动挂载日志附件到论文条目。";
          }
        } catch (attachError) {
          ztoolkit.log("attach prepare logs failed", attachError);
        }
        progressWin.changeLine({
          progress: 100,
          text: `${formatErrorForProgress(error)}${logAttachNote}`,
        });
        progressWin.startCloseTimer(8000);
      }
    }
  }

  static async runSelectedPdfToFinalTranslatedMarkdown() {
    const targets = await this.getRunnableTargets();
    if (!targets.length) {
      showMessage("未找到可处理的 PDF 附件。请先选择 PDF 附件或包含 PDF 的条目。");
      return;
    }

    const llmApiKey = getLlmApiKey();
    if (!llmApiKey) {
      showMessage("未配置 LLM 接口。请先在插件偏好设置中填写 LLM API 密钥、Base URL 和模型名称。");
      return;
    }

    const { sourceLanguage, targetLanguage } = getLanguagePrefs();
    const sourceLabel = getLanguageDisplayName(sourceLanguage);
    const targetLabel = getLanguageDisplayName(targetLanguage);

    for (const target of targets) {
      const progressWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: -1,
      })
        .createLine({
          text: `正在生成 ${sourceLabel} → ${targetLabel} 最终 Markdown：${target.title}`,
          type: "default",
          progress: 20,
        })
        .show();

      try {
        const result = await buildFinalTranslatedMarkdown(
          target.pdfPath,
          sourceLanguage,
          targetLanguage,
        );
        await this.createResultNote(target.sourceItem, {
          title: target.title,
          statusText: `${sourceLabel} → ${targetLabel} 最终 Markdown 已完成。${
            result.skippedPrepare ? " 已复用现有 OCR 源包。" : ""
          }`,
          outDir: result.outDir,
          markdownPath: result.sourceMarkdownPath,
          draftPath: result.finalMarkdownPath,
          assetIndexPath: result.assetIndexPath,
        });
        progressWin.changeLine({
          progress: 100,
          text: `已完成 ${target.title}\n${result.finalMarkdownPath}`,
        });
        progressWin.startCloseTimer(5000);
        ztoolkit.log("pdf-to-final-markdown action finished", {
          itemID: target.pdfItem.id,
          title: target.title,
          pdfPath: target.pdfPath,
          outDir: result.outDir,
          finalMarkdownPath: result.finalMarkdownPath,
          skippedPrepare: result.skippedPrepare,
          sourceLanguage,
          targetLanguage,
        });
      } catch (error) {
        ztoolkit.log("pdf-to-final-markdown action failed", error);
        let logAttachNote = "";
        try {
          const attachedCount = await attachFailureLogs(target.sourceItem, target.pdfPath);
          if (attachedCount > 0) {
            logAttachNote = "\n已自动挂载日志附件到论文条目。";
          }
        } catch (attachError) {
          ztoolkit.log("attach final logs failed", attachError);
        }
        progressWin.changeLine({
          progress: 100,
          text: `${formatErrorForProgress(error)}${logAttachNote}`,
        });
        progressWin.startCloseTimer(8000);
      }
    }
  }

  static async runSelectedMarkdownToHtml(
    reviewMode: "never" | "always" = "never",
  ) {
    const targets = await this.getRunnableMarkdownTargets();
    if (!targets.length) {
      showMessage("未找到可处理的 Markdown 附件。请先选择 .md 附件或包含 .md 附件的条目。");
      return;
    }

    if (reviewMode === "always" && !getLlmApiKey()) {
      showMessage("未配置 LLM 接口。请先在插件偏好设置中填写 LLM API 密钥、Base URL 和模型名称。");
      return;
    }

    for (const target of targets) {
      const actionLabel =
        reviewMode === "always" ? "Markdown HTML 复核增强预览" : "Markdown HTML 快速预览";
      const progressWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: -1,
      })
        .createLine({
          text: `正在生成${actionLabel}：${target.title}`,
          type: "default",
          progress: 40,
        })
        .show();

      try {
        const htmlPath = await buildAttachAndReviewHtmlPreview(
          target.sourceItem,
          target.markdownPath,
          reviewMode === "always"
            ? `${target.title}（HTML 复核增强预览）`
            : `${target.title}（HTML 快速预览）`,
          reviewMode === "always"
            ? "pdf2md-HTML复核增强预览"
            : "pdf2md-HTML快速预览",
          reviewMode,
        );
        await upsertMarkdownPreviewNote(target.markdownItem as any, {
          title:
            reviewMode === "always"
              ? `${target.title}（HTML 复核增强预览 v4）`
              : `${target.title}（HTML 快速预览 v4）`,
          markdownPath: target.markdownPath,
        });
        progressWin.changeLine({
          progress: 100,
          text: `已完成${actionLabel}：${target.title}\n${htmlPath || target.markdownPath}`,
        });
        progressWin.startCloseTimer(5000);
      } catch (error) {
        ztoolkit.log("markdown-to-html action failed", error);
        progressWin.changeLine({
          progress: 100,
          text: formatErrorForProgress(error),
        });
        progressWin.startCloseTimer(8000);
      }
    }
  }

  private static async createResultNote(
    pdfItem: Zotero.Item,
    result: {
      title: string;
      statusText: string;
      outDir: string;
      markdownPath: string;
      draftPath?: string;
      assetIndexPath?: string;
    },
  ) {
    let attachmentStatus = "";
    const sourceMdPath = pickFirstExistingPath([result.markdownPath]) || (
      await findLegacyMarkdownPath(result.outDir, "source")
    );
    const targetMdPath = pickFirstExistingPath([result.draftPath || ""]) || (
      await findLegacyMarkdownPath(result.outDir, "target")
    );
    const assetIndexPath = pickFirstExistingPath([result.assetIndexPath || ""]);

    // Also attach generated files under the parent item, so users can open them directly
    // from the attachments list (instead of only via a result note).
    const files: Array<{ path: string; title?: string }> = [];
    if (sourceMdPath) {
      files.push({ path: sourceMdPath, title: "pdf2md-原文 Markdown" });
    }
    if (targetMdPath) {
      files.push({ path: targetMdPath, title: "pdf2md-翻译 Markdown" });
    }
    if (assetIndexPath) {
      files.push({ path: assetIndexPath, title: "pdf2md-资源索引" });
    }
    try {
      const created = await linkOutputFilesAsAttachments(pdfItem as any, files);
      attachmentStatus =
        created.length > 0
          ? ` 已附加 ${created.length} 个输出文件。`
          : " 输出文件附件已存在或未新增。";
    } catch (error) {
      ztoolkit.log("attach output files failed", error);
      attachmentStatus = ` 输出文件附件创建失败：${String(error)}`;
    }

    await upsertResultNote(pdfItem as any, {
      title: result.title,
      statusText: `${result.statusText}${attachmentStatus}`,
      outputDir: result.outDir,
      markdownPaths: [
        sourceMdPath,
        targetMdPath,
        assetIndexPath,
      ].filter(Boolean) as string[],
    });

    if (targetMdPath) {
      try {
        await buildAttachAndReviewHtmlPreview(
          pdfItem,
          targetMdPath,
          `${result.title}（译文预览）`,
          "pdf2md-译文 HTML 预览",
        );
      } catch (htmlError) {
        ztoolkit.log("write preview html failed", htmlError);
      }
      await upsertMarkdownPreviewNote(pdfItem as any, {
        title: `${result.title}（译文预览 v4）`,
        markdownPath: targetMdPath,
      });
    } else if (sourceMdPath) {
      try {
        await buildAttachAndReviewHtmlPreview(
          pdfItem,
          sourceMdPath,
          `${result.title}（原文预览）`,
          "pdf2md-原文 HTML 预览",
        );
      } catch (htmlError) {
        ztoolkit.log("write source preview html failed", htmlError);
      }
    }
  }
}
