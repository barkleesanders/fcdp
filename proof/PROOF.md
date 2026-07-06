# fcdp — capability proof (scratch profile, Chrome 149.0.7827.201)

All runs on the throwaway profile `/tmp/fcdp-test-profile`, extension id
`oemofileiiefefpipkpamjbbmmdoibep`, bridge on `ws://127.0.0.1:9871` + `/tmp/fcdp.sock`.
Every capability below was **executed and observed** — not inferred.

## Extension load (Chrome 149)
- `--load-extension=…` : **BLOCKED / silently ignored** by Chrome 149, even with
  `--disable-features=DisableLoadExtensionCommandLineSwitch`. Verified by inspecting
  the profile's `Secure Preferences` — our extension never appeared in the settings
  list (only the 6 built-in component extensions).
- Working load path on the scratch profile: `Extensions.loadUnpacked` over the
  browser CDP endpoint (launched with `--remote-debugging-port=9445
  --enable-unsafe-extension-debugging --silent-debugger-extension-api`):
  `{"id":1,"result":{"id":"oemofileiiefefpipkpamjbbmmdoibep"}}`
- On load the MV3 service worker connected to the bridge:
  `07:19:00 extension connected` / `extension hello; attached tabs: []`

## Basic CDP (also possible via ccb)
- `fcdp tabs` → `1464405061  about:blank`
- `fcdp nav 1464405061 https://example.com/` → `Page.navigate` returned a frameId
- `fcdp js …` → `Example Domain | https://example.com/`

## The 4 advanced domains ccb CANNOT do — PROVEN
1. **Page.printToPDF** — `fcdp pdf` → `/tmp/fcdp-proof.pdf`
   `file` output: `PDF document, version 1.4, 1 pages`; 35448 bytes; magic `%PDF-1.4`.
   Copy saved: `proof/example-com.pdf`.
2. **Fetch interception** — `fcdp intercept 1464405061 7` →
   `PAUSED GET  https://example.com/` → `# intercepted & continued 1 request(s)`.
   Fetch.requestPaused fired and Fetch.continueRequest succeeded (page reloaded).
3. **Network throttling (Emulation)** — `fcdp throttle` →
   `Network.emulateNetworkConditions` returned `{}` (Slow-3G applied).
4. **Tracing** — `fcdp trace 1464405061 /tmp/fcdp-trace.json` →
   `wrote … (59568 trace events, complete=True)` (11.8 MB). Summary: `proof/trace-summary.json`.
