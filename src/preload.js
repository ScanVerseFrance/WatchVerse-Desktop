/**
 * Bridge between the WatchVerse webview and the Electron main process.
 *
 * Exposes window.watchverse to the page (detect wrapper + push rich presence:
 * title, cover, episode, watch-party code…).
 *
 * Back-compat: WatchVerse forked from ScanVerse, whose site code checks
 * `window.scanverse?.isElectron` and calls window.scanverse.setPresence. We
 * ALSO expose the same object under `window.scanverse` so existing detection
 * keeps working until the site migrates. Both point at the same API.
 *
 * Also injects a Discord-style title bar (logo + page label + drag region),
 * leaving room on the right for the native min/max/close (titleBarOverlay).
 *
 * Only this minimal API is exposed — no fs, no shell, no node.
 */
const { contextBridge, ipcRenderer } = require('electron');

let WRAPPER_VERSION = '?.?.?';
try { WRAPPER_VERSION = require('../package.json').version || WRAPPER_VERSION; } catch {}

const wvBridge = {
  isElectron: true,
  app: 'watchverse',
  version: WRAPPER_VERSION,
  setPresence(route, params = {}) {
    if (typeof route !== 'string') return;
    console.log('[watchverse:preload] setPresence', route, params);
    ipcRenderer.send('presence:update', { route, params });
  },
  clearPresence() {
    ipcRenderer.send('presence:clear');
  },
  setRpcEnabled(enabled) {
    ipcRenderer.send('presence:set-enabled', !!enabled);
  },
};

contextBridge.exposeInMainWorld('watchverse', wvBridge);
// Back-compat alias — the forked ScanVerse site code reads window.scanverse.
contextBridge.exposeInMainWorld('scanverse', wvBridge);

window.addEventListener('DOMContentLoaded', () => {
  console.log('[watchverse:preload] bridge ready, window.watchverse is available');
  try {
    const disabled =
      localStorage.getItem('wv_discord_rpc_disabled') === '1' ||
      localStorage.getItem('sv_discord_rpc_disabled') === '1';
    ipcRenderer.send('presence:set-enabled', !disabled);
  } catch { /* localStorage may be blocked */ }

  injectTitleBar();
});

// ──────────────────────────────────────────────────────────────────────────
// Custom title bar
// ──────────────────────────────────────────────────────────────────────────

const TITLE_BAR_HEIGHT = 32; // mirrors titleBarOverlay.height in main.js

try {
  document.documentElement.style.setProperty('--wv-titlebar-height', `${TITLE_BAR_HEIGHT}px`);
  document.documentElement.style.setProperty('--sv-titlebar-height', `${TITLE_BAR_HEIGHT}px`);
} catch { /* document not ready */ }

const NATIVE_CONTROLS_RESERVE = 150;

function injectTitleBar() {
  if (document.getElementById('wv-titlebar')) return;

  const style = document.createElement('style');
  style.id = 'wv-titlebar-style';
  style.textContent = `
    body { padding-top: ${TITLE_BAR_HEIGHT}px !important; }

    #wv-titlebar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: ${TITLE_BAR_HEIGHT}px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 ${NATIVE_CONTROLS_RESERVE}px 0 12px;
      background: #0a0a0f;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      font-family: 'Syne', system-ui, -apple-system, Segoe UI, sans-serif;
      color: #f0f0f5;
      user-select: none;
      -webkit-user-select: none;
      -webkit-app-region: drag;
    }
    #wv-titlebar .wv-tb-no-drag { -webkit-app-region: no-drag; }
    #wv-titlebar .wv-tb-logo {
      display: inline-flex; align-items: baseline; gap: 1px;
      font-weight: 800; font-size: 13px; letter-spacing: -0.3px;
      color: #f0f0f5; flex-shrink: 0;
    }
    #wv-titlebar .wv-tb-logo .accent { color: #e63946; }
    #wv-titlebar .wv-tb-divider {
      width: 1px; height: 14px; background: rgba(255,255,255,0.1); flex-shrink: 0;
    }
    #wv-titlebar .wv-tb-context {
      flex: 1; min-width: 0; font-size: 12px; font-weight: 500; color: #9090a8;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #wv-titlebar .wv-tb-context strong { color: #f0f0f5; font-weight: 600; }
    #wv-titlebar .wv-tb-version {
      flex-shrink: 0; font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px; font-weight: 600; letter-spacing: 0.4px; color: #5a5a72;
      padding: 3px 7px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.02);
      text-transform: lowercase;
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'wv-titlebar';
  bar.innerHTML = `
    <span class="wv-tb-logo">Watch<span class="accent">Verse</span></span>
    <span class="wv-tb-divider"></span>
    <span class="wv-tb-context" id="wv-tb-context">Accueil</span>
    <span class="wv-tb-version" id="wv-tb-version" title="Version de l'application"></span>
  `;
  document.body.appendChild(bar);

  const verEl = document.getElementById('wv-tb-version');
  if (verEl) {
    if (WRAPPER_VERSION && WRAPPER_VERSION !== '?.?.?') verEl.textContent = 'v' + WRAPPER_VERSION;
    else verEl.style.display = 'none';
  }
}

ipcRenderer.on('titlebar:context', (_event, msg) => {
  const ctx = document.getElementById('wv-tb-context');
  if (!ctx || !msg) return;
  ctx.textContent = msg.label || 'WatchVerse';
});

// ──────────────────────────────────────────────────────────────────────────
// Shift fixed top-pinned elements below the injected title bar.
// ──────────────────────────────────────────────────────────────────────────

function shiftElementIfNeeded(el) {
  if (!el || el.nodeType !== 1) return;
  if (el.id === 'wv-titlebar') return;
  if (el.dataset.wvTopShifted === '1') return;
  if (!document.body || !document.body.contains(el)) return;
  const cs = getComputedStyle(el);
  if (cs.position !== 'fixed') return;
  const top = parseFloat(cs.top);
  if (!Number.isFinite(top)) return;
  if (top >= TITLE_BAR_HEIGHT) return;
  // Leave full-screen overlays (top:0;bottom:0) alone — e.g. the video player.
  if (el.offsetHeight > 0 && el.offsetHeight > 200 && parseFloat(cs.bottom) === 0) return;
  el.dataset.wvTopShifted = '1';
  el.dataset.wvOriginalTop = String(top);
  el.style.setProperty('top', `${top + TITLE_BAR_HEIGHT}px`, 'important');
}

function scanAndShiftFixedElements() {
  if (!document.body) return;
  const candidates = document.querySelectorAll(
    'nav, header, aside, [role="banner"], [role="navigation"], [style*="fixed"], [class*="fixed"]'
  );
  candidates.forEach(shiftElementIfNeeded);
}

function startTopFixedShifter() {
  scanAndShiftFixedElements();
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1) shiftElementIfNeeded(n);
      } else if (m.type === 'attributes' && (m.attributeName === 'style' || m.attributeName === 'class')) {
        const el = m.target;
        if (!(el.dataset && el.dataset.wvTopShifted === '1')) shiftElementIfNeeded(el);
      }
    }
  });
  obs.observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
  });
  setTimeout(scanAndShiftFixedElements, 500);
  setTimeout(scanAndShiftFixedElements, 1500);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startTopFixedShifter);
} else {
  startTopFixedShifter();
}
