/**
 * WatchVerse Webview — Electron main process.
 *
 * Boots a single-window webview pointed at the WatchVerse site, and bridges
 * route changes (and rich data from the page itself) to a Discord Rich
 * Presence connection.
 *
 * URL is selected from env vars:
 *   WATCHVERSE_URL   — full URL to load (e.g. http://192.168.2.100:5173)
 *   WATCHVERSE_DEV   — if set, defaults to http://localhost:5173 + opens DevTools
 *   (otherwise defaults to https://watchverse.watch — the public prod URL)
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage, powerMonitor } = require('electron');
const path = require('path');

// Windows app identity — set BEFORE any window so Windows treats WatchVerse as
// its own app (taskbar icon + grouping), not generic electron.exe.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.watchverse.webview');
}

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const { init: initRpc, updatePresence, clearPresence } = require('./rpc');
const { getPresenceForRoute, normalizeRoute } = require('./routes');
const { checkForUpdates } = require('./update-check');
const fs = require('fs');
const os = require('os');

// Sweep stale WatchVerse installer .exes left in %TEMP% by a previous update.
function cleanupStaleInstallers() {
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (/^WatchVerse-Setup-.*\.exe$/i.test(name)) {
        try { fs.unlinkSync(path.join(tmp, name)); } catch {}
      }
    }
  } catch {/* best-effort */}
}

const isDev = !!process.env.WATCHVERSE_DEV;
const TARGET_URL = process.env.WATCHVERSE_URL || (isDev ? 'http://localhost:5173' : 'https://watchverse.watch');
// Backend API base for the optional "X en ligne" counter.
const API_BASE = process.env.WATCHVERSE_API || 'https://api.watchverse.watch';

let mainWindow = null;

// ── Custom protocol: watchverse:// ───────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('watchverse', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('watchverse');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/**
 * watchverse:// URL → site path.
 *   watchverse://film/abc        → /film/abc   (serie/anime/title idem)
 *   watchverse://watch/abc/s1e3  → /watch/abc/s1e3
 *   watchverse://party/ABC123    → /party/ABC123
 *   watchverse://tv              → /tv
 */
function pathFromProtocolUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== 'watchverse:') return null;
  const host = u.hostname || '';
  const segs = u.pathname.split('/').filter(Boolean);
  if (host === 'tv') return '/tv';
  if (host === 'party' && segs[0]) return `/party/${encodeURIComponent(segs[0])}`;
  if (host === 'watch' && segs[0]) {
    return segs[1]
      ? `/watch/${encodeURIComponent(segs[0])}/${encodeURIComponent(segs[1])}`
      : `/watch/${encodeURIComponent(segs[0])}`;
  }
  if (['film', 'serie', 'anime', 'title'].includes(host) && segs[0]) {
    return `/${host}/${encodeURIComponent(segs[0])}`;
  }
  return null;
}

