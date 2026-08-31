# Security model

Read this before running fcdp on a profile you care about.

## What fcdp does to your browser

fcdp gives a local process the Chrome DevTools Protocol on your **real, logged-in
Chrome profile** — the one holding your Gmail, bank, and every other live session.
That is the point of the tool, and it is also the entire risk.

Chrome 136 deliberately closed the older route to this capability. Per
[Chrome's own announcement](https://developer.chrome.com/blog/remote-debugging-port)
(17 Mar 2025), `--remote-debugging-port` stopped being honored on the default data
directory because attackers were using CDP to extract cookies after App-Bound
Encryption shipped.

fcdp does not bypass that change — it uses a different, sanctioned API
(`chrome.debugger`, available to an extension you install yourself). But the
**capability it restores is the same one Chrome restricted.** Treat it accordingly.

## Current threat model — know these before you install

**There is no authentication on either transport.** As of this writing:

| Transport | Bound to | Auth |
|---|---|---|
| `ws://127.0.0.1:9871` (extension ↔ bridge) | loopback only | **none** |
| `/tmp/fcdp.sock` (CLI ↔ bridge) | filesystem, mode 755 | **none** |

Consequences:

- **Any process running as your user can drive your logged-in browser.** A malicious
  npm postinstall, a compromised dev dependency, or any script you run can connect to
  the socket and read authenticated pages, or use `Network`/`Storage` CDP domains
  against sites you are signed into.
- The socket path is **fixed and predictable** (`/tmp/fcdp.sock`), so discovery is
  trivial.
- A same-user process can already do a lot on macOS, so this is a **privilege
  amplification**, not a privilege escalation — but it converts "can read your files"
  into "can act as you on every site you are logged into," which is a meaningfully
  larger blast radius.

**Mitigations not yet implemented** (contributions welcome):
- A shared secret negotiated at bridge start and required on every CLI/extension frame
- `0600` socket mode in a per-user directory rather than `/tmp`
- An origin/allowlist check on the WebSocket handshake
- A per-command audit log

## What Chrome still withholds

`chrome.debugger` does **not** expose all of CDP. Chrome restricts it to roughly 27
domains — see the
[chrome.debugger reference](https://developer.chrome.com/docs/extensions/reference/api/debugger).
It also refuses to attach to `chrome://` pages. So "full CDP" is not accurate; "most
domains" is.

## Recommended use

- Run it on a profile whose logins you would be comfortable handing to any script you
  execute on that machine.
- Prefer a dedicated Chrome profile over your primary one where the task allows it.
- Do not run it on a shared or multi-user machine until socket auth lands.

## Reporting

Open an issue. There is no embargo process on this repo.
