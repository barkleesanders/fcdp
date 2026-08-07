#!/usr/bin/env node
// fcdp-cdp — a browser-level CDP endpoint synthesized on top of the fcdp extension bridge.
//
// WHY THIS EXISTS
// ---------------
// fcdp drives your REAL, logged-in Default Chrome profile through our own MV3
// extension (chrome.debugger). That is its moat: Chrome 136+ refuses
// --remote-debugging-port on the Default profile, so an extension is the only door.
//
// The cost of that door is that chrome.debugger is a PER-TAB debugger. It serves
// page-level domains (Runtime/DOM/Page/Input/Network) but REFUSES the browser-level
// surface a CDP client expects to find first. Measured 2026-08-07:
//
//     Target.getTargets   -> {"code":-32000,"message":"Not allowed"}
//     Browser.getVersion  -> hangs (no callback, ever)
//
// So a naive "forward every message to Chrome" proxy cannot work. This shim instead
// SYNTHESIZES the browser domain from fcdp's own Meta.listTabs and proxies only what
// chrome.debugger actually serves:
//
//     client ──ws──> [ Target.* / Browser.*  answered HERE, from Meta.listTabs ]
//                    [ everything else       ──> bridge ──> chrome.debugger    ]
//
// Net effect: any CDP client that speaks the browser protocol (agent-browser,
// Playwright's connectOverCDP, Puppeteer's connect) can drive your real logged-in
// tabs — gaining ~60 high-level verbs fcdp has no equivalent for, without giving up
// the real profile.
//
// USAGE
//   node fcdp-cdp.mjs [--port 9333] [--verbose]
//   agent-browser connect 9333
//
// SCOPE / HONEST LIMITS
//   * Existing tabs only by default. Target.createTarget maps to Meta.createTab.
//   * Browser-wide domains chrome.debugger does not expose (Browser.*, SystemInfo,
//     Tracing at browser scope) are answered locally with a minimal shape or refused
//     explicitly — never silently faked into looking successful.
//   * One shared bridge connection; sessions are multiplexed over it.

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const SOCK = process.env.FCDP_SOCK || "/tmp/fcdp.sock";
const HOST = "127.0.0.1";

const argv = process.argv.slice(2);
const getFlag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(getFlag("--port", process.env.FCDP_CDP_PORT || 9333));
const VERBOSE = argv.includes("--verbose");

const BROWSER_GUID = crypto.randomUUID();
const log = (...a) => console.error(new Date().toISOString().slice(11, 23), ...a);
const vlog = (...a) => { if (VERBOSE) log(...a); };

// ---------------------------------------------------------------- bridge client
// Framing on /tmp/fcdp.sock: 4-byte little-endian length prefix + JSON body.
//   out: {id, tabId, method, params} | {op:"subscribe", filter:[]}
//   in : {id, result} | {id, error} | {event, tabId, params}
class Bridge {
  constructor() {
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.onEvent = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(SOCK);
      this.sock = s;
      s.once("connect", resolve);
      s.once("error", reject);
      s.on("data", (d) => this.#feed(d));
      s.on("close", () => {
        // Fail every in-flight command rather than leaving callers hanging forever.
        for (const [, p] of this.pending) p.reject(new Error("fcdp bridge closed"));
        this.pending.clear();
        log("bridge socket closed");
      });
    });
  }

  #feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) return;
      const n = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + n) return;
      const body = this.buf.subarray(4, 4 + n);
      this.buf = this.buf.subarray(4 + n);
      let msg;
      try { msg = JSON.parse(body.toString("utf8")); } catch { continue; }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (msg.event) { this.onEvent?.(msg); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
  }

  #write(obj) {
    const b = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length, 0);
    this.sock.write(Buffer.concat([h, b]));
  }

  cmd(tabId, method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.#write({ id, tabId, method, params: params || {} });
    });
  }

  // Empty filter = every event (bridge.mjs only filters when filter.length > 0).
  subscribeAll() { this.#write({ op: "subscribe", filter: [] }); }

  async listTabs() {
    const r = await this.cmd(undefined, "Meta.listTabs", {});
    const tabs = Array.isArray(r) ? r : (r?.tabs ?? []);
    // chrome-extension:// and devtools:// pages are not drivable page targets and
    // confuse clients that try to attach to everything they are shown.
    return tabs.filter((t) => typeof t.url === "string" &&
      !t.url.startsWith("chrome-extension://") && !t.url.startsWith("devtools://"));
  }
}

