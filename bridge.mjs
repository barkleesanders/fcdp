#!/usr/bin/env node

// fcdp bridge daemon — MULTI-PROFILE (2026-07-08).
//   - WebSocketServer on 127.0.0.1:<PORT> : one fcdp extension per Chrome PROFILE
//     connects here. The bridge now tracks ALL connected profiles at once (not a
//     single socket), so `fcdp` can drive tabs in ANY loaded profile.
//   - Unix-domain server at /tmp/fcdp.sock  : the `fcdp` CLI connects here.
// Framing on the Unix socket: 4-byte little-endian length prefix + JSON body.
//
// Routing model:
//   * Meta.listTabs (no tabId)  -> BROADCAST to every profile, MERGE the tab lists
//     back to the CLI as one result. Tab ids are globally unique across profiles.
//   * command WITH a tabId      -> route to the profile that OWNS that tab (learned
//     from listTabs replies, hello.attached, CDP events, and prior routes). If the
//     owner is unknown, RACE the command to all profiles and return the one success
//     (exactly one profile has the tab; the rest error), caching the winner.
//   * no-tabId meta (Meta.createTab, ...) -> route to the ACTIVE profile (the one
//     whose window currently holds an active tab), else the first connected profile.
//
// CLI -> bridge frames (JSON):
//   {id, tabId, method, params}          run a CDP command (or Meta.* op)
//   {op:"subscribe", filter:[...], tabId} route matching events to THIS socket
//   {op:"unsubscribe"}                    stop routing events
// bridge -> CLI frames:
//   {id, result} | {id, error}           command reply
//   {event:"Domain.method", tabId, params} pushed CDP event (to subscribers)

import fs from 'node:fs';
import net from 'node:net';
import { WebSocketServer } from 'ws';

const PORT = 9871;
const SOCK = '/tmp/fcdp.sock';

const conns = new Set(); // Set<WebSocket> — one per connected profile
const connTabs = new Map(); // WebSocket -> Set<tabId> owned by that profile
const tabOwner = new Map(); // tabId -> WebSocket that owns it
let activeConn = null; // profile whose window last reported an active tab
const pending = new Map(); // extId -> {kind, ...} outstanding ext request
const subscribers = new Set(); // Set<net.Socket> currently receiving events
let nextId = 1;
let connSeq = 0;

function nowTag() {
  return new Date().toISOString().slice(11, 23);
}
function log(...a) {
  console.log(nowTag(), ...a);
}

function ownerSet(ws, tabId) {
  if (tabId == null) return;
  let s = connTabs.get(ws);
  if (!s) {
    s = new Set();
    connTabs.set(ws, s);
  }
  s.add(tabId);
  tabOwner.set(tabId, ws);
}
function ownerOf(tabId) {
  const ws = tabOwner.get(tabId);
  return ws && ws.readyState === 1 ? ws : null;
}
function liveConns() {
  return [...conns].filter((c) => c.readyState === 1);
}
function defaultConn() {
  if (activeConn && activeConn.readyState === 1) return activeConn;
  return liveConns()[0] || null;
}

// ---- extension WebSocket server ------------------------------------------
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('listening', () =>
  log(`bridge WS listening on ws://127.0.0.1:${PORT} (multi-profile; waiting for extensions)`),
);
wss.on('connection', (sock) => {
  sock._id = ++connSeq;
  conns.add(sock);
  log(`ext#${sock._id} connected (${conns.size} profile(s) live)`);
  sock.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    onExtMessage(sock, msg);
  });
  sock.on('close', () => {
    conns.delete(sock);
    const s = connTabs.get(sock);
    if (s) {
      for (const t of s) if (tabOwner.get(t) === sock) tabOwner.delete(t);
      connTabs.delete(sock);
    }
    if (activeConn === sock) activeConn = null;
    log(`ext#${sock._id} disconnected (${conns.size} left)`);
  });
  sock.on('error', () => {});
});

function onExtMessage(ws, msg) {
  if (msg.hello) {
    log(`ext#${ws._id} hello; attached tabs:`, msg.attached);
    if (Array.isArray(msg.attached)) for (const t of msg.attached) ownerSet(ws, t);
    return;
  }
  if (msg.event) {
    if (msg.tabId != null) ownerSet(ws, msg.tabId);
    fanoutEvent(msg);
    return;
  }
  if (msg.id == null) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);

  if (p.kind === 'single') {
    if (p.tabId != null) ownerSet(ws, p.tabId);
    if (p.method === 'Meta.createTab' && msg.result && msg.result.tabId != null) {
      ownerSet(ws, msg.result.tabId);
      activeConn = ws;
    }
    frameSend(p.cliSock, { id: p.cliId, result: msg.result, error: msg.error });
    return;
  }
  if (p.kind === 'agg') {
    const agg = p.agg;
    if (msg.result && Array.isArray(msg.result.tabs)) {
      for (const t of msg.result.tabs) {
        agg.tabs.push(t);
        ownerSet(ws, t.tabId);
        if (t.active) activeConn = ws;
      }
      if (Array.isArray(msg.result.attached)) agg.attached.push(...msg.result.attached);
    }
    agg.remaining--;
    if (agg.remaining <= 0) finalizeAgg(agg);
    return;
  }
  if (p.kind === 'race') {
    const agg = p.agg;
    if (!msg.error && msg.result !== undefined && !agg.winner) {
      agg.winner = msg.result;
      ownerSet(ws, agg.tabId);
      activeConn = ws;
    } else if (msg.error) {
      agg.lastErr = msg.error;
    }
    agg.remaining--;
    if (agg.winner || agg.remaining <= 0) finalizeRace(agg);
    return;
  }
}

