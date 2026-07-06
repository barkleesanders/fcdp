#!/usr/bin/env node
// fcdp bridge daemon.
//   - WebSocketServer on 127.0.0.1:<PORT> : the fcdp Chrome extension connects here.
//   - Unix-domain server at /tmp/fcdp.sock  : the `fcdp` CLI connects here.
// Framing on the Unix socket: 4-byte little-endian length prefix + JSON body
// (mirrors ccb's call()). The bridge relays each CLI command to the extension
// over the WS with a correlation id, awaits the reply, and frames it back.
// It also fans CDP events out to any CLI connection that has "subscribed", so
// intercept/trace can observe Fetch.requestPaused / Tracing.dataCollected / etc.
//
// CLI -> bridge frames (JSON):
//   {id, tabId, method, params}          run a CDP command (or Meta.* op), reply {id,result|error}
//   {op:"subscribe", filter:[...], tabId} route matching events to THIS socket, reply {ok:true}
//   {op:"unsubscribe"}                    stop routing events, reply {ok:true}
// bridge -> CLI frames:
//   {id, result} | {id, error}           command reply
//   {event:"Domain.method", tabId, params} pushed CDP event (to subscribers)

import { WebSocketServer } from "ws";
import net from "node:net";
import fs from "node:fs";

const PORT = 9871;
const SOCK = "/tmp/fcdp.sock";

let extWs = null;                 // the single connected extension socket
const pending = new Map();        // extId -> {sock, cliId}
const subscribers = new Set();    // Set<net.Socket> currently receiving events
let nextId = 1;

function nowTag() { return new Date().toISOString().slice(11, 23); }
function log(...a) { console.log(nowTag(), ...a); }

// ---- extension WebSocket server ------------------------------------------
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("listening", () => log(`bridge WS listening on ws://127.0.0.1:${PORT} (waiting for extension)`));
wss.on("connection", (sock) => {
  log("extension connected");
  extWs = sock;
  sock.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.hello) { log("extension hello; attached tabs:", msg.attached); return; }
    if (msg.event) { fanoutEvent(msg); return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { sock: cliSock, cliId } = pending.get(msg.id);
      pending.delete(msg.id);
      frameSend(cliSock, { id: cliId, result: msg.result, error: msg.error });
    }
  });
  sock.on("close", () => { log("extension disconnected"); if (extWs === sock) extWs = null; });
  sock.on("error", () => {});
});

function fanoutEvent(msg) {
  for (const s of subscribers) {
    const flt = s._fcdpFilter;
    const tab = s._fcdpTab;
    if (tab != null && msg.tabId !== tab) continue;
    if (flt && flt.length && !flt.includes(msg.event)) continue;
    frameSend(s, { event: msg.event, tabId: msg.tabId, params: msg.params });
  }
}

// ---- Unix-domain server for the CLI --------------------------------------
try { fs.unlinkSync(SOCK); } catch {}
const unix = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // deframe: 4-byte LE length prefix + JSON
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      let req;
      try { req = JSON.parse(body.toString()); } catch { continue; }
      onCliMessage(sock, req);
    }
  });
  sock.on("close", () => { subscribers.delete(sock); });
  sock.on("error", () => { subscribers.delete(sock); });
});
unix.listen(SOCK, () => log(`bridge Unix socket at ${SOCK}`));

function onCliMessage(sock, req) {
  if (req.op === "subscribe") {
    sock._fcdpFilter = req.filter || [];
    sock._fcdpTab = (req.tabId != null) ? req.tabId : null;
    subscribers.add(sock);
    return frameSend(sock, { ok: true });
  }
  if (req.op === "unsubscribe") {
    subscribers.delete(sock);
    return frameSend(sock, { ok: true });
  }
  // Default: a CDP/Meta command to relay to the extension.
  const cliId = req.id;
  if (!extWs || extWs.readyState !== 1) {
    return frameSend(sock, { id: cliId, error: { message: "no extension connected to bridge — is the fcdp extension loaded and is Chrome running?" } });
  }
  const extId = nextId++;
  pending.set(extId, { sock, cliId });
  extWs.send(JSON.stringify({ id: extId, tabId: req.tabId, method: req.method, params: req.params || {} }));
  // safety timeout so a lost reply doesn't hang the CLI forever
  setTimeout(() => {
    if (pending.has(extId)) {
      pending.delete(extId);
      frameSend(sock, { id: cliId, error: { message: "timeout waiting for extension reply" } });
    }
  }, 60000);
}

function frameSend(sock, obj) {
  try {
    const body = Buffer.from(JSON.stringify(obj));
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(body.length, 0);
    sock.write(Buffer.concat([hdr, body]));
  } catch {}
}

process.on("SIGINT", () => { try { fs.unlinkSync(SOCK); } catch {}; process.exit(0); });
process.on("SIGTERM", () => { try { fs.unlinkSync(SOCK); } catch {}; process.exit(0); });
