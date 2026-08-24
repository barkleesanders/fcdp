#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR%/}/fcdp-host-relay.XXXXXX")"
TARGET_PID=""
RELAY_PID=""

cleanup() {
  [[ "$RELAY_PID" =~ ^[0-9]+$ ]] && kill "$RELAY_PID" 2>/dev/null || true
  [[ "$TARGET_PID" =~ ^[0-9]+$ ]] && kill "$TARGET_PID" 2>/dev/null || true
  case "$WORK" in
    "${TMPDIR%/}"/fcdp-host-relay.*) rm -rf -- "$WORK" ;;
    *) printf 'refusing to remove unexpected work path: %s\n' "$WORK" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

free_port() {
  python3 - <<'PY'
import socket

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
}

TARGET_PORT="$(free_port)"
LISTEN_PORT="$(free_port)"
while [[ "$LISTEN_PORT" == "$TARGET_PORT" ]]; do
  LISTEN_PORT="$(free_port)"
done
printf 'host-relay-positive-control\n' >"$WORK/probe.txt"

python3 -m http.server "$TARGET_PORT" \
  --bind 127.0.0.1 \
  --directory "$WORK" \
  >"$WORK/target.log" 2>&1 &
TARGET_PID=$!

python3 "$ROOT/chromeos-host-relay.py" \
  --listen-port "$LISTEN_PORT" \
  --target-host 127.0.0.1 \
  --target-port "$TARGET_PORT" \
  >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!

for _ in {1..50}; do
  if [[ "$(curl -fsS --connect-timeout 1 --max-time 2 \
      "http://127.0.0.1:$LISTEN_PORT/probe.txt" 2>/dev/null || true)" == \
      "host-relay-positive-control" ]]; then
    break
  fi
  sleep 0.1
done

RESPONSE="$(curl -fsS --connect-timeout 1 --max-time 2 \
  "http://127.0.0.1:$LISTEN_PORT/probe.txt")"
[[ "$RESPONSE" == "host-relay-positive-control" ]] || {
  printf 'host relay positive control failed\n' >&2
  exit 2
}

STATUS="$(curl -sS --connect-timeout 1 --max-time 2 \
  --output "$WORK/missing.body" --write-out '%{http_code}' \
  "http://127.0.0.1:$LISTEN_PORT/definitely-missing")"
[[ "$STATUS" == "404" ]] || {
  printf 'host relay negative control returned HTTP %s instead of 404\n' "$STATUS" >&2
  exit 2
}

printf 'host relay positive control: pass\n'
printf 'host relay missing-path negative control: pass\n'
