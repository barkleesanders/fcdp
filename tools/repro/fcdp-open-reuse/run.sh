#!/usr/bin/env bash
# Durable check for `fcdp open --reuse`.
#
# `open` has always created a NEW tab, so an agent that opens the same page repeatedly
# accumulates duplicates monotonically. --reuse navigates a matching tab instead.
#
# Three arms, because a test that only proves the happy path cannot detect the two ways
# this feature breaks:
#   1 NEGATIVE CONTROL  bare `open` twice  -> +2 tabs   (default behavior MUST NOT change)
#   2 POSITIVE          `open --reuse` x2  -> +1 tab    (second call reuses)
#   3 STALE-RENDER      reuse after the file changes -> new bytes, same tabId
#     Arm 3 is the whole reason reuse issues Page.navigate rather than merely activating:
#     activating a stale tab shows PRE-EDIT content and produces a false verification.
#
# Exit: 0 pass, 1 fail, 77 skipped/unmeasured (no bridge — NOT a pass).
set -uo pipefail

FCDP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/fcdp"
# Unique per run: if the operator already has a plain example.com tab open, arm 2's first
# --reuse call would MATCH it, create nothing, and the delta would read 0 instead of 1 —
# a real pass looking like a failure. The query string makes the arms self-contained.
URL="https://example.com/?fcdp-reuse-probe=$$"
TMP="$(mktemp -d)"
OPENED=()
FAILED=0

# NEVER pass an empty tabId to `fcdp close`: with no id it falls back to the CACHED tab
# and closes an unrelated one. (Cost a polluted run while building this check.)
kill_tab() { [ -n "${1:-}" ] && "$FCDP" close "$1" >/dev/null 2>&1; return 0; }

cleanup() {
  for t in "${OPENED[@]:-}"; do kill_tab "$t"; done
  rm -rf "$TMP"
}
trap cleanup EXIT

count()  { "$FCDP" tabs 2>/dev/null | wc -l | tr -d ' '; }
# `fcdp open` prints "tabId N (...)" on create and "reused tab N (...)" on reuse.
# grep -oE, NOT sed with \| alternation: BSD sed has no BRE alternation, so that form
# silently yields an EMPTY id on macOS and every id comparison then passes vacuously.
tabid()  { grep -oE '[0-9]+' <<<"$1" | head -1; }
ok()     { echo "  ok   $*"; }
bad()    { echo "  FAIL $*"; FAILED=1; }
# A blank id means the parser broke; without this every id assertion compares "" to ""
# and reports green. Fail loudly instead.
need_id() { [ -n "${1:-}" ] && ok "$2 parsed id $1" || bad "$2 produced NO tab id (parser broken)"; }

[ -x "$FCDP" ] || { echo "SKIP: no fcdp at $FCDP"; exit 77; }
if ! "$FCDP" tabs >/dev/null 2>&1; then
  echo "SKIP: bridge/CDP unreachable — result is UNMEASURED, not a pass"; exit 77
fi

echo "== arm 1: NEGATIVE CONTROL — bare open must still always create =="
BASE=$(count)
O1=$("$FCDP" open "$URL" 2>&1); T1=$(tabid "$O1")
# Let tab #1 COMMIT its url before opening #2. chrome.tabs reports a freshly-created tab
# with an empty/pending url until the navigation commits, so a back-to-back second open
# cannot match it on url no matter what the code does. Without this settle the arm passes
# even when reuse is forced on for every open — i.e. it silently stops being a control.
# (Caught by mutating `reuse = True` and watching this arm stay green.)
sleep 2
O2=$("$FCDP" open "$URL" 2>&1); T2=$(tabid "$O2")
OPENED+=("$T1" "$T2")
AFTER=$(count); DELTA=$((AFTER - BASE))
echo "  tabs $BASE -> $AFTER (delta $DELTA), ids $T1 $T2"
need_id "$T1" "bare open #1"; need_id "$T2" "bare open #2"
[ "$DELTA" -eq 2 ] && ok "bare open x2 created 2 tabs" \
                   || bad "bare open x2 delta=$DELTA, expected 2 (default behavior changed!)"
[ -n "$T1" ] && [ -n "$T2" ] && [ "$T1" != "$T2" ] \
  && ok "distinct tab ids" || bad "expected two distinct new tab ids"
grep -q '^reused' <<<"$O2" && bad "bare open reported reuse — --reuse leaked into the default" \
                           || ok "bare open never reports reuse"

kill_tab "$T1"; kill_tab "$T2"
OPENED=()
sleep 0.5

echo "== arm 2: POSITIVE — --reuse must not duplicate =="
BASE=$(count)
R1=$("$FCDP" open --reuse "$URL" 2>&1); U1=$(tabid "$R1")
R2=$("$FCDP" open --reuse "$URL" 2>&1); U2=$(tabid "$R2")
OPENED+=("$U1")
AFTER=$(count); DELTA=$((AFTER - BASE))
echo "  tabs $BASE -> $AFTER (delta $DELTA), ids $U1 $U2"
echo "  2nd call said: $R2"
need_id "$U1" "reuse #1"; need_id "$U2" "reuse #2"
[ "$DELTA" -eq 1 ] && ok "open --reuse x2 created only 1 tab" \
                   || bad "open --reuse x2 delta=$DELTA, expected 1"
[ "$U1" = "$U2" ] && ok "second call returned the same tabId" \
                  || bad "second call returned $U2, expected $U1"
grep -q '^reused tab' <<<"$R2" && ok "second call announced reuse" \
                               || bad "second call did not print a reuse line"
[ "$(cat "${FCDP_TAB_CACHE:-$HOME/.cache/fcdp-tab}" 2>/dev/null)" = "$U2" ] \
  && ok "tab cache updated to the reused tab" || bad "tab cache not updated on reuse"

kill_tab "$U1"; OPENED=()
sleep 0.5

echo "== arm 3: STALE-RENDER CONTROL — reuse must re-navigate, not just activate =="
F="$TMP/reuse-probe.html"
printf '<!doctype html><meta charset="utf-8"><title>probe</title><body>MARKER_V1</body>' > "$F"
S1=$("$FCDP" open --reuse "file://$F" 2>&1); P=$(tabid "$S1"); OPENED+=("$P")
sleep 1.2
BODY1=$("$FCDP" text "$P" 2>/dev/null | tr -d '[:space:]')
printf '<!doctype html><meta charset="utf-8"><title>probe</title><body>MARKER_V2</body>' > "$F"
BASE=$(count)
S2=$("$FCDP" open --reuse "file://$F" 2>&1); P2=$(tabid "$S2")
sleep 1.2
BODY2=$("$FCDP" text "$P2" 2>/dev/null | tr -d '[:space:]')
AFTER=$(count); DELTA=$((AFTER - BASE))
echo "  before='$BODY1' after='$BODY2' tab $P -> $P2 (delta $DELTA)"
need_id "$P" "file:// open"; need_id "$P2" "file:// reuse"
[ "$BODY1" = "MARKER_V1" ] && ok "initial render is V1" || bad "initial render was '$BODY1'"
[ "$BODY2" = "MARKER_V2" ] && ok "reused tab shows POST-EDIT bytes (re-navigated)" \
                           || bad "reused tab shows '$BODY2' — STALE content, the bug reproduced"
[ "$P" = "$P2" ] && ok "same tab reused" || bad "tab changed $P -> $P2"
[ "$DELTA" -eq 0 ] && ok "no tab created on reuse" || bad "reuse created $DELTA tab(s)"

echo
[ "$FAILED" -eq 0 ] && { echo "PASS"; exit 0; } || { echo "FAIL"; exit 1; }
