type AttachmentSourceItem = Zotero.Item & {
  id?: number;
  parentItemID?: number;
  isAttachment?: () => boolean;
  isRegularItem?: () => boolean;
  getFilePath?: () => string;
};

function normalizePath(filePath: string) {
  return (filePath || "").replace(/\\/g, "/");
}

function toLocalFile(filePath: string) {
  const file = (Components.classes as any)[
    "@mozilla.org/file/local;1"
  ].createInstance(
    (Components.interfaces as any).nsIFile,
  );
  file.initWithPath(filePath);
  return file;
}

function fileExists(filePath: string) {
  try {
    const file = toLocalFile(filePath);
    return file.exists() && file.isFile();
  } catch (_error) {
    return false;
  }
}

function resolveParentItemID(item: AttachmentSourceItem) {
  if (typeof item.parentItemID === "number" && item.parentItemID > 0) {
    return item.parentItemID;
  }
  if (typeof item.id === "number" && item.id > 0) {
    return item.id;
  }
  return undefined;
}

async function safeGetChildItems(parentItemID: number) {
  const itemsApi = (Zotero as any).Items;
  if (typeof itemsApi?.getByParentID === "function") {
    const children = itemsApi.getByParentID(parentItemID);
    return Array.isArray(children) ? children : [];
  }
  return [];
}

function isAttachmentItem(item: any) {
  return typeof item?.isAttachment === "function"
    ? item.isAttachment()
    : item?.itemType === "attachment";
}

function safeGetAttachmentPath(item: any): string | undefined {
  try {
    const path = typeof item?.getFilePath === "function" ? item.getFilePath() : undefined;
    return typeof path === "string" ? path : typeof path?.toString === "function" ? path.toString() : undefined;
  } catch (_error) {
    return undefined;
  }
}

export async function linkOutputFilesAsAttachments(
  sourceItem: AttachmentSourceItem,
  files: Array<{ path: string; title?: string }>,
) {
  const parentItemID = resolveParentItemID(sourceItem);
  if (!parentItemID) {
    return [];
  }

  const children = await safeGetChildItems(parentItemID);
  const existingPaths = new Set<string>();
  for (const child of children) {
    const childItem =
      typeof child === "number" ? (Zotero as any).Items?.get?.(child) : child;
    if (!isAttachmentItem(childItem)) {
      continue;
    }
    const path = safeGetAttachmentPath(childItem);
    if (path) {
      existingPaths.add(normalizePath(path));
    }
  }

  const created: Zotero.Item[] = [];
  for (const file of files) {
    const filePath = normalizePath(file.path);
    if (!filePath) {
      continue;
    }
    if (!fileExists(filePath)) {
      ztoolkit.log("skip attach missing file", { filePath, title: file.title });
      continue;
    }
    if (existingPaths.has(filePath)) {
      continue;
    }

    const title =
      file.title ||
      (typeof PathUtils?.filename === "function" ? PathUtils.filename(filePath) : undefined) ||
      filePath;

    const attachmentsApi = (Zotero as any).Attachments;
    const createFn =
      typeof attachmentsApi?.importFromFile === "function"
        ? attachmentsApi.importFromFile.bind(attachmentsApi)
        : typeof attachmentsApi?.linkFromFile === "function"
          ? attachmentsApi.linkFromFile.bind(attachmentsApi)
          : undefined;

    if (!createFn) {
      throw new Error("Zotero.Attachments.linkFromFile/importFromFile is not available.");
    }

    try {
      const attachment = await createFn({
        file: toLocalFile(filePath),
        parentItemID,
        libraryID: (sourceItem as any).libraryID,
        title,
      });
      if (attachment) {
        created.push(attachment as Zotero.Item);
        existingPaths.add(filePath);
      }
    } catch (error) {
      ztoolkit.log("attach file failed", { filePath, title, error });
    }
  }

  return created;
}
