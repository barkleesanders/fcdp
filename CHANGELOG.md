# Changelog

## 0.2.0

- Added multi-profile control. The extension can be loaded in several Chrome
  profiles at once; each instance persists a profile label (its Chrome
  directory name, stored under `fcdpProfileLabel` in chrome.storage.local)
  and reports it to the bridge on connect, along with a sample of its tabs.
  The bridge tracks one label per connection and rejects a duplicate claim
  from a second live connection. Merged tab lists now tag each tab with its
  owning profile's label.
- Added `fcdp profiles` (list connected profiles with labels, connection
  ids, and tab samples) and `fcdp label <conn> <Profile N>` (one-time label
  setup, persisted by the extension). The extension also answers
  `Meta.whoami` with its current label.
- Added `--profile` to `fcdp open` and `fcdp tabs` (aliases: `personal`/`p1`
  for Profile 1, `p2`, `p3`, or the directory name itself). On the bridge
  transport, `fcdp open` now defaults deterministically to Profile 1 instead
  of routing to whichever profile was last active; tabId commands still
  route to the owning profile automatically. `fcdp tabs` output gained a
  leading profile column. The direct-CDP and pipe transports reject
  `--profile` — they drive a single browser.
- Extension: version 0.2.0; added the `storage` permission, used only to
  persist the profile label.

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
- Made the ChromeOS transport remember the first free loopback port in 9333-9399,
  with a fail-closed `FCDP_CHROMEOS_PORT` override, so an unrelated local listener
  cannot block startup.
- Replaced Apple container's resetting published-port proxy with a managed,
  loopback-only host TCP relay to the container's private CDP endpoint. Added
  lifecycle, binding, PID-cleanup, positive, and negative regression controls.
