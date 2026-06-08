import {
  buildFinalTranslatedMarkdown,
  getOutputDirForPdf,
  preparePdfToMarkdown,
  readTranslationProgress,
  reviewMarkdownWithHtml,
  validateMarkdownNoteStructure,
} from "./runner";
import { getPref } from "../utils/prefs";
import { getLocaleID } from "../utils/locale";
import {
  upsertMarkdownPreviewNote,
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
  const path =
    typeof (item as any).getFilePath === "function"
      ? ((item as any).getFilePath() as string | undefined)
      : undefined;
  return (
    item.isAttachment() &&
    (contentType === "text/markdown" ||
      readerType === "markdown" ||
      !!path?.toLowerCase?.().endsWith(".md"))
  );
}

async function getAttachmentFilePath(
  item: Zotero.Item,
): Promise<string | undefined> {
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

function findMarkdownAttachmentForItem(
  item: Zotero.Item,
): Zotero.Item | undefined {
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
    .filter(Boolean) as Array<{
    sourceItem: Zotero.Item;
    pdfItem: Zotero.Item;
  }>;
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
    .filter(Boolean) as Array<{
    sourceItem: Zotero.Item;
    markdownItem: Zotero.Item;
  }>;
}

function hasSelectedPdfTarget(): boolean {
  return isPluginEnabled() && getSelectedPdfTargets().length > 0;
}

function hasSelectedMarkdownTarget(): boolean {
  return isPluginEnabled() && getSelectedMarkdownTargets().length > 0;
}

function isPluginEnabled(): boolean {
  return getPref("enable") !== false;
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

  const lines = raw
    .replace(/^Error:\s*/i, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes("日志文件："));

  // Try to find a line starting with "ERROR:"
  const errorLine = lines.find((l) => l.startsWith("ERROR:"));
  // Otherwise take the last line (typically the Python exception message)
  const lastLine = lines[lines.length - 1];
  const summary = (errorLine || lastLine || "未知错误").replace(
    /^ERROR:\s*/i,
    "",
  );

  if (!logPath) {
    return `处理失败：${summary}`;
  }
  return `处理失败：${summary}\n日志：${logPath}`;
}

function fileExists(filePath: string) {
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

function getParentItemID(item: Zotero.Item) {
  if (
    typeof (item as any).parentItemID === "number" &&
    (item as any).parentItemID > 0
  ) {
    return (item as any).parentItemID as number;
  }
  if (typeof (item as any).id === "number" && (item as any).id > 0) {
    return (item as any).id as number;
  }
  return undefined;
}

function pickFirstExistingPath(candidates: string[]) {
  for (const path of candidates) {
    if (path && fileExists(path)) {
      return path;
    }
  }
  return undefined;
}

function itemLooksLikeNote(item: any) {
  return typeof item?.isNote === "function"
    ? item.isNote()
    : item?.itemType === "note";
}

function itemLooksLikeAttachment(item: any) {
  return typeof item?.isAttachment === "function"
    ? item.isAttachment()
    : item?.itemType === "attachment";
}

function getNoteText(item: any) {
  if (typeof item?.getNote === "function") {
    return item.getNote();
  }
  return typeof item?.note === "string" ? item.note : "";
}

function getManagedPdf2mdTitle(item: Zotero.Item) {
  return (item.getDisplayTitle?.() || item.getField?.("title") || "").trim();
}

async function deleteItem(item: any) {
  if (typeof item?.eraseTx === "function") {
    await item.eraseTx();
    return;
  }
  if (typeof item?.erase === "function") {
    await item.erase();
  }
}

async function cleanupPdf2mdChildren(sourceItem: Zotero.Item) {
  const parentItemID = getParentItemID(sourceItem);
  if (!parentItemID) {
    return;
  }

  const itemsApi = (Zotero as any).Items;
  const childRecords =
    typeof itemsApi?.getByParentID === "function"
      ? itemsApi.getByParentID(parentItemID)
      : [];
  const children = Array.isArray(childRecords) ? childRecords : [];
  const keepTitles = new Set([
    "pdf2md-原文",
    "pdf2md-译文",
    "pdf2md-译文 Note",
  ]);

  for (const child of children) {
    const item =
      typeof child === "number"
        ? typeof itemsApi?.get === "function"
          ? itemsApi.get(child)
          : undefined
        : child;
    if (!item) {
      continue;
    }

    const title = getManagedPdf2mdTitle(item);
    const isManagedAttachment =
      itemLooksLikeAttachment(item) &&
      title.startsWith("pdf2md-") &&
      !keepTitles.has(title);
    const noteText = itemLooksLikeNote(item) ? getNoteText(item) : "";
    const isManagedNote =
      itemLooksLikeNote(item) &&
      !keepTitles.has(title) &&
      (title.startsWith("pdf2md-") ||
        noteText.includes("zotero-pdf2md-result-note") ||
        noteText.includes("zotero-pdf2md-markdown-preview"));

    if (!isManagedAttachment && !isManagedNote) {
      continue;
    }

    try {
      await deleteItem(item);
    } catch (error) {
      ztoolkit.log("cleanup pdf2md child failed", { title, error });
    }
  }
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
        reviewMode === "always" ? !reviewResult.skipped : !reviewResult.skipped;
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
      files.find(
        (p) => !p.endsWith(".mistral.md") && !p.endsWith("asset_index.md"),
      )
    );
  } catch (_error) {
    return undefined;
  }
}

