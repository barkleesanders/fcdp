# fcdp — integration into the real Default Chrome profile

**Status:** built + fully verified on the scratch profile `/tmp/fcdp-test-profile`
(see `proof/PROOF.md`). This file is the runbook for the disruptive step of loading
fcdp into the user's REAL Default profile. **The main session performs this with the
user aware — the subagent does NOT.**

---

## ⚠️ Critical finding: `--load-extension` is BLOCKED on Chrome 149

The task asked to add `--load-extension=$HOME/tools/fcdp/extension` to
`ccb-up.sh`'s launch line. **Do not — it does not work on this Chrome.**

Empirically verified (2026-07-06, Chrome 149.0.7827.201): launching with
`--load-extension=…` — even together with
`--disable-features=DisableLoadExtensionCommandLineSwitch` — leaves the extension
**unloaded**; it never appears in the profile's `Secure Preferences`. Chrome has
removed the command-line unpacked-load path for normal launches.

There is also **no CDP fallback on the Default profile**: `Extensions.loadUnpacked`
(the method that worked on the scratch profile) requires a `--remote-debugging-port`,
and Chrome 136+ refuses that switch on the real Default profile. That refusal is the
whole reason the `:9222` clone exists — so the CDP load path is unavailable here too.

### ✅ The one working path: manual "Load unpacked" (one time, then persistent)

1. Make sure the bridge is running (see launchd section below) so the service worker
   has something to connect to.
2. In the real Chrome, open `chrome://extensions`.
3. Toggle **Developer mode** ON (top-right).
4. Click **Load unpacked** → select `~/tools/fcdp/extension` → Open.
5. The extension loads immediately; its service worker connects to the bridge
   (`bridge.log` prints `extension connected`). Verify with `fcdp tabs`.

This is a **one-time** manual action. Chrome records the unpacked extension in the
profile's `Secure Preferences` and reloads it from the folder on every subsequent
launch — as long as `~/tools/fcdp/extension` still exists. No `ccb-up.sh` edit is
needed, and no Default-Chrome relaunch is required to load it.

Cosmetic caveats after loading:
- Chrome shows a **"Disable developer-mode extensions"** bubble on each startup
  (dismiss it; it does not unload the extension).
- While fcdp's debugger is attached to any tab, Chrome shows the yellow
  **"fcdp — Full CDP Bridge started debugging this browser"** infobar (same infobar
  ccb already triggers).

### If you still want it in `ccb-up.sh` (informational only)

Because `--load-extension` is inert on Chrome 149, adding it to `ccb-up.sh`'s launch
line is harmless but **has no effect** — the extension will not load from it. The
manual step above is still required. **Do NOT relaunch the Default Chrome expecting
the flag to work**; a relaunch of the Default profile also **kills all current ccb
tabs / tab groups** (the live Claude-for-Chrome session), so there is a real cost and
no benefit. Leave `ccb-up.sh` unedited and use the manual load.

---

## Hard constraint: one debugger client PER TAB

Both ccb (Claude's extension) and fcdp use `chrome.debugger`. Chrome allows **only one
debugger client attached to a given tab at a time.** Consequences:

- fcdp and ccb **coexist fine on DIFFERENT tabs** — e.g. ccb drives tab A while fcdp
  traces tab B.
- If ccb (or DevTools, or a `:9222` session) is already attached to tab X,
  `fcdp <cmd> X` fails with *"Another debugger is already attached"* — and vice-versa.
- fcdp auto-attaches on first command and holds the attachment until you
  `fcdp detach <tabId>` (or the tab closes). Detach when handing a tab back to ccb.
- Both attached anywhere ⇒ the yellow "…started debugging this browser" infobar shows.

Practical rule: **give fcdp its own tab.** Open a fresh tab for CDP-heavy work
(`fcdp` → drive that tabId), keep ccb on the tabs it already owns.

---

## Keeping the bridge alive (launchd)

`com.barklee.fcdp-bridge.plist` (in this folder) runs `bridge.mjs` with `RunAtLoad`
+ `KeepAlive`. **The subagent did NOT load it — the main session decides.** To load:

```bash
cp ~/tools/fcdp/com.barklee.fcdp-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.barklee.fcdp-bridge.plist
launchctl list | grep fcdp        # confirm running
tail -f ~/tools/fcdp/bridge.log   # watch the extension connect
```

To stop / unload:
```bash
launchctl unload ~/Library/LaunchAgents/com.barklee.fcdp-bridge.plist
```

The bridge listens on `ws://127.0.0.1:9871` (extension) and `/tmp/fcdp.sock` (CLI).
Port 9871 was chosen because 9333 was already taken by `hoptodesk` on this machine;
change `PORT` in BOTH `bridge.mjs` and `extension/background.js` if it ever conflicts
(then reload the extension).

---

## Can fcdp let ccb "drop the :9222 fallback"?

Yes for capability — the 4 advanced domains that forced the `:9222` clone
(Fetch interception/modification, Emulation/throttling, Tracing, Page.printToPDF)
are all verified working through fcdp on a real-style profile (`proof/PROOF.md`).
But note the load caveat above: fcdp itself must be loaded once via "Load unpacked",
and it cannot debug a tab ccb is already attached to. So fcdp *replaces the :9222
clone's capability need* on the Default profile, at the cost of a one-time manual
extension load and the per-tab single-debugger rule.
