# Changelog

## 0.2.2 — 2026-11-16

Sync of the production code back into the public repo (the live install
had moved ahead of the 0.2.0 port). Extension version bumped to 0.2.2.

- Extension: OOPIF / child-target routing. Bridge requests may now carry
  a `targetId` (Stripe Elements / Shopify PCI iframes, workers); the
  extension sends on the child target directly, attaches on demand, and
  falls back to `chrome.debugger.getTargets()`. CDP events forwarded to
  the bridge now include `targetId`.
- Extension: create-time navigation guard. Chrome intermittently drops a
  background tab's create-time navigation, leaving an uncommitted tab
  that fails downstream with a misleading chrome-extension:// error.
  `Meta.createTab` now waits for the commit, heals via `chrome.tabs.update`
  and then CDP `Page.navigate` (worst case ~38s, inside the bridge's 60s
  reply timeout), and reports `{committed, healed}` on the result; the
  CLI surfaces a healed or uncommitted create in its output. Tab creation
  is error-checked, with a `chrome.windows.create` fallback when no
  window exists.
- Extension: new `Meta.navigateTab` op — debugger-free navigation via
  `chrome.tabs.update`, the heal for a tab whose navigation never
  committed.
- Bridge: socket/startup hardening. The WebSocket port and Unix socket
  path are configurable (`FCDP_BRIDGE_PORT` / `FCDP_BRIDGE_SOCK`). A
  failed WS bind exits without touching the existing socket; the bridge
  wins the TCP bind before touching the Unix pathname and only unlinks a
  proven-stale socket (never a live bridge's socket or a regular file);
  shutdown removes the socket only if it still owns it (inode-checked).
  Child-target requests (targetId, no tabId) route to the default
  profile.
- CLI: new `snap` command — compact a11y-style `@N` refs for agents,
  persisted per tab so `click @N` / `fill @N` can act on the stamped
  nodes (DOM click with coordinate fallback). New `viewport` command
  (`Emulation.setDeviceMetricsOverride`, default 1440x900) and `tabsnav`
  (navigate via `Meta.navigateTab`). `fill` no longer echoes filled
  values (password-safe). The :9222 autodetect fallback at startup is
  removed: with no bridge socket and no explicit transport pinned, the
  CLI refuses to attach to a debug-port browser and fails loud instead
  of silently driving the wrong Chrome.

## 0.2.1

- Docs: warn against aliasing profile directories (symlinking `Default`
  to another profile's directory). Chrome registers every directory in
  the user-data folder as a separate profile at startup, so an alias
  dual-mounts one profile's data under two logical profiles — duplicate
  bridge label claims, a phantom profile picker, scrambled sign-in
  state. Pin the real directory name instead. Learned in production,
  2026-11-15.

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
