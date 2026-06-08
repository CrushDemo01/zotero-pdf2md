import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { PdfActionFactory } from "./pdfActions";

interface LlmProfile {
  name: string;
  apiUrl: string;
  model: string;
  apiKey?: string;
}

function getDoc() {
  return addon.data.prefs!.window.document;
}

function el(id: string) {
  return getDoc()?.getElementById(id) ?? null;
}

function readProfiles(): LlmProfile[] {
  const raw = getPref("llmProfiles");
  if (!raw || typeof raw !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProfiles(profiles: LlmProfile[]) {
  const sanitized = profiles.map(({ name, apiUrl, model }) => ({
    name,
    apiUrl,
    model,
  }));
  setPref("llmProfiles", JSON.stringify(sanitized));
}

function rebuildProfileMenu() {
  const popup = el(`zotero-prefpane-${config.addonRef}-llm-profile-popup`);
  if (!popup) {
    return;
  }

  while (popup.firstChild) {
    popup.removeChild(popup.firstChild);
  }

  const noneItem = getDoc().createXULElement("menuitem");
  noneItem.setAttribute("value", "");
  noneItem.setAttribute("label", "\uFF08\u81EA\u5B9A\u4E49\uFF09");
  popup.appendChild(noneItem);

  for (const profile of readProfiles()) {
    const item = getDoc().createXULElement("menuitem");
    item.setAttribute("value", profile.name);
    item.setAttribute("label", profile.name);
    popup.appendChild(item);
  }

  const menulist = el(
    `zotero-prefpane-${config.addonRef}-llm-profile-select`,
  ) as any;
  if (menulist) {
    const active = getPref("llmActiveProfile") || "";
    menulist.value = active;
  }
}

function applyProfile(profile: LlmProfile | undefined) {
  const urlInput = el(
    `zotero-prefpane-${config.addonRef}-llm-api-url`,
  ) as HTMLInputElement | null;
  const modelInput = el(
    `zotero-prefpane-${config.addonRef}-llm-model`,
  ) as HTMLInputElement | null;

  if (profile) {
    setPref("llmApiUrl", profile.apiUrl);
    setPref("llmModel", profile.model);
    setPref("llmActiveProfile", profile.name);
    if (urlInput) urlInput.value = profile.apiUrl;
    if (modelInput) modelInput.value = profile.model;
  } else {
    setPref("llmActiveProfile", "");
  }
}

function onProfileSelect() {
  const menulist = el(
    `zotero-prefpane-${config.addonRef}-llm-profile-select`,
  ) as any;
  if (!menulist) {
    return;
  }
  const selected = menulist.value;
  if (!selected) {
    applyProfile(undefined);
    return;
  }
  const profiles = readProfiles();
  const profile = profiles.find((p) => p.name === selected);
  if (profile) {
    applyProfile(profile);
  }
}

function onProfileSave() {
  const win = addon.data.prefs!.window;
  const existing = getPref("llmActiveProfile") || "";
  const name = (win as any).prompt?.("输入配置方案名称：", existing || "") as
    | string
    | null;
  if (!name?.trim()) {
    return;
  }
  const trimmed = name.trim();

  const apiUrl = (getPref("llmApiUrl") as string) || "";
  const model = (getPref("llmModel") as string) || "";

  const profiles = readProfiles();
  const idx = profiles.findIndex((p) => p.name === trimmed);
  const entry: LlmProfile = { name: trimmed, apiUrl, model };
  if (idx >= 0) {
    profiles[idx] = entry;
  } else {
    profiles.push(entry);
  }
  saveProfiles(profiles);
  setPref("llmActiveProfile", trimmed);
  rebuildProfileMenu();
}

function onProfileDelete() {
  const menulist = el(
    `zotero-prefpane-${config.addonRef}-llm-profile-select`,
  ) as any;
  if (!menulist) {
    return;
  }
  const selected = menulist.value;
  if (!selected) {
    return;
  }
  const profiles = readProfiles().filter((p) => p.name !== selected);
  saveProfiles(profiles);
  setPref("llmActiveProfile", "");
  rebuildProfileMenu();
}

export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [],
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }
  bindPrefEvents();
  rebuildProfileMenu();
}

function bindPrefEvents() {
  addon.data
    .prefs!.window.document?.querySelector(
      `#zotero-prefpane-${config.addonRef}-enable`,
    )
    ?.addEventListener("command", (e: Event) => {
      ztoolkit.log(e);
      const enabled = (e.target as XUL.Checkbox).checked;
      setPref("enable", enabled);
      PdfActionFactory.refreshMenuItems();
      addon.data.prefs!.window.alert(`已切换为 ${enabled ? "开启" : "关闭"}。`);
    });

  [
    "source-language",
    "target-language",
    "python-path",
    "mistral-key",
    "llm-api-key",
    "llm-api-url",
    "llm-model",
    "translation-chunk-chars",
    "skip-reference-translation",
    "inline-images",
  ].forEach((suffix) => {
    addon.data
      .prefs!.window.document?.querySelector(
        `#zotero-prefpane-${config.addonRef}-${suffix}`,
      )
      ?.addEventListener("change", (e: Event) => {
        ztoolkit.log("偏好设置已更新", suffix, e);
      });
  });

  el(`zotero-prefpane-${config.addonRef}-llm-profile-select`)?.addEventListener(
    "command",
    () => onProfileSelect(),
  );

  el(`zotero-prefpane-${config.addonRef}-llm-profile-save`)?.addEventListener(
    "click",
    () => onProfileSave(),
  );

  el(`zotero-prefpane-${config.addonRef}-llm-profile-delete`)?.addEventListener(
    "click",
    () => onProfileDelete(),
  );
}
