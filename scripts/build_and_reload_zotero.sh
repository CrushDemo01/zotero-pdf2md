#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=${0:A:h}
PLUGIN_DIR=${SCRIPT_DIR:h}

DEFAULT_PROFILE_DIR="$HOME/Library/Application Support/Zotero/Profiles/sq34jomk.default"
ADDON_ID="${ADDON_ID:-zotero-pdf2md@yyds.dev}"
PREFS_PREFIX="${PREFS_PREFIX:-extensions.zotero.zoteroPdf2md}"
BUILD_ARTIFACT="${BUILD_ARTIFACT:-$PLUGIN_DIR/.scaffold/build/zotero-pdf-2-md.xpi}"
PROFILE_DIR="${ZOTERO_PROFILE_DIR:-$DEFAULT_PROFILE_DIR}"
CLEAN_INSTALL=1
PURGE_PLUGIN_DATA=0

function refresh_profile_paths() {
  TARGET_XPI="$PROFILE_DIR/extensions/${ADDON_ID}.xpi"
  EXTENSIONS_DIR="$PROFILE_DIR/extensions"
  STAGED_DIR="$EXTENSIONS_DIR/staged"
  ADDON_STARTUP_CACHE="$PROFILE_DIR/addonStartup.json.lz4"
  EXTENSIONS_JSON="$PROFILE_DIR/extensions.json"
  PREFS_FILE="$PROFILE_DIR/prefs.js"
  DEBUGGER_PREFS_FILE="$PROFILE_DIR/chrome_debugger_profile/prefs.js"
}

function log_info() {
  printf '[zotero-pdf2md] %s\n' "$1"
}

function require_path() {
  local path="$1"
  local message="$2"
  if [[ ! -e "$path" ]]; then
    printf '[zotero-pdf2md] %s: %s\n' "$message" "$path" >&2
    exit 1
  fi
}

function is_zotero_running() {
  pgrep -x "zotero" >/dev/null 2>&1
}

function stop_zotero() {
  if is_zotero_running; then
    log_info "Stopping Zotero"
    osascript -e 'quit app "Zotero"'
    for _ in {1..30}; do
      if ! is_zotero_running; then
        return 0
      fi
      sleep 1
    done
    printf '[zotero-pdf2md] Zotero did not stop within 30 seconds\n' >&2
    exit 1
  fi
}

function clean_previous_install() {
  log_info "Removing previous plugin install for $ADDON_ID"
  rm -f "$TARGET_XPI"
  rm -rf "$STAGED_DIR/$ADDON_ID"
  rm -rf "$STAGED_DIR/${ADDON_ID}.xpi"
  rm -rf "$STAGED_DIR"/**/"$ADDON_ID"(N)
  rm -rf "$STAGED_DIR"/**/"${ADDON_ID}.xpi"(N)
  rm -f "$ADDON_STARTUP_CACHE"
}

function filter_pref_file() {
  local prefs_path="$1"
  [[ -f "$prefs_path" ]] || return 0

  log_info "Purging plugin prefs from $prefs_path"
  perl -0pi -e "s/^user_pref\\(\"\\Q$PREFS_PREFIX\\E(?:\\.[^\"]*)?\", .*?\\);\\n//mg" "$prefs_path"
  perl -0pi -e "s/^user_pref\\(\"extensions\\.zotero\\.lastSelectedPrefPane\", \"plugin-pane-[^\"]*\\Q$ADDON_ID\\E\"\\);\\n//mg" "$prefs_path"
  perl -0pi -e "s/(\"\\Q$ADDON_ID\\E\":\"[^\"]*\",?)//g; s/,(\\s*[}\\]])/\\1/g; s/\\{,?/\\{/g" "$prefs_path"
}

function purge_plugin_data() {
  filter_pref_file "$PREFS_FILE"
  filter_pref_file "$DEBUGGER_PREFS_FILE"

  if [[ -f "$EXTENSIONS_JSON" ]]; then
    log_info "Purging plugin install record from $EXTENSIONS_JSON"
    python3 - "$EXTENSIONS_JSON" "$ADDON_ID" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
addon_id = sys.argv[2]
data = json.loads(path.read_text())
addons = data.get("addons", [])
data["addons"] = [addon for addon in addons if addon.get("id") != addon_id]
path.write_text(json.dumps(data, separators=(",", ":")))
PY
  fi
}

if [[ ! -d "$PROFILE_DIR" ]]; then
  ALT_PROFILE=$(find "$HOME/Library/Application Support/Zotero/Profiles" -maxdepth 1 -type d -name '*.default*' | head -n 1 || true)
  if [[ -n "${ALT_PROFILE:-}" ]]; then
    PROFILE_DIR="$ALT_PROFILE"
  fi
fi

refresh_profile_paths

require_path "$PLUGIN_DIR/package.json" "Plugin directory is invalid"
require_path "$PROFILE_DIR" "Zotero profile directory not found"

for arg in "$@"; do
  case "$arg" in
    --no-clean)
      CLEAN_INSTALL=0
      ;;
    --purge-plugin-data)
      PURGE_PLUGIN_DATA=1
      ;;
    --help|-h)
      cat <<EOF
Usage: ./scripts/build_and_reload_zotero.sh [--no-clean] [--purge-plugin-data]

Default behavior performs a clean reinstall:
  1. build plugin
  2. stop Zotero
  3. remove the previous installed XPI, staged leftovers, and addon startup cache
  4. install the new XPI
  5. restart Zotero

Options:
  --no-clean            Skip uninstall and only overwrite the installed XPI
  --purge-plugin-data   Also remove this plugin's prefs and install record from the Zotero profile
EOF
      exit 0
      ;;
    *)
      printf '[zotero-pdf2md] Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$CLEAN_INSTALL" -eq 0 && "$PURGE_PLUGIN_DATA" -eq 1 ]]; then
  log_info "--purge-plugin-data implies a clean reinstall"
  CLEAN_INSTALL=1
fi

log_info "Building plugin in $PLUGIN_DIR"
(cd "$PLUGIN_DIR" && npm run build)

require_path "$BUILD_ARTIFACT" "Build artifact not found"

stop_zotero

if [[ "$CLEAN_INSTALL" -eq 1 ]]; then
  clean_previous_install
fi

if [[ "$PURGE_PLUGIN_DATA" -eq 1 ]]; then
  purge_plugin_data
fi

log_info "Installing XPI to $TARGET_XPI"
mkdir -p "${TARGET_XPI:h}"
cp "$BUILD_ARTIFACT" "$TARGET_XPI"

log_info "Starting Zotero"
open -a Zotero

for _ in {1..30}; do
  if is_zotero_running; then
    log_info "Zotero is running"
    exit 0
  fi
  sleep 1
done

printf '[zotero-pdf2md] Zotero did not start within 30 seconds\n' >&2
exit 1
