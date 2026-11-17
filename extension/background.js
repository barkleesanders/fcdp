// OOPIF-targetId-v3
// fcdp background service worker (MV3).
// Connects OUT to the local bridge daemon over ws://127.0.0.1:<PORT>, then for
// each request runs (most of) the Chrome DevTools Protocol via chrome.debugger —
// chrome.debugger.sendCommand accepts ANY CDP method, so this exposes the whole
// protocol incl. Fetch/Emulation/Tracing/Page.printToPDF. NOTE: chrome.debugger is
// security-restricted — a few browser-level/privileged CDP domains are withheld.
//
// Wire (bridge <-> extension), JSON text frames:
//   bridge -> ext:  {id, tabId, method, params}            CDP command on a tab
//                   {id, method:"Meta.listTabs"}           list tabs
//                   {id, tabId, method:"Meta.attach"}      attach debugger
//                   {id, tabId, method:"Meta.detach"}      detach debugger
//                   {id, method:"Meta.setProfileLabel", params:{label}}
//                                                          persist this profile's label
//                   {ping:true}                            keepalive (no reply)
//   ext -> bridge:  {id, result} | {id, error}             command reply
//                   {event:"Domain.method", tabId, params} CDP event (unsolicited)
//                   {hello:true, profileLabel, tabSample, attached}  on (re)connect
//
// Multi-profile identity (2026-11-15): the SAME extension is loaded in several
// Chrome profiles. Each profile's instance persists its Chrome directory name
// ("Profile 1", "Profile 2", ...) as a label in chrome.storage.local — set once
// at install time via Meta.setProfileLabel (see `fcdp label`) — and reports it
// in hello so the bridge can route profile-targeted commands deterministically.
// Unlabeled instances still work for tab-owned commands, but are never chosen
// as a default or profile target.

const PORT = 9871;
const URL = "ws://127.0.0.1:" + PORT;
const DBG_VERSION = "1.3";
const LABEL_KEY = "fcdpProfileLabel";

let ws = null;
let attached = new Set(); // tabIds we've attached to
let profileLabel = null; // this profile's label, once set/loaded

function log(...a) { console.log("[fcdp]", ...a); }

function send(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) { log("send failed", e && e.message); }
}

async function loadLabel() {
  try {
    const o = await chrome.storage.local.get(LABEL_KEY);
    if (o && o[LABEL_KEY]) profileLabel = o[LABEL_KEY];
  } catch (e) { /* storage unavailable: stay unlabeled */ }
  return profileLabel;
}

async function sendHello() {
  await loadLabel();
  let tabSample = [];
  try {
    const tabs = await new Promise((res) => chrome.tabs.query({}, res));
    tabSample = (tabs || []).slice(0, 5).map((t) => ({ url: t.url, title: t.title, windowId: t.windowId }));
  } catch (e) { /* sample is evidence for the operator, never load-bearing */ }
  send({ hello: true, profileLabel, tabSample, attached: [...attached] });
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(URL);
  } catch (e) {
    log("ctor failed", e && e.message);
    setTimeout(connect, 1500);
    return;
  }
  ws.onopen = () => {
    log("connected to bridge", URL);
    sendHello();
  };
  ws.onclose = () => { log("bridge closed; reconnecting"); ws = null; setTimeout(connect, 1000); };
  ws.onerror = () => { /* onclose will follow */ };
  ws.onmessage = (ev) => { handle(ev.data); };
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, DBG_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err && !/already attached/i.test(err.message || "")) {
        // real failure (e.g. tab gone) — surface it
        return resolve({ error: err.message });
      }
      attached.add(tabId);
      resolve({ ok: true });
    });
  }).then((r) => { if (r && r.error) throw new Error(r.error); });
}

function sendCommand(debuggee, method, params) {
  // debuggee: { tabId } or { targetId } (OOPIF / worker child targets)
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(result);
    });
  });
}

// A tab command can fail transiently after a renderer swap or debugger detach.
// Force one clean reattach and retry once; targetId commands have their own path.
const TRANSIENT_CDP = [
  "debugger is not attached",
  "detached while handling command",
  "cannot access a chrome-extension:// url of different extension",
];
async function sendCommandWithRetry(tabId, method, params) {
  try {
    return await sendCommand({ tabId }, method, params);
  } catch (e) {
    const msg = ((e && e.message) || String(e)).toLowerCase();
    if (!TRANSIENT_CDP.some((text) => msg.includes(text))) throw e;
    attached.delete(tabId);
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        chrome.runtime.lastError;
        resolve();
      });
    });
    await ensureAttached(tabId);
    return await sendCommand({ tabId }, method, params);
  }
}

