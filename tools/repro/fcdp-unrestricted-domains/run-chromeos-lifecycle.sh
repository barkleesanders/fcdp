#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CACHE_BASE="${XDG_CACHE_HOME:-$HOME/.cache}/fcdp-chromeos/1684555"
PID_FILE="$CACHE_BASE/host-relay.pid"
STARTED=0

cleanup() {
  if ((STARTED)); then
    "$ROOT/fcdp-chromeos" stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

ENDPOINT="$("$ROOT/fcdp-chromeos" start)"
STARTED=1
PORT="${ENDPOINT##*:}"
[[ "$PORT" =~ ^[0-9]+$ ]] || {
  printf 'ChromeOS start returned an invalid endpoint: %s\n' "$ENDPOINT" >&2
  exit 2
}

"$ROOT/fcdp-chromeos" status >/dev/null
"$ROOT/fcdp-chromeos" verify >/dev/null

[[ -f "$PID_FILE" ]] || {
  printf 'ChromeOS host relay PID file was not created\n' >&2
  exit 2
}
RELAY_PID="$(<"$PID_FILE")"
if [[ ! "$RELAY_PID" =~ ^[0-9]+$ ]] || ! kill -0 "$RELAY_PID" 2>/dev/null; then
  printf 'ChromeOS host relay PID is not alive: %s\n' "$RELAY_PID" >&2
  exit 2
fi

LISTENERS="$(lsof -nP -a -p "$RELAY_PID" -iTCP -sTCP:LISTEN -Fn | sed -n 's/^n//p')"
[[ "$LISTENERS" == "127.0.0.1:$PORT" ]] || {
  printf 'ChromeOS host relay is not loopback-only: %s\n' "$LISTENERS" >&2
  exit 2
}

"$ROOT/fcdp-chromeos" stop
STARTED=0
[[ ! -f "$PID_FILE" ]] || {
  printf 'ChromeOS stop left the host relay PID file behind\n' >&2
  exit 2
}
if kill -0 "$RELAY_PID" 2>/dev/null; then
  printf 'ChromeOS stop left host relay process %s alive\n' "$RELAY_PID" >&2
  exit 2
fi

printf 'ChromeOS start/status/verify/stop lifecycle: pass\n'
printf 'host relay loopback binding and PID cleanup: pass\n'
