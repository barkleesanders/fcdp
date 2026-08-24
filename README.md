# fcdp — the Chrome DevTools Protocol from the CLI (most domains)

A custom MV3 extension + local bridge daemon + Python CLI that exposes **most of the**
Chrome DevTools Protocol on a Chrome profile, via the extension `chrome.debugger`
permission. `chrome.debugger.sendCommand(target, method, params)` accepts **any** CDP
method, so this reaches the domains a curated tool like `ccb` cannot:
**Fetch interception, Emulation/throttling, Tracing, Page.printToPDF.**

## Components
- `extension/` — MV3 extension (`"debugger"` perm). Service worker connects OUT to the
  bridge over `ws://127.0.0.1:9871`, runs CDP via `chrome.debugger`, forwards events.
- `bridge.mjs` — Node daemon. WebSocket server (extension) + Unix socket `/tmp/fcdp.sock`
  (CLI), 4-byte-LE-length + JSON framing. Relays CLI ⇄ extension, fans events to subscribers.
- `fcdp` — Python 3 CLI.

## Run
```bash
node ~/tools/fcdp/bridge.mjs &          # or the launchd plist (see INTEGRATE.md)
# load the extension once (see INTEGRATE.md — `--load-extension` is BLOCKED on Chrome 149;
# use chrome://extensions → Developer mode → Load unpacked → ~/tools/fcdp/extension)
fcdp tabs                               # list tabs -> tabId
```

## Commands — ONE tool for everything (tabId optional; omit to use the last `fcdp open`ed tab)
```
# tabs / nav
fcdp tabs                       list tabs
fcdp open <url> [--bg]          open a NEW tab (cached active). Uses chrome.tabs after the
                                extension is reloaded; else window.open (userGesture) — no reload needed
fcdp nav  [tab] <url>           Page.navigate
fcdp close [tab]                close the tab
# read
fcdp read [tab]                 interactive-element outline (role/text/@x,y) + title/url
fcdp text [tab]                 page innerText
fcdp find [tab] "<css|text>"    matching elements -> tag,text,center x,y
fcdp shot [tab] [file.png]      screenshot (Page.captureScreenshot)
# interact  (real trusted input events via Input.* + Runtime.evaluate)
fcdp click [tab] <css|text|x,y> click element (by selector / visible text) or coords
fcdp type  [tab] "<text>"       type at focus (Input.insertText)
fcdp fill  [tab] <css> "<val>"  set an input's value (React-safe)
fcdp key   [tab] <Key>          Enter/Tab/Escape/ArrowDown/...
fcdp scroll [tab] <up|down|left|right> [n]
fcdp js   [tab] "<code>"        Runtime.evaluate
fcdp wait [tab] "<jsExpr>" [ms] poll until truthy
# advanced CDP commands (the 4 capabilities ccb cannot do)
fcdp pdf [tab] [out.pdf]        Page.printToPDF -> real PDF
fcdp intercept [tab] [secs]     Fetch.enable + reload; log+continue paused requests
fcdp throttle [tab]             Network.emulateNetworkConditions Slow-3G
fcdp trace [tab] [out.json]     Tracing.start/end -> trace file
fcdp raw [tab] <CDP.Method> ['<json>']     any page-target CDP call
FCDP_CDP_URL=http://127.0.0.1:9222 \
  fcdp raw --browser Browser.getVersion    browser-target call in direct mode
fcdp attach|detach [tab]
```
This is the everyday driver (open/read/find/click/type/fill/...) plus four advanced
capabilities on the real Default profile. Chrome's extension transport still has
the privileged-domain ceiling documented below.
`raw` is the escape hatch for everything else, e.g.:
```bash
fcdp raw <tabId> Emulation.setDeviceMetricsOverride '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}'
fcdp raw <tabId> Runtime.evaluate '{"expression":"navigator.userAgent","returnByValue":true}'
```

### Privileged and browser-level domains

Stock Chrome intentionally limits the domains available through the extension
`chrome.debugger` API. The real Default-profile transport therefore remains the
safe, logged-in mode with Chrome's published ceiling; an extension cannot remove
that browser security boundary.

