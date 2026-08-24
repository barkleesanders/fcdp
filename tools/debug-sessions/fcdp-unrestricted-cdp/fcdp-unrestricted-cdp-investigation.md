# fcdp unrestricted CDP investigation

## Root cause

The real-profile path is not an unrestricted CDP transport. It calls
`chrome.debugger.sendCommand` (`extension/background.js:66-73`), and Chrome's
published extension API allows only 27 domains. The existing raw direct transport
connected only to page-target WebSockets (`fcdp:138-155` after this change), so it
also could not reach browser-only handlers. Finally, Chrome exposes PWA only when
the client is connected through an unsafe-operations pipe; its port transport
returns method-not-found.

## Fix

- `fcdp` now selects extension, remote-debugging-port, or pipe bridge explicitly.
- `raw --browser` reaches the browser target in both direct transports.
- Direct tab caches are endpoint-specific; the historic extension cache is
  unchanged.
- `fcdp-pipe.mjs` owns a separate profile and mediates Chrome's null-delimited
  pipe protocol over a mode-0600 Unix socket.
- `fcdp-pipe` provides PID-validated start/stop/status and stale-socket recovery.
- `fcdp-chromeos` runs a pinned, checksum-verified official Linux ChromiumOS Full
  snapshot in an isolated, loopback-only Apple container.
- The repro harness tests four runtimes and reports their honest union.

## Verification

- Chrome: 151.0.7922.170; CDP: 1.3.
- Port matrix: 27/30.
- Pipe matrix: 27/30.
- Port/pipe union: 28/30.
- Chrome for Testing headless shell adds `HeadlessExperimental`.
- Linux ChromiumOS Full snapshot 1684555 adds `SmartCardEmulation`.
- Four-runtime union: 30/30.
- PWA: method dispatch proven only through pipe by the expected unknown-manifest
  protocol error.
- Tethering: method dispatch proven only through port by an invalid-parameters
  protocol error.
- Runtime-specific gaps remain visible in the matrix; the verified union has none.
- Positive control: `Page.getFrameTree` succeeds.
- Negative control: fabricated `DefinitelyNotACdpDomain.nope` returns
  method-not-found.
- `npm audit --audit-level=moderate`: zero vulnerabilities.
- Biome, Node syntax, Python AST, and Bash syntax checks pass.
- Stale Unix socket restart tested; PWA remained reachable; daemon stopped cleanly.

## Ground-truth result

The requested 30/30 result is not achievable inside installed Google Chrome 151
alone. It is achieved by documented isolated transports without modifying or
copying the real Default profile, and without treating method-not-found as success.
