import { config } from "../../package.json";

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
}

function bindPrefEvents() {
  addon.data
    .prefs!.window.document?.querySelector(
      `#zotero-prefpane-${config.addonRef}-enable`,
    )
    ?.addEventListener("command", (e: Event) => {
      ztoolkit.log(e);
      addon.data.prefs!.window.alert(
        `已切换为 ${(e.target as XUL.Checkbox).checked ? "开启" : "关闭"}。`,
      );
    });

  [
    "source-language",
    "target-language",
    "python-path",
    "mistral-key",
    "llm-api-key",
    "llm-api-url",
    "llm-model",
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
}
