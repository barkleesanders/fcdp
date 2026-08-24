#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VERSION=154.0.8020.2
ARCHIVE_SHA256=31dcba536462911fc697aa6969f9992dd1ebe86acc28cecf342877676de43472
URL="https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/mac-arm64/chrome-headless-shell-mac-arm64.zip"
CACHE_BASE="${XDG_CACHE_HOME:-$HOME/.cache}/fcdp-headless-shell/$VERSION"
ARCHIVE="$CACHE_BASE/chrome-headless-shell-mac-arm64.zip"
SHELL_BIN="$CACHE_BASE/chrome-headless-shell-mac-arm64/chrome-headless-shell"
PROFILE_DIR="$(mktemp -d "${TMPDIR%/}/fcdp-headless-shell.XXXXXX")"
RESULT="${1:-${TMPDIR%/}/fcdp-headless-shell-matrix.json}"
SHELL_PID=""

cleanup() {
  if [[ "$SHELL_PID" =~ ^[0-9]+$ ]] && kill -0 "$SHELL_PID" 2>/dev/null; then
    kill "$SHELL_PID"
    wait "$SHELL_PID" 2>/dev/null || true
  fi
  case "$PROFILE_DIR" in
    "${TMPDIR%/}"/fcdp-headless-shell.*) rm -rf -- "$PROFILE_DIR" ;;
    *) printf 'refusing to remove unexpected profile path: %s\n' "$PROFILE_DIR" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

mkdir -p "$CACHE_BASE"
if [[ ! -f "$ARCHIVE" ]] || \
   [[ "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')" != "$ARCHIVE_SHA256" ]]; then
  curl -fL --retry 3 --output "$ARCHIVE.partial" "$URL"
  if [[ "$(shasum -a 256 "$ARCHIVE.partial" | awk '{print $1}')" != "$ARCHIVE_SHA256" ]]; then
    printf 'headless-shell archive failed SHA-256 verification\n' >&2
    exit 2
  fi
  mv "$ARCHIVE.partial" "$ARCHIVE"
fi
if [[ ! -x "$SHELL_BIN" ]]; then
  unzip -q -o "$ARCHIVE" -d "$CACHE_BASE"
fi
[[ -x "$SHELL_BIN" ]] || {
  printf 'headless-shell binary is missing after extraction\n' >&2
  exit 2
}

"$SHELL_BIN" \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port=0 \
  --user-data-dir="$PROFILE_DIR" \
  about:blank >"$PROFILE_DIR/chrome.log" 2>&1 &
SHELL_PID=$!

for _ in {1..100}; do
  [[ -s "$PROFILE_DIR/DevToolsActivePort" ]] && break
  kill -0 "$SHELL_PID" 2>/dev/null || break
  sleep 0.1
done
if [[ ! -s "$PROFILE_DIR/DevToolsActivePort" ]]; then
  printf 'headless shell did not publish DevToolsActivePort\n' >&2
  sed -n '1,80p' "$PROFILE_DIR/chrome.log" >&2
  exit 2
fi

PORT="$(sed -n '1p' "$PROFILE_DIR/DevToolsActivePort")"
[[ "$PORT" =~ ^[0-9]+$ ]] || {
  printf 'invalid headless-shell DevTools port: %s\n' "$PORT" >&2
  exit 2
}
export FCDP_CDP_URL="http://127.0.0.1:$PORT"
export FCDP_TAB_CACHE="$PROFILE_DIR/fcdp-tab-cache"
export FCDP_BIN="$ROOT/fcdp"
python3 "$ROOT/tools/repro/fcdp-unrestricted-domains/probe.py" | tee "$RESULT"
