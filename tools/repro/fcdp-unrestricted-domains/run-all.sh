#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR%/}/fcdp-domain-matrix.XXXXXX")"
RESULT="${1:-${TMPDIR%/}/fcdp-domain-matrix.json}"

cleanup() {
  case "$WORK" in
    "${TMPDIR%/}"/fcdp-domain-matrix.*) rm -rf -- "$WORK" ;;
    *) printf 'refusing to remove unexpected work path: %s\n' "$WORK" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

"$ROOT/tools/repro/fcdp-unrestricted-domains/run.sh" "$WORK/port.json" >"$WORK/port.log"
PORT_EXIT=$?
"$ROOT/tools/repro/fcdp-unrestricted-domains/run-pipe.sh" "$WORK/pipe.json" >"$WORK/pipe.log"
PIPE_EXIT=$?
"$ROOT/tools/repro/fcdp-unrestricted-domains/run-headless-shell.sh" \
  "$WORK/headless-shell.json" >"$WORK/headless-shell.log"
HEADLESS_EXIT=$?
"$ROOT/tools/repro/fcdp-unrestricted-domains/run-chromeos.sh" \
  "$WORK/chromeos.json" >"$WORK/chromeos.log"
CHROMEOS_EXIT=$?

if [[ ! -s "$WORK/port.json" || ! -s "$WORK/pipe.json" || \
      ! -s "$WORK/headless-shell.json" || ! -s "$WORK/chromeos.json" ]]; then
  printf 'a transport did not produce a matrix (port=%s pipe=%s headless=%s chromeos=%s)\n' \
    "$PORT_EXIT" "$PIPE_EXIT" "$HEADLESS_EXIT" "$CHROMEOS_EXIT" >&2
  sed -n '1,80p' "$WORK/port.log" >&2
  sed -n '1,80p' "$WORK/pipe.log" >&2
  sed -n '1,80p' "$WORK/headless-shell.log" >&2
  sed -n '1,80p' "$WORK/chromeos.log" >&2
  exit 2
fi

python3 "$ROOT/tools/repro/fcdp-unrestricted-domains/merge.py" \
  "port=$WORK/port.json" \
  "pipe=$WORK/pipe.json" \
  "headless-shell=$WORK/headless-shell.json" \
  "chromeos=$WORK/chromeos.json" | tee "$RESULT"