async function syncAllOutputsAsAttachments(
  sourceItem: Zotero.Item,
  outDir: string,
  options: {
    titlePrefix?: string;
    updateNote?: boolean;
  } = {},
) {
  const sourceMdPath = PathUtils.join(outDir, "mistral.md");
  const targetMdPath = PathUtils.join(outDir, "target.md");

  const attachments: Array<{ path: string; title: string }> = [];
  if (fileExists(sourceMdPath)) {
    attachments.push({ path: sourceMdPath, title: "pdf2md-原文" });
  }
  if (fileExists(targetMdPath)) {
    attachments.push({ path: targetMdPath, title: "pdf2md-译文" });
  }

  if (attachments.length > 0) {
    try {
      await linkOutputFilesAsAttachments(sourceItem as any, attachments);
    } catch (error) {
      ztoolkit.log("sync attachments failed", error);
    }
  }

  if (options.updateNote && fileExists(targetMdPath)) {
    try {
      await PdfActionFactory.generateNoteFromMarkdown(sourceItem, targetMdPath);
    } catch (error) {
      ztoolkit.log("sync note failed", error);
    }
  }
}

export class PdfActionFactory {
  private static menuManagerID?: string;
  private static legacyMenuRegistered = false;

  static registerMenuItems() {
    if (!isPluginEnabled()) {
      this.unregisterMenuItems();
      return;
    }

    if (this.legacyMenuRegistered) {
      return;
    }

    const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`;
    ztoolkit.Menu.register("item", {
      tag: "menu",
      id: "zotero-itemmenu-zoteropdf2md",
      label: "PDF 转 Markdown",
      icon: menuIcon,
      children: [
        {
          tag: "menuitem",
          id: "zotero-itemmenu-zoteropdf2md-one-click",
          label: "一键 PDF → 译文 Note",
          commandListener: async () => {
            await this.runOneClickPipeline();
          },
          icon: menuIcon,
        },
        { tag: "menuseparator" },
        {
          tag: "menuitem",
          id: "zotero-itemmenu-zoteropdf2md-convert",
          label: "1. PDF 转 Markdown",
          commandListener: async () => {
            await this.runSelectedPdfToMarkdown();
          },
          icon: menuIcon,
        },
        {
          tag: "menuitem",
          id: "zotero-itemmenu-zoteropdf2md-convert-final",
          label: "2. 翻译 Markdown",
          commandListener: async () => {
            await this.runSelectedPdfToFinalTranslatedMarkdown();
          },
          icon: menuIcon,
        },
        {
          tag: "menuitem",
          id: "zotero-itemmenu-zoteropdf2md-generate-note",
          label: "3. 生成译文 Note",
          commandListener: async () => {
            await this.runSelectedMarkdownToNote();
          },
          icon: menuIcon,
        },
      ],
    });
    this.legacyMenuRegistered = true;
  }

  static unregisterMenuItems() {
    const menuManager = (Zotero as any).MenuManager;
    if (
      this.menuManagerID &&
      typeof menuManager?.unregisterMenu === "function"
    ) {
      menuManager.unregisterMenu(this.menuManagerID);
      this.menuManagerID = undefined;
    }
    if (this.legacyMenuRegistered) {
      ztoolkit.Menu.unregister("zotero-itemmenu-zoteropdf2md");
      this.legacyMenuRegistered = false;
    }
  }

  static onMainWindowLoad(_win: _ZoteroTypes.MainWindow) {}

  static onMainWindowUnload(_win: Window) {}

  static refreshMenuItems() {
    this.unregisterMenuItems();
    if (isPluginEnabled()) {
      this.registerMenuItems();
    }
  }

  private static ensureEnabled() {
    if (isPluginEnabled()) {
      return true;
    }
    showMessage("插件已停用。请先在插件偏好设置中启用。");
    return false;
  }

  private static registerMenuItemsWithMenuManager(): boolean {
    const menuManager = (Zotero as any).MenuManager;
    if (typeof menuManager?.registerMenu !== "function") {
      return false;
    }
    if (this.menuManagerID) {
      return true;
    }

    const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.svg`;
    const menuID = menuManager.registerMenu({
      menuID: "zotero-pdf2md-item-actions",
      pluginID: addon.data.config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "submenu",
          l10nID: getLocaleID("pdf-actions-menu"),
          icon: menuIcon,
          onShowing: (_event: Event, context: any) => {
            context.setVisible(
              isPluginEnabled() &&
                (hasSelectedPdfTarget() || hasSelectedMarkdownTarget()),
            );
          },
          menus: [
            {
              menuType: "menuitem",
              l10nID: getLocaleID("pdf-actions-one-click"),
              icon: menuIcon,
              onShowing: (_event: Event, context: any) => {
                context.setVisible(hasSelectedPdfTarget());
              },
              onCommand: async () => {
                await this.runOneClickPipeline();
              },
            },
            {
              menuType: "separator",
            },
            {
              menuType: "menuitem",
              l10nID: getLocaleID("pdf-actions-convert"),
              icon: menuIcon,
              onShowing: (_event: Event, context: any) => {
                context.setVisible(hasSelectedPdfTarget());
              },
              onCommand: async () => {
                await this.runSelectedPdfToMarkdown();
              },
            },
            {
              menuType: "menuitem",
              l10nID: getLocaleID("pdf-actions-translate"),
              icon: menuIcon,
              onShowing: (_event: Event, context: any) => {
                context.setVisible(hasSelectedPdfTarget());
              },
              onCommand: async () => {
                await this.runSelectedPdfToFinalTranslatedMarkdown();
              },
            },
            {
              menuType: "menuitem",
              l10nID: getLocaleID("pdf-actions-generate-note"),
              icon: menuIcon,
              onShowing: (_event: Event, context: any) => {
                context.setVisible(hasSelectedMarkdownTarget());
              },
              onCommand: async () => {
                await this.runSelectedMarkdownToNote();
              },
            },
          ],
        },
      ],
    });

    if (!menuID) {
      return false;
    }

    this.menuManagerID = menuID;
    return true;
  }

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
    if (!this.ensureEnabled()) {
      return;
    }

    const targets = await this.getRunnableTargets();
    if (!targets.length) {
      showMessage(
        "未找到可处理的 PDF 附件。请先选择 PDF 附件或包含 PDF 的条目。",
      );
      return;
    }

    for (const target of targets) {
      const outDir = getOutputDirForPdf(target.pdfPath);
      const progressWin = new ztoolkit.ProgressWindow(
        addon.data.config.addonName,
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )
        .createLine({
          text: `正在处理 PDF 转 Markdown：${target.title}`,
          type: "default",
          progress: 30,
        })
        .show();

      try {
        const result = await preparePdfToMarkdown(target.pdfPath);
        await syncAllOutputsAsAttachments(target.sourceItem, result.outDir);
        await cleanupPdf2mdChildren(target.sourceItem);
        progressWin.changeLine({
          progress: 100,
          text: `已完成 OCR：${target.title}\n${result.markdownPath}`,
        });
        progressWin.startCloseTimer(5000);
      } catch (error) {
        ztoolkit.log("pdf-to-md action failed", error);
        progressWin.changeLine({
          progress: 100,
          text: formatErrorForProgress(error),
        });
        progressWin.startCloseTimer(8000);
      }
    }
  }

  static async runSelectedPdfToFinalTranslatedMarkdown() {
    if (!this.ensureEnabled()) {
      return;
    }

    const targets = await this.getRunnableTargets();
    if (!targets.length) {
      showMessage(
        "未找到可处理的 PDF 附件。请先选择 PDF 附件或包含 PDF 的条目。",
      );
      return;
    }

    const llmApiKey = getLlmApiKey();
    if (!llmApiKey) {
      showMessage(
        "未配置 LLM 接口。请先在插件偏好设置中填写 LLM API 密钥、Base URL 和模型名称。",
      );
      return;
    }

    const { sourceLanguage, targetLanguage } = getLanguagePrefs();
    const sourceLabel = getLanguageDisplayName(sourceLanguage);
    const targetLabel = getLanguageDisplayName(targetLanguage);

    for (const target of targets) {
      const outDir = getOutputDirForPdf(target.pdfPath);
      const targetMdPath = PathUtils.join(outDir, "target.md");

      // Check if target.md already exists and translation is complete
      const progress = await readTranslationProgress(outDir);
      if (fileExists(targetMdPath) && progress?.status === "done") {
        await syncAllOutputsAsAttachments(target.sourceItem, outDir);
        showMessage(`已复用现有译文：${target.title}`);
        continue;
      }

      const progressWin = new ztoolkit.ProgressWindow(
        addon.data.config.addonName,
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )
        .createLine({
          text: `正在翻译 ${sourceLabel} → ${targetLabel}：${target.title}`,
          type: "default",
          progress: 20,
        })
        .show();

      const translatePromise = buildFinalTranslatedMarkdown(
        target.pdfPath,
        sourceLanguage,
        targetLanguage,
      );
      const win = Zotero.getMainWindow?.() || (globalThis as any);
      const pollId = win.setInterval(async () => {
        const p = await readTranslationProgress(outDir);
        if (p && p.total_chunks > 0) {
          const pct = Math.round((p.current_chunk / p.total_chunks) * 80) + 20;
          progressWin.changeLine({
            text: `正在翻译第 ${p.current_chunk}/${p.total_chunks} 块：${target.title}`,
            progress: pct,
          });
        }
      }, 2000);

      try {
        let result: Awaited<ReturnType<typeof buildFinalTranslatedMarkdown>>;
        try {
          result = await translatePromise;
        } finally {
          win.clearInterval(pollId);
        }
        await syncAllOutputsAsAttachments(target.sourceItem, result.outDir);
        await cleanupPdf2mdChildren(target.sourceItem);
        progressWin.changeLine({
          progress: 100,
          text: `已完成翻译：${target.title}\n${result.finalMarkdownPath}`,
        });
        progressWin.startCloseTimer(5000);
      } catch (error) {
        ztoolkit.log("pdf-to-final-markdown action failed", error);
        progressWin.changeLine({
          progress: 100,
          text: formatErrorForProgress(error),
        });
        progressWin.startCloseTimer(8000);
      }
    }
  }

  static async runSelectedMarkdownToNote() {
    if (!this.ensureEnabled()) {
      return;
    }

    const targets = (await this.getRunnableMarkdownTargets()).filter(
      (target) =>
        target.title === "pdf2md-译文" ||
        /(?:^|\/)target\.md$/i.test(target.markdownPath) ||
        /译文|翻译 Markdown/.test(target.title),
    );
    if (!targets.length) {
      showMessage("未找到可处理的译文 Markdown 附件。请先选择 pdf2md-译文。");
      return;
    }

    for (const target of targets) {
      const progressWin = new ztoolkit.ProgressWindow(
        addon.data.config.addonName,
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )
        .createLine({
          text: `正在生成译文 Note：${target.title}`,
          type: "default",
          progress: 40,
        })
        .show();

      try {
        await this.generateNoteFromMarkdown(
          target.sourceItem,
          target.markdownPath,
        );
        progressWin.changeLine({
          progress: 100,
          text: `已完成译文 Note：${target.title}`,
        });
        progressWin.startCloseTimer(5000);
      } catch (error) {
        ztoolkit.log("generate-note action failed", error);
        progressWin.changeLine({
          progress: 100,
          text: formatErrorForProgress(error),
        });
        progressWin.startCloseTimer(8000);
      }
    }
  }

  public static async generateNoteFromMarkdown(
    sourceItem: Zotero.Item,
    markdownPath: string,
  ) {
    const hasLlmKey = !!getLlmApiKey();
    let htmlPath = await writeMarkdownPreviewHtmlFile(
      markdownPath,
      "pdf2md-译文 Note",
    );
    if (htmlPath && hasLlmKey) {
      try {
        const reviewResult = await reviewMarkdownWithHtml(
          markdownPath,
          htmlPath,
          "pdf2md-译文 Note",
        );
        if (!reviewResult.skipped) {
          htmlPath = await writeMarkdownPreviewHtmlFile(
            markdownPath,
            "pdf2md-译文 Note",
          );
        }
      } catch (reviewError) {
        ztoolkit.log("markdown review skipped due to error", reviewError);
      }
    }
    let validation:
      | Awaited<ReturnType<typeof validateMarkdownNoteStructure>>
      | undefined;
    if (htmlPath) {
      validation = await validateMarkdownNoteStructure(
        markdownPath,
        htmlPath,
        "pdf2md-译文 Note",
      );
    }
    if (validation && !validation.skipped && validation.status === "fail") {
      const details = (validation.issues || []).slice(0, 3).join("；");
      ztoolkit.log("note validation failed (non-blocking)", {
        summary: validation.summary,
        details,
        reportPath: validation.reportPath,
      });
    }
    await upsertMarkdownPreviewNote(sourceItem as any, {
      title: "pdf2md-译文 Note",
      markdownPath,
      validation:
        validation && !validation.skipped && validation.status
          ? {
              status: validation.status,
              summary: validation.summary,
              issues: validation.issues,
              reportPath: validation.reportPath,
            }
          : undefined,
    });
    await cleanupPdf2mdChildren(sourceItem);
  }

  static async runOneClickPipeline() {
    if (!this.ensureEnabled()) {
      return;
    }

    const targets = await this.getRunnableTargets();
    if (!targets.length) {
      showMessage(
        "未找到可处理的 PDF 附件。请先选择 PDF 附件或包含 PDF 的条目。",
      );
      return;
    }

    const llmApiKey = getLlmApiKey();
    if (!llmApiKey) {
      showMessage(
        "未配置 LLM 接口。请先在插件偏好设置中填写 LLM API 密钥、Base URL 和模型名称。",
      );
      return;
    }

    const { sourceLanguage, targetLanguage } = getLanguagePrefs();

    for (const target of targets) {
      const outDir = getOutputDirForPdf(target.pdfPath);
      const targetMdPath = PathUtils.join(outDir, "target.md");

      const progressWin = new ztoolkit.ProgressWindow(
        addon.data.config.addonName,
        {
          closeOnClick: true,
          closeTime: -1,
        },
      )
        .createLine({
          text: `[1/3] 正在 OCR：${target.title}`,
          type: "default",
          progress: 10,
        })
        .show();

      try {
        // Stage 1: OCR
        const ocrResult = await preparePdfToMarkdown(target.pdfPath);
        await syncAllOutputsAsAttachments(target.sourceItem, ocrResult.outDir);

        // Stage 2: Translation
        const progress = await readTranslationProgress(outDir);
        let translateResult: Awaited<
          ReturnType<typeof buildFinalTranslatedMarkdown>
        >;

        if (fileExists(targetMdPath) && progress?.status === "done") {
          translateResult = {
            outDir,
            finalMarkdownPath: targetMdPath,
            sourceLanguage,
            targetLanguage,
            skippedPrepare: true,
            resumed: false,
            startChunk: undefined,
            sourceMarkdownPath: PathUtils.join(outDir, "mistral.md"),
            assetIndexPath: PathUtils.join(outDir, "asset_index.md"),
          };
        } else {
          progressWin.changeLine({
            text: `[2/3] 正在翻译：${target.title}`,
            progress: 30,
          });

          const translatePromise = buildFinalTranslatedMarkdown(
            target.pdfPath,
            sourceLanguage,
            targetLanguage,
          );
          const win = Zotero.getMainWindow?.() || (globalThis as any);
          const pollId = win.setInterval(async () => {
            const p = await readTranslationProgress(outDir);
            if (p && p.total_chunks > 0) {
              const pct =
                30 + Math.round((p.current_chunk / p.total_chunks) * 50);
              progressWin.changeLine({
                text: `[2/3] 翻译第 ${p.current_chunk}/${p.total_chunks} 块：${target.title}`,
                progress: pct,
              });
            }
          }, 2000);

          try {
            translateResult = await translatePromise;
          } finally {
            win.clearInterval(pollId);
          }
          await syncAllOutputsAsAttachments(
            target.sourceItem,
            translateResult.outDir,
          );
        }

        // Stage 3: Note
        progressWin.changeLine({
          text: `[3/3] 生成译文 Note：${target.title}`,
          progress: 85,
        });
        await this.generateNoteFromMarkdown(
          target.sourceItem,
          translateResult.finalMarkdownPath,
        );

        progressWin.changeLine({
          progress: 100,
          text: `已完成一键处理：${target.title}`,
        });
        progressWin.startCloseTimer(5000);
      } catch (error) {
        ztoolkit.log("one-click pipeline failed", error);
        progressWin.changeLine({
          progress: 100,
          text: formatErrorForProgress(error),
        });
        progressWin.startCloseTimer(8000);
      }
    }
  }
}