// --- create-time navigation guard (2026-11-11) ---
// Chrome intermittently DROPS a background tab's create-time navigation:
// chrome.tabs.create returns a tab whose url stays "" indefinitely — every
// downstream wait then times out and Runtime.evaluate on the uncommitted tab
// surfaces as "Cannot access a chrome-extension:// URL of different
// extension" (the tab has no committed document of its own yet). This was
// a portal-watch failure mode seen in production. Guard every create: wait for
// the commit, heal first via chrome.tabs.update (tabs API — works with no
// renderer/debugger), then via CDP Page.navigate, and report the outcome
// on the create result as {committed, healed} so callers can see it.
function getTabAsync(tabId) {
  return new Promise((res) => chrome.tabs.get(tabId, (t) => { chrome.runtime.lastError; res(t || null); }));
}
async function waitCommit(tabId, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const t = await getTabAsync(tabId);
    if (!t) return null; // tab is gone
    if (t.url) return t; // committed (any non-empty url)
    if (Date.now() >= deadline) return t;
    await new Promise((r) => setTimeout(r, 500));
  }
}
async function guardCreateNavigation(tabId, url) {
  // HARD BUDGET: the bridge synthesizes "timeout waiting for extension
  // reply" at 60s, so the whole ladder must finish well inside that —
  // including a debugger attach that stalls on a stuck renderer (raced
  // at 8s below). Worst case here is ~38s of waits plus poll overhead.
  let healed = "none";
  let t = await waitCommit(tabId, 12000);
  if (!t) return { committed: false, healed, gone: true };
  if (t.url) return { committed: true, healed };
  healed = "tabs.update";
  await new Promise((res) => chrome.tabs.update(tabId, { url }, () => { chrome.runtime.lastError; res(); }));
  t = await waitCommit(tabId, 10000);
  if (t && t.url) return { committed: true, healed };
  healed = "page.navigate";
  try {
    await Promise.race([
      (async () => {
        await ensureAttached(tabId);
        await sendCommand({ tabId }, "Page.navigate", { url });
      })(),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  } catch (e) { /* fall through to the final check */ }
  t = await waitCommit(tabId, 8000);
  return { committed: !!(t && t.url), healed };
}

const attachedTargets = new Set(); // targetIds we've attached to (OOPIFs)

async function ensureAttachedTarget(targetId) {
  if (attachedTargets.has(targetId)) return;
  await new Promise((res, rej) => {
    chrome.debugger.attach({ targetId }, DBG_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // Already attached via Target.setAutoAttach (flatten) — treat as ok.
        const msg = err.message || "";
        if (/already attached|Another debugger|attached to the target/i.test(msg)) {
          attachedTargets.add(targetId);
          return res();
        }
        return rej(new Error(msg));
      }
      attachedTargets.add(targetId);
      res();
    });
  });
}

async function sendCommandOnTarget(targetId, method, params) {
  // Flatten auto-attach sessions are addressable by targetId WITHOUT a second
  // chrome.debugger.attach — attach often returns "No target with given id".
  // Try send first; only attach if send says we must.
  try {
    return await sendCommand({ targetId }, method, params);
  } catch (e1) {
    const m1 = (e1 && e1.message) || String(e1);
    if (!/No target|not attached|Detached|debugger/i.test(m1)) throw e1;
    try {
      await ensureAttachedTarget(targetId);
      return await sendCommand({ targetId }, method, params);
    } catch (e2) {
      // Last resort: chrome.debugger.getTargets() and match id
      const targets = await new Promise((res) => chrome.debugger.getTargets(res));
      const hit = (targets || []).find((t) => t.id === targetId);
      if (!hit) throw e2;
      await ensureAttachedTarget(targetId);
      return await sendCommand({ targetId }, method, params);
    }
  }
}