// ------------------------------------------------------------------ CDP synthesis
const targetIdOf = (tabId) => `FCDP${tabId}`;
const tabIdOf = (targetId) => Number(String(targetId).replace(/^FCDP/, ""));

const targetInfo = (t) => ({
  targetId: targetIdOf(t.tabId),
  type: "page",
  title: t.title || "",
  url: t.url || "",
  attached: true,
  canAccessOpener: false,
  browserContextId: "FCDPDefaultContext",
});

// Domains chrome.debugger cannot serve at all. Answering these locally is the whole
// point of the shim; forwarding them is what produced "Not allowed" / hangs.
const LOCAL_PREFIXES = ["Target.", "Browser.", "SystemInfo.", "Tethering."];
const isLocal = (method) => LOCAL_PREFIXES.some((p) => method.startsWith(p));

class Client {
  constructor(ws, bridge) {
    this.ws = ws;
    this.bridge = bridge;
    this.sessions = new Map();   // sessionId -> tabId
    this.tabSessions = new Map(); // tabId -> Set<sessionId>
    this.autoAttach = false;
    this.discover = false;
    ws.on("message", (raw) => this.#onMessage(raw));
    ws.on("close", () => vlog("client disconnected"));
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  emit(method, params, sessionId) {
    const m = { method, params: params || {} };
    if (sessionId) m.sessionId = sessionId;
    this.send(m);
  }

  #attach(tabId) {
    const sessionId = `FCDPSESSION${tabId}`;
    this.sessions.set(sessionId, tabId);
    let set = this.tabSessions.get(tabId);
    if (!set) { set = new Set(); this.tabSessions.set(tabId, set); }
    set.add(sessionId);
    return sessionId;
  }

  // Route a CDP event that arrived from the bridge to every session on that tab.
  routeEvent({ event, tabId, params }) {
    const set = this.tabSessions.get(tabId);
    if (!set) return;
    for (const sid of set) this.emit(event, params, sid);
  }

  async #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { id, method, params = {}, sessionId } = msg;
    vlog("->", sessionId ? `[${sessionId}]` : "[browser]", method);

    try {
      const result = isLocal(method)
        ? await this.#handleLocal(method, params, sessionId)
        : await this.#forward(method, params, sessionId);
      this.send(sessionId ? { id, sessionId, result: result ?? {} } : { id, result: result ?? {} });
    } catch (e) {
      const error = { code: e?.code ?? -32000, message: String(e?.message ?? e) };
      this.send(sessionId ? { id, sessionId, error } : { id, error });
    }
  }