function navigateFromProtocolUrl(urlStr) {
  const p = pathFromProtocolUrl(urlStr);
  if (!p || !mainWindow || mainWindow.isDestroyed()) return;
  const target = `${TARGET_URL.replace(/\/$/, '')}${p}`;
  console.log('[Main] watchverse:// →', target);
  mainWindow.loadURL(target);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * URL → { route, params } for routes.js. Fallback when the page hasn't (yet)
 * called setPresence.
 */
function parseRouteFromUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const qs = u.searchParams;

  if (p === '/' || p === '') return { route: 'home' };

  if (p.startsWith('/catalogue') || ['/films', '/series', '/anime', '/bibliotheque'].includes(p)) {
    let type = qs.get('type');
    if (!type) {
      if (p === '/films') type = 'film';
      else if (p === '/series') type = 'serie';
      else if (p === '/anime') type = 'anime';
      else if (p === '/bibliotheque') type = 'bibliotheque';
      else type = 'all';
    }
    const q = qs.get('q');
    const genres = qs.get('genres');
    const sort = qs.get('sort');
    return { route: 'catalogue', params: {
      type,
      q: q || null,
      genres: genres ? genres.split(',').filter(Boolean) : [],
      sort: sort || null,
    } };
  }

  let m = p.match(/^\/watch\/([^/]+)(?:\/([^/?#]+))?/);
  if (m) {
    const party = (qs.get('party') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || null;
    const kind = qs.get('kind') || null;
    return { route: 'player', params: { id: m[1], episode: m[2] || null, kind, party } };
  }

  if (p === '/tv') return { route: 'livetv' };

  m = p.match(/^\/party\/([^/?#]+)/);
  if (m) return { route: 'party', params: { code: m[1] } };

  m = p.match(/^\/(film|serie|anime|title)\/([^/?#]+)/);
  if (m) {
    const seg = m[1];
    const kind = seg === 'film' ? 'movie' : seg === 'serie' ? 'tv' : seg === 'anime' ? 'anime' : null;
    return { route: 'title', params: { id: m[2], kind } };
  }
  m = p.match(/^\/manga\/([^/?#]+)/);
  if (m) return { route: 'title', params: { id: m[1] } };

  m = p.match(/^\/profile\/([^/?#]+)/);
  if (m) return { route: 'profile', params: { username: m[1] } };
  m = p.match(/^\/univers\/([^/?#]+)/);
  if (m) return { route: 'universe', params: { id: m[1] } };
  if (p === '/friends') return { route: 'friends' };
  if (p === '/wrapped' || p.startsWith('/wrapped/')) {
    const year = p.match(/^\/wrapped\/(\d{4})/)?.[1];
    return { route: 'wrapped', params: year ? { year } : {} };
  }
  if (p === '/admin' || p.startsWith('/admin/')) return { route: 'admin' };
  if (p === '/login') return { route: 'login' };
  if (p === '/register') return { route: 'register' };
  if (p === '/settings/blocked')    return { route: 'settings-blocked' };
  if (p === '/settings/privacy')    return { route: 'settings-privacy' };
  if (p === '/settings/appearance') return { route: 'settings-appearance' };
  if (p.startsWith('/settings')) return { route: 'settings' };
  if (p === '/suggestions') return { route: 'suggestions' };
  if (p === '/premium') return { route: 'premium' };
  if (p === '/about') return { route: 'about' };
  if (p === '/contact') return { route: 'contact' };
  if (p === '/privacy-policy') return { route: 'privacy' };
  if (p === '/terms') return { route: 'terms' };
  if (p === '/changelog') return { route: 'changelog' };
  return { route: 'notfound' };
}

let rpcEnabled = true;
let lastRichPayload = null;

let onlineCount = 0;
async function pollOnlineCount() {
  try {
    const url = `${API_BASE.replace(/\/$/, '')}/api/presence/online-count`;
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    const next = Number(data.online) || 0;
    if (next !== onlineCount) {
      onlineCount = next;
      console.log('[Main] online count:', onlineCount);
      if (rpcEnabled && mainWindow && !mainWindow.isDestroyed()) {
        emitPresenceFromUrl(mainWindow.webContents.getURL());
      }
    }
  } catch { /* endpoint optional */ }
}

function titleBarLabelFor(route, params = {}) {
  const kindWord = (k) => k === 'movie' ? 'Film' : k === 'anime' ? 'Animé' : k === 'tv' ? 'Série' : 'Œuvre';
  switch (route) {
    case 'home':      return 'Accueil';
    case 'catalogue':
      return params.type === 'film'  ? 'Catalogue · Films'
        : params.type === 'serie'    ? 'Catalogue · Séries'
        : params.type === 'anime'    ? 'Catalogue · Animés'
        : params.type === 'bibliotheque' ? 'Ma bibliothèque'
        : 'Catalogue';
    case 'title':     return params.title ? `${params.title}` : `Fiche · ${kindWord(params.kind)}`;
    case 'player': {
      const t = params.title || null;
      let ep = '';
      if (typeof params.episode === 'string') {
        const m = /^s(\d+)e(\d+)$/i.exec(params.episode);
        if (m) ep = ` · S${String(+m[1]).padStart(2, '0')}E${String(+m[2]).padStart(2, '0')}`;
      }
      const head = params.party ? '👥 ' : '▶ ';
      if (t) return `${head}${t}${ep}`;
      return params.party ? 'Watch Party' : 'Lecture en cours';
    }
    case 'livetv':    return 'TV en direct';
    case 'party':     return params.code ? `Watch Party · ${params.code}` : 'Watch Party';
    case 'profile':   return params.username ? `Profil de @${params.username}` : 'Profil';
    case 'friends':   return 'Amis';
    case 'wrapped':   return params.year ? `Wrapped ${params.year}` : 'Wrapped';
    case 'admin':     return 'Espace admin';
    case 'login':     return 'Connexion';
    case 'register':  return 'Inscription';
    case 'settings':  return 'Réglages';
    case 'settings-blocked':  return 'Réglages · Blocages';
    case 'settings-privacy':  return 'Réglages · Confidentialité';
    case 'settings-appearance': return 'Réglages · Apparence';
    case 'universe':  return 'Univers';
    case 'suggestions': return 'Suggestions';
    case 'premium':   return 'WatchVerse+';
    case 'about':     return 'À propos';
    case 'contact':   return 'Contact';
    case 'privacy':   return 'Confidentialité';
    case 'terms':     return 'CGU';
    case 'changelog': return 'Changelog';
    case 'notfound':  return 'Page introuvable';
    default:          return 'WatchVerse';
  }
}

function broadcastTitleBarContext(rawRoute, params = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const route = normalizeRoute(rawRoute);
  const label = titleBarLabelFor(route, params);
  mainWindow.webContents.send('titlebar:context', { route, params, label });
}

function emitPresenceFromUrl(urlStr) {
  if (!rpcEnabled) return;
  const parsed = parseRouteFromUrl(urlStr);
  if (!parsed) return;

  if (lastRichPayload && lastRichPayload.route === parsed.route) {
    const richId = lastRichPayload.params?.id;
    const urlId  = parsed.params?.id;
    const idMatches = !richId || !urlId || String(richId) === String(urlId);
    if (idMatches) {
      const payload = getPresenceForRoute(lastRichPayload.route, lastRichPayload.params, { onlineCount });
      if (payload) updatePresence(payload);
      return;
    }
  }

  const payload = getPresenceForRoute(parsed.route, parsed.params || {}, { onlineCount });
  if (payload) updatePresence(payload);
}

function createWindow() {
  const icon = nativeImage.createFromPath(ICON_PATH);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon,
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'WatchVerse',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0f',
      symbolColor: '#9090a8',
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: isDev,
      backgroundThrottling: false,
    },
  });

  if (process.platform === 'win32') {
    mainWindow.setIcon(icon);
  }

  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = (input.key || '').toLowerCase();
      const blocked =
        key === 'f12' ||
        (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c')) ||
        (input.control && (key === 'u' || key === 's')) ||
        (input.meta    && input.alt   && key === 'i');
      if (blocked) event.preventDefault();
    });
    mainWindow.webContents.on('context-menu', e => e.preventDefault());
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const isOurSite = url.startsWith(TARGET_URL.replace(/\/$/, '')) ||
                      url.startsWith('http://localhost') ||
                      url.startsWith('http://192.168.');
    if (!isOurSite && url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  let lastSeenUrl = '';
  function checkUrl(reason) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    if (!url || url === lastSeenUrl) return;
    const prevUrl = lastSeenUrl;
    lastSeenUrl = url;
    const prevParsed = prevUrl ? parseRouteFromUrl(prevUrl) : null;
    const nextParsed = parseRouteFromUrl(url);
    const idChanged =
      !prevParsed || !nextParsed ||
      prevParsed.route !== nextParsed.route ||
      String(prevParsed.params?.id || '') !== String(nextParsed.params?.id || '');
    if (idChanged) lastRichPayload = null;
    console.log(`[Main] URL change (${reason}):`, url, idChanged ? '— cache cleared' : '— cache kept');
    if (/^https?:/i.test(url)) {
      const parsed = parseRouteFromUrl(url);
      if (parsed) broadcastTitleBarContext(parsed.route, parsed.params || {});
    }
    emitPresenceFromUrl(url);
  }
  mainWindow.webContents.on('did-navigate',         (_e, _url) => checkUrl('did-navigate'));
  mainWindow.webContents.on('did-navigate-in-page', (_e, _url) => checkUrl('did-navigate-in-page'));
  const pollId = setInterval(() => checkUrl('poll'), 1000);

  const OS_IDLE_THRESHOLD_S = 10 * 60;
  let wrapperIdle = false;
  const idlePollId = setInterval(() => {
    if (!rpcEnabled) return;
    if (!lastRichPayload) return;
    if (lastRichPayload.route !== 'player') return;
    let idleSeconds;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); }
    catch { return; }
    const shouldBeIdle = idleSeconds >= OS_IDLE_THRESHOLD_S;
    if (shouldBeIdle === wrapperIdle) return;
    wrapperIdle = shouldBeIdle;
    const merged = { ...lastRichPayload.params, idle: shouldBeIdle };
    lastRichPayload = { route: lastRichPayload.route, params: merged };
    const payload = getPresenceForRoute(lastRichPayload.route, merged, { onlineCount });
    if (payload) updatePresence(payload);
    console.log(`[Main] wrapper idle → ${shouldBeIdle} (${idleSeconds}s OS idle)`);
  }, 60_000);

  mainWindow.on('closed', () => {
    clearInterval(pollId);
    clearInterval(idlePollId);
    mainWindow = null;
  });

  const FONTS_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

  const SPLASH_HTML = `
    <html><head><meta charset="utf-8"><title>WatchVerse</title>
    ${FONTS_HEAD}
    <style>
      html,body{margin:0;height:100%;background:#0a0a0f;color:#f0f0f5;font-family:'Syne',system-ui,sans-serif}
      .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:24px}
      .logo{display:flex;align-items:center;gap:6px;font-weight:800;font-size:32px;letter-spacing:-1px}
      .logo .v{color:#e63946}
      .spinner{width:32px;height:32px;border:3px solid rgba(230,57,70,0.2);border-top-color:#e63946;border-radius:50%;animation:spin 0.8s linear infinite}
      .label{color:#5a5a72;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;font-family:'JetBrains Mono',ui-monospace,monospace}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style></head>
    <body><div class="wrap">
      <div class="logo"><span>Watch</span><span class="v">Verse</span></div>
      <div class="spinner"></div>
      <div class="label">Chargement…</div>
    </div></body></html>`;

  function buildErrorHtml(target, message) {
    const safeTarget = String(target || '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
    const safeMsg = String(message || '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
    const invite = process.env.WATCHVERSE_DISCORD_INVITE || 'https://discord.gg/EtFSEn39CE';
    return `
      <html><head><meta charset="utf-8"><title>WatchVerse — Erreur</title>
      ${FONTS_HEAD}
      <style>
        html,body{margin:0;height:100%;background:#0a0a0f;color:#f0f0f5;font-family:'Syne',system-ui,sans-serif}
        .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:18px;padding:24px;text-align:center;box-sizing:border-box}
        .logo{display:flex;align-items:center;gap:6px;font-weight:800;font-size:24px;letter-spacing:-1px;opacity:0.5;margin-bottom:8px}
        .logo .v{color:#e63946}
        h1{margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px}
        p{margin:0;color:#9090a8;font-size:14px;max-width:480px;line-height:1.5}
        code{background:#18181f;padding:2px 8px;border-radius:4px;font-size:12px;color:#fca5a5;font-family:'JetBrains Mono',ui-monospace,monospace}
        .err{background:#18181f;padding:8px 12px;border-radius:8px;font-size:12px;color:#ef4444;font-family:'JetBrains Mono',ui-monospace,monospace;max-width:560px;overflow-wrap:break-word;border:1px solid rgba(239,68,68,0.2)}
        .actions{display:flex;gap:12px;margin-top:8px}
        button{padding:10px 18px;border-radius:10px;border:none;font-weight:800;font-size:13px;cursor:pointer;transition:transform .1s;font-family:'Syne',system-ui,sans-serif;letter-spacing:0.02em;display:inline-flex;align-items:center;gap:7px}
        button:active{transform:scale(0.97)}
        .primary{background:#e63946;color:#fff}
        .secondary{background:#18181f;color:#f0f0f5;border:1px solid rgba(255,255,255,0.1)}
        .discord{background:#5865f2;color:#fff}
        .discord-prompt{margin-top:4px;color:#9090a8;font-size:13px}
      </style></head>
      <body><div class="wrap">
        <div class="logo"><span>Watch</span><span class="v">Verse</span></div>
        <h1>WatchVerse est injoignable</h1>
        <p>Impossible de charger <code>${safeTarget}</code>. Vérifie que le site est en ligne.</p>
        <div class="err">${safeMsg}</div>
        <p class="discord-prompt">Pour toute question, rejoins le Discord :</p>
        <div class="actions">
          <button class="primary" onclick="location.reload()">Réessayer</button>
          <button class="discord" onclick="window.open('${invite}','_blank')">Rejoindre</button>
          <button class="secondary" onclick="window.close()">Fermer</button>
        </div>
      </div></body></html>`;
  }

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));

  let didFinishOnce = false;
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return;
    if (/aborted/i.test(errorDesc || '')) return;
    if (validatedURL && validatedURL.startsWith('data:')) return;
    console.error('[Main] did-fail-load', errorCode, errorDesc, 'at', validatedURL);
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      buildErrorHtml(TARGET_URL, `${errorDesc} (${errorCode})`)
    ));
  });
  mainWindow.webContents.on('did-finish-load', () => { didFinishOnce = true; });

  setTimeout(() => {
    console.log('[Main] Loading', TARGET_URL);
    mainWindow.loadURL(TARGET_URL).catch(err => {
      console.error('[Main] loadURL rejected:', err.message);
      if (!didFinishOnce) {
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          buildErrorHtml(TARGET_URL, err.message)
        ));
      }
    });
  }, 250);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.on('second-instance', (_event, argv) => {
  const protoUrl = argv.find(a => typeof a === 'string' && a.startsWith('watchverse://'));
  if (protoUrl) navigateFromProtocolUrl(protoUrl);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  navigateFromProtocolUrl(url);
});

app.whenReady().then(async () => {
  cleanupStaleInstallers();

  await initRpc();
  createWindow();

  const coldStartProtoUrl = process.argv.find(a =>
    typeof a === 'string' && a.startsWith('watchverse://')
  );
  if (coldStartProtoUrl) {
    setTimeout(() => navigateFromProtocolUrl(coldStartProtoUrl), 500);
  }

  setTimeout(pollOnlineCount, 3000);
  setInterval(pollOnlineCount, 30000);

  if (!isDev) {
    setTimeout(() => checkForUpdates(mainWindow).catch(() => {}), 8000);
    setInterval(() => checkForUpdates(mainWindow).catch(() => {}), 4 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  clearPresence();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('presence:update', (_event, msg) => {
  if (!msg || typeof msg.route !== 'string') return;
  console.log('[Main] presence:update from page —', msg.route, JSON.stringify(msg.params));
  const route = normalizeRoute(msg.route);
  broadcastTitleBarContext(route, msg.params || {});
  if (!rpcEnabled) return;
  lastRichPayload = { route, params: msg.params || {} };
  const payload = getPresenceForRoute(route, msg.params || {}, { onlineCount });
  if (payload) updatePresence(payload);
});

ipcMain.on('presence:clear', () => {
  lastRichPayload = null;
  clearPresence();
});

ipcMain.on('presence:set-enabled', (_event, enabled) => {
  const next = !!enabled;
  if (next === rpcEnabled) return;
  rpcEnabled = next;
  console.log('[Main] RPC privacy →', rpcEnabled ? 'ENABLED' : 'DISABLED');
  if (!rpcEnabled) {
    lastRichPayload = null;
    clearPresence();
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const url = mainWindow.webContents.getURL();
    if (url) emitPresenceFromUrl(url);
  }
});
