# fcdp — full Chrome DevTools Protocol from the CLI

A custom MV3 extension + local bridge daemon + Python CLI that exposes the **entire**
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
# full-CDP power (the 4 domains ccb CANNOT do)
fcdp pdf [tab] [out.pdf]        Page.printToPDF -> real PDF
fcdp intercept [tab] [secs]     Fetch.enable + reload; log+continue paused requests
fcdp throttle [tab]             Network.emulateNetworkConditions Slow-3G
fcdp trace [tab] [out.json]     Tracing.start/end -> trace file
fcdp raw [tab] <CDP.Method> ['<json>']     any CDP call — the escape hatch
fcdp attach|detach [tab]
```
This is the everyday driver (open/read/find/click/type/fill/...) **and** the full-CDP power
tool, in one CLI, on your REAL Default profile — it does everything ccb does plus the 4
advanced domains. All verified live 2026-07-06.
`raw` is the escape hatch for everything else, e.g.:
```bash
fcdp raw <tabId> Emulation.setDeviceMetricsOverride '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}'
fcdp raw <tabId> Runtime.evaluate '{"expression":"navigator.userAgent","returnByValue":true}'
```

## Load caveat & integration
`--load-extension` is silently ignored on Chrome 149 — load once via **Load unpacked**.
Full runbook, launchd setup, and the per-tab single-debugger constraint: **`INTEGRATE.md`**.
Verified capability proof: **`proof/PROOF.md`**.

## fcdp vs ccb (short)
| | fcdp (this) | ccb (Claude's ext) |
|---|---|---|
| CDP surface | **full protocol** (incl. Fetch/Emulation/Tracing/printToPDF) | 17 curated tools |
| consent gate | none (ours) | per-action prompt |
| protocol stability | breaks only if Chrome changes `chrome.debugger` (rare) | rides Anthropic's private protocol (app updates can break) |
| coexistence | both use `chrome.debugger`; conflict per-tab; both show the debug infobar | ″ |
