/**
 * Thin wrapper around discord-rpc with auto-reconnect and a single
 * "current presence" cache so we don't spam Discord with identical payloads.
 *
 * RPC events (connect / disconnect / payload validation errors) are also
 * appended to %APPDATA%/watchverse-webview/rpc.log so a user can send the
 * file when their Discord presence isn't showing — much easier than
 * walking them through opening DevTools or running from a terminal.
 */
const RPC = require('discord-rpc');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// WatchVerse Discord application (Client ID). The activity shows "WatchVerse";
// the large image asset uploaded under key `big_image` in the Discord Dev
// Portal is the WatchVerse logo (cf. routes.js FALLBACK_LARGE_KEY).
const CLIENT_ID = '1510782927779139705';

let client = null;
let connected = false;
let connecting = false;
let lastPayload = null;
let queued = null;
// Heartbeat re-emit — Discord's CDN drops cached asset URLs after ~10 min of
// inactivity on the same payload (cover/avatar disappears when you stay on a
// page too long). Re-pushing the same lastPayload keeps the cache warm. 4 min
// is below the expiry and above discord-rpc's 15s rate limit.
const HEARTBEAT_MS = 4 * 60 * 1000;
let heartbeatTimer = null;

let logPath = null;
function getLogPath() {
  if (logPath) return logPath;
  try { logPath = path.join(app.getPath('userData'), 'rpc.log'); } catch {}
  return logPath;
}
function logToFile(msg) {
  const p = getLogPath();
  if (!p) return;
  fs.appendFile(p, `[${new Date().toISOString()}] ${msg}\n`, () => {});
}

// Session-aware timestamp: same _sessionKey across updates keeps the original
// startTimestamp so Discord shows elapsed time over the whole viewing session
// (e.g. across episode changes), not since the last update.
let sessionKey = null;
let sessionStart = null;

RPC.register(CLIENT_ID);

async function connect() {
  if (connected || connecting) return;
  connecting = true;
  try {
    client = new RPC.Client({ transport: 'ipc' });
    client.on('ready', () => {
      connected = true;
      const who = client.user?.username || 'unknown';
      console.log('[RPC] Connected as', who);
      logToFile(`Connected as ${who}`);
      if (queued) {
        const p = queued;
        queued = null;
        sendActivity(p);
      }
    });
    client.on('disconnected', () => {
      connected = false;
      console.log('[RPC] Disconnected');
      logToFile('Disconnected');
    });
    await client.login({ clientId: CLIENT_ID });
  } catch (err) {
    console.warn('[RPC] Discord client unreachable —', err.message);
    logToFile(`login failed: ${err.message || err}`);
    connected = false;
    client = null;
  } finally {
    connecting = false;
  }
}

function sendActivity(payload) {
  if (!client || !connected) {
    queued = payload;
    connect().catch(() => {});
    return;
  }
  client.setActivity(payload).catch(err => {
    const msg = err.message || String(err);
    console.error('[RPC] setActivity failed:', msg);
    logToFile(`setActivity failed: ${msg} | payload=${JSON.stringify({ details: payload.details, state: payload.state, hasButtons: !!payload.buttons })}`);
    const isValidation = /child "|fails because|valid uri|valid url|too long|secrets cannot|cannot be sent|invalid activity/i.test(msg);
    if (!isValidation) {
      connected = false;
      queued = payload;
      setTimeout(() => connect().catch(() => {}), 5000);
    } else {
      lastPayload = null;
    }
  });
}

function isSamePayload(a, b) {
  if (!a || !b) return false;
  return a.details === b.details
      && a.state === b.state
      && a.largeImageKey === b.largeImageKey
      && a.largeImageText === b.largeImageText
      && JSON.stringify(a.buttons || []) === JSON.stringify(b.buttons || []);
}

function updatePresence(payload) {
  if (!payload) return;

  const newKey = payload._sessionKey || `${payload.details}|${payload.state}`;
  delete payload._sessionKey;
  const reset = newKey !== sessionKey;
  if (reset) {
    sessionKey = newKey;
    sessionStart = Date.now();
  }
  payload.startTimestamp = sessionStart;
  payload.instance = false;

  if (isSamePayload(payload, lastPayload)) return; // de-dupe
  lastPayload = { ...payload };
  sendActivity(payload);
}

function clearPresence() {
  lastPayload = null;
  sessionKey = null;
  sessionStart = null;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (client && connected) {
    client.clearActivity().catch(() => {});
  }
}

function refreshActivityNow() {
  if (!client || !connected) return;
  if (!lastPayload) return;
  client.setActivity(lastPayload).catch(err => {
    logToFile(`heartbeat setActivity failed: ${err.message || err}`);
  });
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(refreshActivityNow, HEARTBEAT_MS);
}

async function init() {
  await connect();
  startHeartbeat();
  setInterval(() => {
    if (!connected) connect().catch(() => {});
  }, 15000);
}

module.exports = { init, updatePresence, clearPresence };
