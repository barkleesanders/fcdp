#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHROME_APP="${FCDP_CHROME_APP:-Google Chrome}"
TASK_TMP="${TMPDIR%/}/fcdp-unrestricted.XXXXXX"
PROFILE_DIR="$(mktemp -d "$TASK_TMP")"
RESULT="${1:-${TMPDIR%/}/fcdp-port-matrix.json}"

cleanup() {
  if [[ -n "${FCDP_CDP_URL:-}" ]]; then
    FCDP_CDP_URL="$FCDP_CDP_URL" "$ROOT/fcdp" raw --browser Browser.close >/dev/null 2>&1 || true
  fi
  for _ in {1..50}; do
    pgrep -f -- "--user-data-dir=$PROFILE_DIR" >/dev/null 2>&1 || break
    sleep 0.1
  done
  case "$PROFILE_DIR" in
    "${TMPDIR%/}"/fcdp-unrestricted.*) rm -rf -- "$PROFILE_DIR" ;;
    *) printf 'refusing to remove unexpected profile path: %s\n' "$PROFILE_DIR" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

open -na "$CHROME_APP" --args \
  --headless=new \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port=0 \
  --user-data-dir="$PROFILE_DIR"

for _ in {1..100}; do
  [[ -s "$PROFILE_DIR/DevToolsActivePort" ]] && break
  sleep 0.2
done

if [[ ! -s "$PROFILE_DIR/DevToolsActivePort" ]]; then
  printf 'isolated Chrome did not publish DevToolsActivePort\n' >&2
  exit 2
fi

PORT="$(sed -n '1p' "$PROFILE_DIR/DevToolsActivePort")"
if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  printf 'invalid DevTools port: %s\n' "$PORT" >&2
  exit 2
fi

export FCDP_CDP_URL="http://127.0.0.1:$PORT"
export FCDP_TAB_CACHE="$PROFILE_DIR/fcdp-tab-cache"
export FCDP_BIN="$ROOT/fcdp"

python3 "$ROOT/tools/repro/fcdp-unrestricted-domains/probe.py" | tee "$RESULT"