async function handle(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.ping) { return; } // keepalive from bridge; presence is enough
  const { id, tabId, targetId, method, params } = msg;
  if (id == null) return;

  try {
    if (method === "Meta.listTabs") {
      const tabs = await new Promise((res) => chrome.tabs.query({}, res));
      const slim = tabs.map((t) => ({
        tabId: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId
      }));
      return send({ id, result: { tabs: slim, attached: [...attached] } });
    }
    if (method === "Meta.setProfileLabel") {
      // One-time setup (via `fcdp label`): persist this profile's directory
      // name as its bridge identity. Stored per-profile in chrome.storage.local,
      // so the label survives restarts and is reported in every hello.
      const lbl = ((params || {}).label || "").trim();
      if (!lbl) throw new Error("Meta.setProfileLabel requires params.label");
      await chrome.storage.local.set({ [LABEL_KEY]: lbl });
      profileLabel = lbl;
      return send({ id, result: { labeled: true, profileLabel: lbl } });
    }
    if (method === "Meta.whoami") {
      await loadLabel();
      return send({ id, result: { profileLabel } });
    }
    if (method === "Meta.attach") {
      await ensureAttached(tabId);
      return send({ id, result: { attached: true, tabId } });
    }
    if (method === "Meta.detach") {
      await new Promise((res) => chrome.debugger.detach({ tabId }, () => { chrome.runtime.lastError; res(); }));
      attached.delete(tabId);
      return send({ id, result: { detached: true, tabId } });
    }
    if (method === "Meta.createTab") {
      const p = params || {};
      const url = p.url || "about:blank";
      const active = p.active !== false;
      const tab = await new Promise((res, rej) => {
        chrome.tabs.create({ url, active }, (created) => {
          const err = chrome.runtime.lastError;
          if (err) return rej(new Error(err.message));
          if (created && created.id != null) return res(created);
          // Chrome returns undefined when there is no window to attach a tab to.
          chrome.windows.create({ url, focused: active, type: "normal" }, (win) => {
            const werr = chrome.runtime.lastError;
            if (werr) return rej(new Error(werr.message));
            const createdTab = win && win.tabs && win.tabs[0];
            if (!createdTab || createdTab.id == null) {
              return rej(new Error("chrome_window_missing"));
            }
            res(createdTab);
          });
        });
      });
      let guard = null;
      if (p.url) {
        try { guard = await guardCreateNavigation(tab.id, url); }
        catch (e) { guard = { committed: false, healed: "error", error: (e && e.message) || String(e) }; }
      }
      const finalTab = guard ? await getTabAsync(tab.id) : tab;
      return send({ id, result: {
        tabId: tab.id,
        url: (finalTab && finalTab.url) || tab.url,
        windowId: tab.windowId,
        committed: guard ? guard.committed : undefined,
        healed: guard ? guard.healed : undefined,
      } });
    }
    if (method === "Meta.navigateTab") {
      // Debugger-free navigation via the tabs API — the heal for a tab
      // whose navigation never committed (Runtime.evaluate and CDP both
      // need a live target; chrome.tabs.update does not).
      const p = params || {};
      if (tabId == null || !p.url) throw new Error("Meta.navigateTab requires tabId and params.url");
      const updated = await new Promise((res, rej) => {
        chrome.tabs.update(tabId, { url: p.url }, (t) => {
          const err = chrome.runtime.lastError;
          if (err) return rej(new Error(err.message));
          res(t);
        });
      });
      return send({ id, result: { navigated: true, tabId, url: updated && updated.url } });
    }
    if (method === "Meta.closeTab") {
      await new Promise((res) => chrome.tabs.remove(tabId, () => { chrome.runtime.lastError; res(); }));
      attached.delete(tabId);
      return send({ id, result: { closed: true, tabId } });
    }
    // OOPIF / child target command (Shopify PCI, Stripe Elements, etc.)
    if (targetId) {
      const result = await sendCommandOnTarget(targetId, method, params);
      return send({ id, result });
    }
    // Default: a raw CDP command on a tab.
    if (tabId == null) throw new Error("tabId required for CDP command " + method);
    await ensureAttached(tabId);
    const result = await sendCommandWithRetry(tabId, method, params);
    return send({ id, result });
  } catch (e) {
    return send({ id, error: { message: (e && e.message) || String(e) } });
  }
}

// Forward ALL CDP events to the bridge so the CLI can observe them
// (Fetch.requestPaused, Tracing.dataCollected, Network.*, ...).
chrome.debugger.onEvent.addListener((source, method, params) => {
  send({ event: method, tabId: source.tabId, targetId: source.targetId, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) attached.delete(source.tabId);
  send({ event: "Meta.detached", tabId: source.tabId, params: { reason } });
});

// MV3 service workers die after ~30s idle. An alarm wakes the worker; on wake the
// top-level connect() re-runs (fresh SW instance) or we ping the live socket.
chrome.alarms.create("fcdp-keepalive", { periodInMinutes: 0.33 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "fcdp-keepalive") return;
  if (ws && ws.readyState === WebSocket.OPEN) send({ ping: true });
  else connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Connect immediately when the worker is (re)instantiated.
connect();
