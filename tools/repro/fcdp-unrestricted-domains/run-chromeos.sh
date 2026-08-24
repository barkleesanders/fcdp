#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RESULT="${1:-${TMPDIR%/}/fcdp-chromeos-matrix.json}"

"$ROOT/fcdp-chromeos" start >/dev/null
FCDP_CDP_URL="$("$ROOT/fcdp-chromeos" endpoint)"
export FCDP_CDP_URL
export FCDP_TAB_CACHE="${TMPDIR%/}/fcdp-chromeos-tab-cache"
export FCDP_BIN="$ROOT/fcdp"
python3 "$ROOT/tools/repro/fcdp-unrestricted-domains/probe.py" | tee "$RESULT"
