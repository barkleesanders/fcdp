#!/usr/bin/env node
// Persistent Chrome --remote-debugging-pipe bridge for fcdp.
// Owns an isolated, non-Default profile and exposes fcdp's framed Unix protocol.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const SOCKET = flag('--socket', process.env.FCDP_PIPE_SOCKET || '/tmp/fcdp-pipe.sock');
const PROFILE = path.resolve(
  flag(
    '--profile',
    process.env.FCDP_PIPE_PROFILE || path.join(os.homedir(), '.cache/fcdp-pipe-profile'),
  ),
);
const CHROME = flag(
  '--chrome',
  process.env.FCDP_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
);
const VERBOSE = process.argv.includes('--verbose');
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const log = (...parts) => process.stderr.write(`[fcdp-pipe] ${parts.join(' ')}\n`);
const vlog = (...parts) => VERBOSE && log(...parts);

if (fs.existsSync(SOCKET)) {
  log(`refusing to replace existing socket ${SOCKET}`);
  process.exit(2);
}
const profileReal = fs.existsSync(PROFILE) ? fs.realpathSync(PROFILE) : PROFILE;
const home = path.resolve(os.homedir());
const forbiddenProfiles = new Set([
  path.parse(profileReal).root,
  home,
  path.join(home, '.cache'),
  path.join(home, 'Library'),
  path.join(home, 'Library', 'Application Support'),
  path.resolve(os.tmpdir()),
]);
const realChromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
if (
  forbiddenProfiles.has(profileReal) ||
  profileReal === realChromeRoot ||
  profileReal.startsWith(`${realChromeRoot}${path.sep}`)
) {
  log(`refusing unsafe or real-profile directory ${profileReal}`);
  process.exit(2);
}
fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
fs.chmodSync(PROFILE, 0o700);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-pipe',
    `--user-data-dir=${PROFILE}`,
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);

chrome.stderr.on('data', (chunk) => VERBOSE && process.stderr.write(chunk));
chrome.on('error', (error) => {
  log(`Chrome launch failed: ${error.message}`);
  shutdown('chrome-error');
});

class ChromePipe {
  constructor(child) {
    this.child = child;
    this.input = child.stdio[3];
    this.output = child.stdio[4];
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.output.on('data', (chunk) => this.onData(chunk));
    this.output.on('error', (error) => this.failAll(error));
  }

  onEvent(listener) {
    this.listeners.add(listener);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const boundary = this.buffer.indexOf(0);
      if (boundary < 0) return;
      const frame = this.buffer.subarray(0, boundary);
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!frame.length) continue;
      let message;
      try {
        message = JSON.parse(frame.toString('utf8'));
      } catch (error) {
        log(`invalid Chrome pipe frame: ${error.message}`);
        continue;
      }
      if (message.id != null && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(Object.assign(new Error(message.error.message), message.error));
        else pending.resolve(message.result || {});
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    vlog('->', sessionId ? `[${sessionId}]` : '[browser]', method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(`${JSON.stringify(message)}\0`);
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const pipe = new ChromePipe(chrome);
const targetSessions = new Map();
const sessionTargets = new Map();
const clients = new Set();

async function pages() {
  const { targetInfos = [] } = await pipe.send('Target.getTargets');
  return targetInfos.filter((target) => target.type === 'page');
}

async function sessionFor(targetId) {
  if (targetSessions.has(targetId)) return targetSessions.get(targetId);
  const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
  targetSessions.set(targetId, sessionId);
  sessionTargets.set(sessionId, targetId);
  return sessionId;
}

pipe.onEvent((message) => {
  if (message.method === 'Target.detachedFromTarget') {
    const targetId = sessionTargets.get(message.params?.sessionId);
    if (targetId) targetSessions.delete(targetId);
    sessionTargets.delete(message.params?.sessionId);
  }
  const tabId = message.sessionId ? sessionTargets.get(message.sessionId) : 'browser';
  for (const client of clients) {
    if (!client.subscription) continue;
    const { filter, tabId: wanted } = client.subscription;
    if (wanted != null && String(wanted) !== String(tabId)) continue;
    if (filter.length && !filter.some((prefix) => message.method.startsWith(prefix))) continue;
    frameSend(client, { event: message.method, tabId, params: message.params || {} });
  }
});

function frameSend(socket, object) {
  const body = Buffer.from(JSON.stringify(object));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  socket.write(Buffer.concat([header, body]));
}

async function execute(request) {
  const { tabId, method, params = {} } = request;
  switch (method) {
    case 'Meta.listTabs': {
      const tabs = await pages();
      return {
        tabs: tabs.map((target) => ({
          tabId: target.targetId,
          url: target.url,
          title: target.title,
          active: false,
        })),
      };
    }
    case 'Meta.createTab': {
      const result = await pipe.send('Target.createTarget', { url: params.url || 'about:blank' });
      return { tabId: result.targetId };
    }
    case 'Meta.closeTab': {
      const targetId = params.tabId || tabId;
      const result = await pipe.send('Target.closeTarget', { targetId });
      return { closed: result.success !== false, tabId: targetId };
    }
    case 'Meta.attach':
      return { attached: true, tabId, sessionId: await sessionFor(tabId) };
    case 'Meta.detach': {
      const sessionId = targetSessions.get(tabId);
      if (sessionId) await pipe.send('Target.detachFromTarget', { sessionId });
      targetSessions.delete(tabId);
      sessionTargets.delete(sessionId);
      return { detached: true, tabId };
    }
    default:
      if (tabId === 'browser') return await pipe.send(method, params);
      if (tabId == null) throw new Error(`tabId required for ${method}`);
      return await pipe.send(method, params, await sessionFor(tabId));
  }
}

const server = net.createServer((socket) => {
  clients.add(socket);
  socket.buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    socket.buffer = Buffer.concat([socket.buffer, chunk]);
    while (socket.buffer.length >= 4) {
      const length = socket.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        log(`closing client with oversized frame (${length} bytes)`);
        socket.destroy();
        return;
      }
      if (socket.buffer.length < 4 + length) break;
      const body = socket.buffer.subarray(4, 4 + length);
      socket.buffer = socket.buffer.subarray(4 + length);
      let request;
      try {
        request = JSON.parse(body.toString('utf8'));
      } catch {
        continue;
      }
      if (request.op === 'subscribe') {
        socket.subscription = { filter: request.filter || [], tabId: request.tabId };
        frameSend(socket, { result: { subscribed: true } });
        continue;
      }
      execute(request)
        .then((result) => frameSend(socket, { id: request.id, result }))
        .catch((error) =>
          frameSend(socket, {
            id: request.id,
            error: { code: error.code || -32000, message: error.message || String(error) },
          }),
        );
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping (${signal})`);
  if (server.listening) server.close();
  if (!chrome.killed) chrome.kill('SIGTERM');
  try {
    if (fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET);
  } catch (error) {
    log(`socket cleanup failed: ${error.message}`);
  }
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
chrome.on('exit', (code, signal) => {
  pipe.failAll(new Error(`Chrome exited code=${code} signal=${signal}`));
  shutdown('chrome-exit');
});

async function start() {
  // Full Chrome creates an initial page; chrome-headless-shell does not. Keep the
  // transport behavior identical by creating one only when the runtime has none.
  if ((await pages()).length === 0) {
    await pipe.send('Target.createTarget', { url: 'about:blank' });
  }
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    log(`listening at ${SOCKET}`);
    log(`isolated profile ${PROFILE}`);
  });
}

start().catch((error) => {
  log(`startup failed: ${error.message}`);
  shutdown('startup-error');
});