For Browser, SystemInfo, Tethering, Extensions, and other privileged domains,
point fcdp at Chrome for Testing or Chrome launched with a separate
`--user-data-dir` and a remote-debugging port, then use `raw --browser` when the
method belongs to the browser target:

```bash
export FCDP_CDP_URL=http://127.0.0.1:9222
fcdp raw --browser Browser.getVersion
fcdp raw --browser SystemInfo.getInfo
fcdp raw <pageTargetId> Schema.getDomains
```

Chrome also grants some unsafe-operation handlers only over
`--remote-debugging-pipe`. fcdp provides a persistent isolated-profile pipe bridge:

```bash
./fcdp-pipe start
export FCDP_PIPE_SOCKET=/tmp/fcdp-pipe.sock
fcdp tabs
fcdp raw --browser PWA.getOsAppState \
  '{"manifestId":"https://example.invalid/manifest.json"}'
./fcdp-pipe stop
```

The pipe is deliberately local-only: its Unix socket is mode `0600` and its
profile is mode `0700`. A process running as your macOS user can fully control
that isolated browser, so do not expose or relay the socket to another account.

This profile starts empty at `~/.cache/fcdp-pipe-profile`; it never copies or
opens the real Default profile. `tools/repro/fcdp-unrestricted-domains/run.sh`
measures port mode and `run-pipe.sh` measures pipe mode against all requested
domains with positive and negative controls.

`run-all.sh` reports the cross-runtime union without treating method-not-found as
success. The verified 2026-08-23 matrix is **30/30**:

- Chrome 151 remote-debugging port and pipe cover 28 domains. Pipe adds PWA; port
  retains Tethering.
- Official Chrome for Testing 154.0.8020.2 headless shell adds
  `HeadlessExperimental`.
- Official Linux ChromiumOS Full snapshot 1684555 adds `SmartCardEmulation`, which
  Chromium omits from macOS builds.

Install and start the ChromeOS-only transport with Apple's `container` runtime:

```bash
./fcdp-chromeos install
./fcdp-chromeos start
export FCDP_CDP_URL="$(./fcdp-chromeos endpoint)"
fcdp tabs
fcdp raw <pageTargetId> SmartCardEmulation.enable
./fcdp-chromeos verify
./fcdp-chromeos stop
```

The launcher pins and SHA-256-verifies the official 1684555 artifact, mounts the
Chrome binary read-only, and uses a tmpfs profile. A managed host relay binds only
to `127.0.0.1` and forwards raw TCP to the container's private IPv4 address; this
avoids Apple container's published-port proxy while keeping CDP off the LAN. It
never opens or copies the real Default profile. The first install downloads about
304 MB and extracts about 907 MB.

The launcher remembers the first free loopback host port in the 9333-9399 range,
so another local app cannot block startup by owning 9333. Set
`FCDP_CHROMEOS_PORT=<port>` when a fixed port is required; startup fails closed if
that explicit port is occupied.

The complete matrix is:

```bash
npm test
# or: tools/repro/fcdp-unrestricted-domains/run-all.sh /tmp/fcdp-domain-matrix.json
```

The real Default Chrome extension remains the logged-in everyday transport. It is
wire-compatible with this CLI release, but Chrome's `chrome.debugger` security
boundary still applies there. The isolated port, pipe, headless-shell, and ChromeOS
transports add handlers that an extension cannot enable on the Default profile.

Direct and extension modes use different active-tab cache files, so switching
transports cannot silently target an id from the other browser. An explicit
`FCDP_TAB_CACHE` still overrides both for isolated jobs.

## Load caveat & integration
`--load-extension` is silently ignored on Chrome 149 — load once via **Load unpacked**.
Full runbook, launchd setup, and the per-tab single-debugger constraint: **`INTEGRATE.md`**.
Verified capability proof: **`proof/PROOF.md`**.

## fcdp vs ccb (short)
| | fcdp (this) | ccb (Claude's ext) |
|---|---|---|
| CDP surface | real-profile extension plus isolated runtimes for the verified 30-domain union | 17 curated tools |
| consent gate | none (ours) | per-action prompt |
| protocol stability | breaks only if Chrome changes `chrome.debugger` (rare) | rides Anthropic's private protocol (app updates can break) |
| coexistence | both use `chrome.debugger`; conflict per-tab; both show the debug infobar | ″ |