function finalizeAgg(agg) {
  if (agg.done) return;
  agg.done = true;
  clearTimeout(agg._timer);
  frameSend(agg.cliSock, { id: agg.cliId, result: { tabs: agg.tabs, attached: agg.attached } });
}
function finalizeRace(agg) {
  if (agg.done) return;
  agg.done = true;
  clearTimeout(agg._timer);
  if (agg.winner !== null && agg.winner !== undefined)
    frameSend(agg.cliSock, { id: agg.cliId, result: agg.winner });
  else
    frameSend(agg.cliSock, {
      id: agg.cliId,
      error: agg.lastErr || { message: `no connected profile owns tab ${agg.tabId}` },
    });
}

function fanoutEvent(msg) {
  for (const s of subscribers) {
    const flt = s._fcdpFilter;
    const tab = s._fcdpTab;
    if (tab != null && msg.tabId !== tab) continue;
    if (flt?.length && !flt.includes(msg.event)) continue;
    frameSend(s, { event: msg.event, tabId: msg.tabId, params: msg.params });
  }
}

// ---- Unix-domain server for the CLI --------------------------------------
try {
  fs.unlinkSync(SOCK);
} catch {}
const unix = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      let req;
      try {
        req = JSON.parse(body.toString());
      } catch {
        continue;
      }
      onCliMessage(sock, req);
    }
  });
  sock.on('close', () => {
    subscribers.delete(sock);
  });
  sock.on('error', () => {
    subscribers.delete(sock);
  });
});
unix.listen(SOCK, () => log(`bridge Unix socket at ${SOCK}`));

function onCliMessage(sock, req) {
  if (req.op === 'subscribe') {
    sock._fcdpFilter = req.filter || [];
    sock._fcdpTab = req.tabId != null ? req.tabId : null;
    subscribers.add(sock);
    return frameSend(sock, { ok: true });
  }
  if (req.op === 'unsubscribe') {
    subscribers.delete(sock);
    return frameSend(sock, { ok: true });
  }

  const cliId = req.id;
  if (liveConns().length === 0) {
    return frameSend(sock, {
      id: cliId,
      error: {
        message:
          'no extension connected to bridge — is the fcdp extension loaded in at least one Chrome profile and is Chrome running?',
      },
    });
  }

  // Broadcast tab listing across every profile, merged into one reply.
  if (req.method === 'Meta.listTabs') {
    return broadcastListTabs(sock, cliId);
  }

  // Command targeting a specific tab -> route to the owning profile.
  if (req.tabId != null) {
    const owner = ownerOf(req.tabId);
    if (owner) return relay(owner, sock, req);
    return raceRoute(sock, req); // owner unknown -> try all, return the one success
  }

  // No-tabId meta command (Meta.createTab, ...) -> active/first profile.
  const target = defaultConn();
  if (!target)
    return frameSend(sock, { id: cliId, error: { message: 'no connected profile available' } });
  return relay(target, sock, req);
}

function relay(ws, cliSock, req) {
  const extId = nextId++;
  pending.set(extId, {
    kind: 'single',
    cliSock,
    cliId: req.id,
    ws,
    tabId: req.tabId,
    method: req.method,
  });
  ws.send(
    JSON.stringify({ id: extId, tabId: req.tabId, method: req.method, params: req.params || {} }),
  );
  setTimeout(() => {
    if (pending.has(extId)) {
      pending.delete(extId);
      frameSend(cliSock, { id: req.id, error: { message: 'timeout waiting for extension reply' } });
    }
  }, 60000);
}

function broadcastListTabs(cliSock, cliId) {
  const targets = liveConns();
  const agg = { cliSock, cliId, remaining: targets.length, tabs: [], attached: [], done: false };
  agg._timer = setTimeout(() => finalizeAgg(agg), 6000);
  for (const ws of targets) {
    const extId = nextId++;
    pending.set(extId, { kind: 'agg', agg, ws });
    ws.send(JSON.stringify({ id: extId, method: 'Meta.listTabs', params: {} }));
  }
}

function raceRoute(cliSock, req) {
  const targets = liveConns();
  const agg = {
    cliSock,
    cliId: req.id,
    remaining: targets.length,
    winner: null,
    lastErr: null,
    done: false,
    tabId: req.tabId,
  };
  agg._timer = setTimeout(() => finalizeRace(agg), 60000);
  for (const ws of targets) {
    const extId = nextId++;
    pending.set(extId, { kind: 'race', agg, ws, tabId: req.tabId });
    ws.send(
      JSON.stringify({ id: extId, tabId: req.tabId, method: req.method, params: req.params || {} }),
    );
  }
}

function frameSend(sock, obj) {
  try {
    const body = Buffer.from(JSON.stringify(obj));
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(body.length, 0);
    sock.write(Buffer.concat([hdr, body]));
  } catch {}
}

process.on('SIGINT', () => {
  try {
    fs.unlinkSync(SOCK);
  } catch {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try {
    fs.unlinkSync(SOCK);
  } catch {}
  process.exit(0);
});
