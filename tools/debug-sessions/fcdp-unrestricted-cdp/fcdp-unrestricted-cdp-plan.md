# fcdp unrestricted CDP plan

## Phase 1 reconnaissance

Detected stack:

- Python 3.14 CLI: `fcdp:1`, `fcdp:16`.
- Node.js 26 bridge/gateway: `bridge.mjs:27-28`, `fcdp-cdp.mjs:40-43`.
- WebSocket dependency `ws` 8.21.0: `package-lock.json:15-21`.
- MV3 extension transport: `extension/background.js:51-73`.
- No configured test framework: `package.json:6-8` is a failing placeholder.

## Measured boundary

- Stock Chrome is 151.0.7922.170.
- The real-profile extension successfully executed the positive control
  `Page.getFrameTree` on tab 124895416, then rejected `Schema.getDomains` as
  `-32601 ... wasn't found` using the same command path.
- `chrome.debugger` officially exposes only 27 named domains. The requested 30
  are absent from that current allowlist:
  https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains
- Chromium's current protocol guidance says extension clients receive additional
  access controls that are not applied to other CDP clients:
  https://chromium.googlesource.com/chromium/src/+/master/third_party/blink/public/devtools_protocol/
- Chrome 136+ ignores remote-debugging port/pipe on the default data directory;
  official guidance requires a non-standard user-data-dir or Chrome for Testing:
  https://developer.chrome.com/blog/remote-debugging-port
- The local code matches the platform: the real-profile path always calls
  `chrome.debugger.sendCommand` (`extension/background.js:66-73`), while existing
  direct mode uses a separate remote-debugging endpoint (`fcdp:27-42`).
- Direct mode is incomplete for this request because `_sock()` only discovers
  page targets (`fcdp:123-135`), while Chromium documents that target type
  determines domain availability and browser-global methods belong to the browser
  target.

## Phase 2 success criteria

1. The extension/default-profile mode remains unchanged and explicitly reports
   its stock-Chrome ceiling.
2. `FCDP_CDP_URL=... fcdp raw --browser METHOD PARAMS` connects to the browser
   WebSocket advertised by `/json/version`.
3. Existing direct page-target commands continue to work.
4. An isolated, non-default, temporary Chrome harness probes one safe
   representative command for every requested domain.
5. A probe counts a domain as reachable when Chrome either succeeds or returns a
   domain-specific/parameter error; `method wasn't found`, `not allowed`, a proxy
   fabrication, timeout, or transport failure fails the harness.
6. The harness closes only its isolated Chrome and leaves the real Default-profile
   session untouched.

## Phase 3 strategic plan

1. Add a browser-target sentinel to `DirectConn` and obtain its WebSocket URL from
   the already-validated `/json/version` response.
2. Parse `raw --browser` before normal tab resolution; reject it clearly in
   extension mode because stock Chrome cannot grant that access.
3. Preserve all existing direct page-target routing and Meta operations.
4. Build `tools/repro/fcdp-unrestricted-domains/run.sh` around an isolated
   `mktemp -d` Chrome profile and an ephemeral local debugging port.
5. Add a probe runner with an explicit safe method/target map for all 30 domains;
   never call browser-close/crash, erase storage, load files, or grant permissions.
6. Use a positive control (`Page.getFrameTree`) and negative control (a fabricated
   domain) before interpreting domain results.
7. Verify syntax, legacy direct-page behavior, browser-target behavior, the 30
   domain matrix, and `npm audit --audit-level=moderate` with bounded commands.
8. Remove temporary Chrome/profile state and retain only reproducible fixtures and
   evidence.

## Hypothesis

Stock Chrome's real-profile extension can never satisfy the request. Completing
browser-target routing in fcdp's existing separate direct transport is the least
disruptive genuinely unrestricted architecture; it does not clone, copy, or touch
the Default profile.
