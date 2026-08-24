# Changelog

## 2026-08-23

- Added browser-target commands to the existing remote-debugging-port transport.
- Added an isolated-profile `--remote-debugging-pipe` bridge for handlers such as
  PWA that Chrome refuses on the port transport.
- Isolated tab caches by transport endpoint to prevent cross-browser targeting.
- Added controlled probes for all 30 requested CDP domains. Chrome 151 exposes
  28 across the two direct transports; official Canary headless shell adds
  `HeadlessExperimental` for a 29-domain macOS union. `SmartCardEmulation` is
  excluded from macOS Chromium builds by its ChromeOS-only build dependencies.
- Added automatic blank-target creation for runtimes such as headless shell that
  start without a page target.
- Added a pinned, checksum-verified Linux ChromiumOS Full transport under Apple's
  `container` runtime. Its ChromeOS-compiled handler supplies `SmartCardEmulation`.
- Added a pinned Chrome for Testing headless-shell runner for
  `HeadlessExperimental`; the four-runtime matrix now passes all 30 requested
  domains with positive and fake-domain negative controls.
- Made `fcdp raw` return a nonzero status for CDP errors while preserving the JSON
  error response on stdout.
