#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TASK_TMP="${TMPDIR%/}/fcdp-unrestricted-pipe.XXXXXX"
PROFILE_DIR="$(mktemp -d "$TASK_TMP")"
SOCKET="$PROFILE_DIR/fcdp-pipe.sock"
LOG="$PROFILE_DIR/fcdp-pipe.log"
RESULT="${1:-${TMPDIR%/}/fcdp-pipe-matrix.json}"
DAEMON_PID=""

cleanup() {
  if [[ "$DAEMON_PID" =~ ^[0-9]+$ ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID"
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  case "$PROFILE_DIR" in
    "${TMPDIR%/}"/fcdp-unrestricted-pipe.*) rm -rf -- "$PROFILE_DIR" ;;
    *) printf 'refusing to remove unexpected profile path: %s\n' "$PROFILE_DIR" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

node "$ROOT/fcdp-pipe.mjs" --socket "$SOCKET" --profile "$PROFILE_DIR/chrome" >"$LOG" 2>&1 &
DAEMON_PID=$!

for _ in {1..100}; do
  [[ -S "$SOCKET" ]] && break
  kill -0 "$DAEMON_PID" 2>/dev/null || break
  sleep 0.1
done

if [[ ! -S "$SOCKET" ]]; then
  printf 'pipe bridge failed to start\n' >&2
  sed -n '1,80p' "$LOG" >&2
  exit 2
fi

export FCDP_PIPE_SOCKET="$SOCKET"
export FCDP_TAB_CACHE="$PROFILE_DIR/fcdp-tab-cache"
export FCDP_BIN="$ROOT/fcdp"
unset FCDP_CDP_URL

python3 "$ROOT/tools/repro/fcdp-unrestricted-domains/probe.py" | tee "$RESULT"