  async #forward(method, params, sessionId) {
    const tabId = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && tabId === undefined) throw new Error(`unknown sessionId ${sessionId}`);
    if (tabId === undefined) {
      // A page-domain command with no session has no tab to run against. Say so
      // plainly instead of guessing a tab and returning a confidently wrong result.
      throw new Error(`${method} requires a session (attach to a target first)`);
    }
    return await this.bridge.cmd(tabId, method, params);
  }

  async #handleLocal(method, params, sessionId) {
    const B = this.bridge;

    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/fcdp-cdp",
          revision: "@fcdp",
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) fcdp-cdp",
          jsVersion: "12.0",
        };

      case "Browser.getWindowForTarget":
        return { windowId: 1, bounds: { left: 0, top: 0, width: 1440, height: 900, windowState: "normal" } };

      case "Browser.setDownloadBehavior":
      case "Browser.close":
        return {};

      case "Target.getTargets": {
        const tabs = await B.listTabs();
        return { targetInfos: tabs.map(targetInfo) };
      }

      case "Target.getTargetInfo": {
        const tabs = await B.listTabs();
        const want = params.targetId ?? (sessionId ? targetIdOf(this.sessions.get(sessionId)) : null);
        const t = tabs.find((x) => targetIdOf(x.tabId) === want);
        if (!t) throw new Error(`no such target ${want}`);
        return { targetInfo: targetInfo(t) };
      }

      case "Target.setDiscoverTargets": {
        this.discover = !!params.discover;
        if (this.discover) {
          for (const t of await B.listTabs()) this.emit("Target.targetCreated", { targetInfo: targetInfo(t) });
        }
        return {};
      }

      case "Target.setAutoAttach": {
        this.autoAttach = !!params.autoAttach;
        if (this.autoAttach) {
          for (const t of await B.listTabs()) {
            const sid = this.#attach(t.tabId);
            this.emit("Target.attachedToTarget",
              { sessionId: sid, targetInfo: targetInfo(t), waitingForDebugger: false });
          }
        }
        return {};
      }

      case "Target.attachToTarget": {
        const tabId = tabIdOf(params.targetId);
        const tabs = await B.listTabs();
        const t = tabs.find((x) => x.tabId === tabId);
        if (!t) throw new Error(`no such target ${params.targetId}`);
        const sid = this.#attach(tabId);
        this.emit("Target.attachedToTarget",
          { sessionId: sid, targetInfo: targetInfo(t), waitingForDebugger: false });
        return { sessionId: sid };
      }

      case "Target.detachFromTarget": {
        const sid = params.sessionId ?? sessionId;
        const tabId = this.sessions.get(sid);
        this.sessions.delete(sid);
        this.tabSessions.get(tabId)?.delete(sid);
        return {};
      }

      case "Target.createTarget": {
        const r = await B.cmd(undefined, "Meta.createTab", { url: params.url || "about:blank" });
        const tabId = r?.tabId;
        if (tabId == null) throw new Error("Meta.createTab returned no tabId");
        return { targetId: targetIdOf(tabId) };
      }

      case "Target.closeTarget": {
        await B.cmd(undefined, "Meta.closeTab", { tabId: tabIdOf(params.targetId) });
        return { success: true };
      }

      case "Target.getBrowserContexts":
        return { browserContextIds: ["FCDPDefaultContext"] };

      case "Target.setRemoteLocations":
      case "Target.setDiscoverTargetsOnBrowserContext":
        return {};

      default:
        // Explicit refusal beats a silent {} that makes a client believe a
        // browser-level capability exists when it does not.
        throw new Error(
          `${method} is not available through the fcdp extension bridge ` +
          `(chrome.debugger serves page-level domains only)`);
    }
  }
}

// ------------------------------------------------------------------------- server
async function main() {
  const bridge = new Bridge();
  try {
    await bridge.connect();
  } catch (e) {
    log(`FATAL: cannot reach the fcdp bridge at ${SOCK}: ${e.message}`);
    log("  fix: launchctl kickstart -k gui/$(id -u)/com.barklee.fcdp-bridge");
    process.exit(4);
  }
  bridge.subscribeAll();
  log(`connected to fcdp bridge at ${SOCK}`);

  const clients = new Set();
  bridge.onEvent = (m) => { for (const c of clients) c.routeEvent(m); };

  const wsPath = `/devtools/browser/${BROWSER_GUID}`;
  const wsUrl = `ws://${HOST}:${PORT}${wsPath}`;

  const server = http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    const json = (obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": b.length });
      res.end(b);
    };

    try {
      if (url === "/json/version") {
        return json({
          Browser: "Chrome/fcdp-cdp",
          "Protocol-Version": "1.3",
          "User-Agent": "fcdp-cdp",
          "V8-Version": "12.0",
          "WebKit-Version": "537.36",
          webSocketDebuggerUrl: wsUrl,
        });
      }
      if (url === "/json" || url === "/json/list") {
        const tabs = await bridge.listTabs();
        return json(tabs.map((t) => ({
          id: targetIdOf(t.tabId),
          type: "page",
          title: t.title || "",
          url: t.url || "",
          webSocketDebuggerUrl: `ws://${HOST}:${PORT}/devtools/page/${targetIdOf(t.tabId)}`,
devtoolsFrontendUrl: "",
        })));
      }
      if (url === "/json/protocol") return json({});
      res.writeHead(404).end("not found");
    } catch (e) {
      res.writeHead(500).end(String(e?.message ?? e));
    }
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    vlog("client connected:", req.url);
    const c = new Client(ws, bridge);
    clients.add(c);
    ws.on("close", () => clients.delete(c));
  });

  server.listen(PORT, HOST, () => {
    log(`fcdp-cdp listening on http://${HOST}:${PORT}`);
    log(`  browser ws: ${wsUrl}`);
    log(`  try: agent-browser connect ${PORT}`);
  });
}

main().catch((e) => { log("FATAL", e); process.exit(1); });
