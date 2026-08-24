# fcdp unrestricted CDP state

- Current phase: implementation complete; ship verification in progress.
- Bead: HOME-am0re (in progress).
- Repository: `/Users/barkleesanders/tools/fcdp`, branch `master`.
- Pre-existing untracked file preserved: `fcdp.bak-20260801`.
- Reproduction: stock extension positive control passed; requested `Schema`
  negative control failed as restricted.
- Proven constraint: current official Chrome documentation forbids the requested
  domains through `chrome.debugger`; current Chrome also refuses direct debugging
  against its default data directory.
- Implemented: browser-target routing for port mode, persistent pipe bridge, cache
  isolation, restart-safe launcher, and controlled port/pipe/union harnesses.
- Verified ceiling: four-runtime union is 30/30. Chrome 151 port/pipe supplies 28,
  Chrome for Testing headless shell supplies `HeadlessExperimental`, and official
  Linux ChromiumOS Full snapshot 1684555 supplies `SmartCardEmulation`.
- The real Default-profile extension remains compatible and retains Chrome's
  published `chrome.debugger` security ceiling.
- Bead remains open until the ship gates and both-machine installation complete.
