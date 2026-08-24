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
//                   {ping:true}                            keepalive (no reply)
//   ext -> bridge:  {id, result} | {id, error}             command reply
//                   {event:"Domain.method", tabId, params} CDP event (unsolicited)
//                   {hello:true, ...}                       on (re)connect

const PORT = 9871;
const URL = "ws://127.0.0.1:" + PORT;
const DBG_VERSION = "1.3";

let ws = null;
let attached = new Set(); // tabIds we've attached to

function log(...a) { console.log("[fcdp]", ...a); }

function send(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) { log("send failed", e && e.message); }
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
    send({ hello: true, attached: [...attached] });
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

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(result);
    });
  });
}

// A CDP command can fail transiently when the debugger silently lost the tab (renderer
// swap, a brief chrome-extension:// URL, another debugger extension touching the tab).
// The cure is always the same: force a clean detach+reattach and retry ONCE. This is
// what Claude-for-Chrome's own CDP driver does inside every sendCommand (RE'd 2026-07-12,
// ext fcoeoabgfenejglbffodgkkbkcdhcgfn) — it turns the manual `fcdp detach <tab>` dance
// into something the bridge handles itself.
const TRANSIENT_CDP = [
  "debugger is not attached",
  "detached while handling command",
  "cannot access a chrome-extension:// url of different extension",
];
async function sendCommandWithRetry(tabId, method, params) {
  try {
    return await sendCommand(tabId, method, params);
  } catch (e) {
    const msg = ((e && e.message) || String(e)).toLowerCase();
    if (!TRANSIENT_CDP.some((s) => msg.includes(s))) throw e;
    // clean-slate reattach, then retry exactly once
    attached.delete(tabId);
    await new Promise((res) => chrome.debugger.detach({ tabId }, () => { chrome.runtime.lastError; res(); }));
    await ensureAttached(tabId);
    return await sendCommand(tabId, method, params);
  }
}

async function handle(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.ping) { return; } // keepalive from bridge; presence is enough
  const { id, tabId, method, params } = msg;
  if (id == null) return;

  try {
    if (method === "Meta.listTabs") {
      const tabs = await new Promise((res) => chrome.tabs.query({}, res));
      const slim = tabs.map((t) => ({
        tabId: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId
      }));
      return send({ id, result: { tabs: slim, attached: [...attached] } });
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
      const tab = await new Promise((res) => chrome.tabs.create({ url: p.url || "about:blank", active: p.active !== false }, res));
      return send({ id, result: { tabId: tab.id, url: tab.url, windowId: tab.windowId } });
    }
    if (method === "Meta.closeTab") {
      await new Promise((res) => chrome.tabs.remove(tabId, () => { chrome.runtime.lastError; res(); }));
      attached.delete(tabId);
      return send({ id, result: { closed: true, tabId } });
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
  send({ event: method, tabId: source.tabId, params });
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
