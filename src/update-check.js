/**
 * WatchVerse — in-app update orchestrator (RPCS3-style flow).
 *
 * 1. On startup: fetch latest release from GitHub Releases API, compare
 *    against installed version. If newer → spawn a custom branded modal
 *    BrowserWindow (src/update-ui/) so the user sees a WatchVerse-skinned
 *    prompt rather than the OS's `dialog.showMessageBox` (which is ugly,
 *    can't be styled, and looks foreign next to the rest of the app).
 *
 * 2. User clicks "Télécharger" in the modal:
 *    - We fetch the .exe asset directly into the OS temp dir, streaming so
 *      the 265 MB doesn't sit in RAM. Progress is reported back to the
 *      modal via IPC at ~10 Hz.
 *    - Cancel-friendly via AbortController — closing the modal mid-download
 *      cleanly aborts the fetch.
 *
 * 3. User clicks "Redémarrer" on the "ready" screen:
 *    - We spawn the downloaded installer with `--silent --install-path X`
 *      (where X is the current WatchVerse install dir, taken from
 *      `process.execPath`). The custom installer (installer/main.js) has
 *      a parallel code path that runs without UI when `--silent` is set:
 *      taskkill old app → copyDir over the existing install → re-register
 *      uninstall key → launch the new WatchVerse.exe.
 *    - We immediately call `app.quit()` so file locks release before the
 *      installer starts copying. The 2 s sleep on the installer side gives
 *      the OS a beat to actually clean up the process.
 *
 * Failure modes:
 *   - No network / API rate-limit → silent skip, retry next launch.
 *   - Modal closed mid-download → abort, throw away partial file, no harm.
 *   - Silent install fails → see %TEMP%/watchverse-installer.log. The old
 *     app is gone at that point (we already called quit), so user re-runs
 *     the installer manually from the start menu. Recoverable.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// TODO(confirm): create this repo (or point at your real one). Until a
// release with a Setup .exe exists, the update check is a graceful no-op.
const REPO = process.env.WATCHVERSE_DESKTOP_REPO || 'WatchVerseFrance/WatchVerse-Desktop';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

// ── Module state ─────────────────────────────────────────────────────────
let updateWindow = null;
let downloadAbort = null;
let downloadedExePath = null;
// Most recent release info — we cache it so the modal can re-request after
// did-finish-load without us having to refetch the GitHub API.
let cachedRelease = null;
// Once registered, IPC handlers stay bound for the app lifetime. Guard
// against double-registration if checkForUpdates is called twice.
let ipcRegistered = false;

// Plain X.Y.Z compare. We don't ship pre-release tags so this is enough.
function isNewer(latest, current) {
  const [la = 0, lb = 0, lc = 0] = String(latest).split('.').map(n => parseInt(n, 10) || 0);
  const [ca = 0, cb = 0, cc = 0] = String(current).split('.').map(n => parseInt(n, 10) || 0);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

async function fetchLatestRelease() {
  // 6-second timeout — don't block startup if GitHub is slow.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(RELEASES_API, {
      headers: {
        'User-Agent': `WatchVerse-Desktop/${app.getVersion()}`,
        'Accept': 'application/vnd.github+json',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Modal window ─────────────────────────────────────────────────────────
function showUpdateWindow(parent) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus();
    return;
  }
  updateWindow = new BrowserWindow({
    width: 520,
    height: 380,
    parent: parent || undefined,
    // Modal: blocks input on the parent until dismissed. Keeps the user's
    // attention on the update flow and avoids weird states like clicking
    // through to the manga reader mid-download.
    modal: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0a0a0f',
    title: 'WatchVerse — Mise à jour',
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: false,
    },
  });
  updateWindow.loadFile(path.join(__dirname, 'update-ui', 'index.html'));
  updateWindow.on('closed', () => {
    updateWindow = null;
    // Cancel any in-flight download — no point finishing if the UI is gone.
    if (downloadAbort) { try { downloadAbort.abort(); } catch {} downloadAbort = null; }
  });
  updateWindow.webContents.once('did-finish-load', () => {
    updateWindow?.webContents.send('update:info', {
      latest: cachedRelease.latest,
      current: cachedRelease.current,
      assetName: cachedRelease.asset.name,
      assetSize: cachedRelease.asset.size,
    });
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────────
function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  // Renderer wants to re-request the info payload (e.g. after a soft reload).
  ipcMain.handle('update:get-info', () => {
    if (!cachedRelease) return null;
    return {
      latest: cachedRelease.latest,
      current: cachedRelease.current,
      assetName: cachedRelease.asset.name,
      assetSize: cachedRelease.asset.size,
    };
  });

  ipcMain.handle('update:download', async () => {
    if (!cachedRelease) return { ok: false, error: 'No release info' };
    const { asset, latest } = cachedRelease;
    const tmpPath = path.join(os.tmpdir(), `WatchVerse-Setup-${latest}.exe`);

    // Clean up any previous partial download.
    try { fs.unlinkSync(tmpPath); } catch {}

    downloadAbort = new AbortController();
    try {
      const res = await fetch(asset.browser_download_url, {
        signal: downloadAbort.signal,
        // GitHub redirects to a CDN — fetch follows redirects by default.
      });
      if (!res.ok || !res.body) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const total = parseInt(res.headers.get('content-length') || String(asset.size || 0), 10);
      const writer = fs.createWriteStream(tmpPath);
      const reader = res.body.getReader();
      let downloaded = 0;
      let lastEmit = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await new Promise((resolve, reject) => {
          writer.write(Buffer.from(value), err => err ? reject(err) : resolve());
        });
        downloaded += value.length;
        // Throttle progress events to ~10 Hz to keep IPC traffic light.
        const now = Date.now();
        if (now - lastEmit > 100) {
          updateWindow?.webContents.send('update:progress', { downloaded, total });
          lastEmit = now;
        }
      }
      // Final flush + ensure 100% reaches the renderer.
      await new Promise((resolve, reject) => writer.end(err => err ? reject(err) : resolve()));
      updateWindow?.webContents.send('update:progress', { downloaded: total || downloaded, total: total || downloaded });

      downloadedExePath = tmpPath;
      return { ok: true };
    } catch (err) {
      // AbortError fires when the user closes the modal mid-download.
      if (err.name === 'AbortError') return { ok: false, aborted: true };
      console.error('[Update] download failed:', err);
      return { ok: false, error: err.message || String(err) };
    } finally {
      downloadAbort = null;
    }
  });

  // User clicked "Restart now" on the ready screen. Hand the installer the
  // current install dir (so it overwrites in place) and quit ourselves.
  ipcMain.on('update:apply', () => {
    if (!downloadedExePath || !fs.existsSync(downloadedExePath)) return;
    // process.execPath = path/to/WatchVerse.exe in the install dir.
    // dirname is the install root that the installer will overwrite.
    const installPath = path.dirname(process.execPath);
    try {
      const child = spawn(downloadedExePath, ['--silent', '--install-path', installPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (err) {
      console.error('[Update] failed to spawn silent installer:', err);
      return;
    }
    // Give the spawn a beat to actually start before we yank the rug.
    setTimeout(() => app.quit(), 250);
  });

  // User dismissed the modal at any state.
  ipcMain.on('update:close', () => {
    if (downloadAbort) { try { downloadAbort.abort(); } catch {} }
    if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
  });

  // "Open in browser" fallback — used if the renderer wants to send the
  // user to the GitHub release page (e.g. error states).
  ipcMain.on('update:open-release', () => {
    shell.openExternal(RELEASES_PAGE).catch(() => {});
  });
}

/**
 * Public entry point — call once on startup, after `app.whenReady`.
 *
 * @param {BrowserWindow|null} parent — optional parent for the modal.
 */
async function checkForUpdates(parent) {
  registerIpc();

  const release = await fetchLatestRelease();
  if (!release || !release.tag_name) {
    console.log('[Update] no release feed (yet) — skipping');
    return;
  }
  if (release.draft || release.prerelease) {
    console.log('[Update] latest release is draft/prerelease — skipping');
    return;
  }

  const latest = release.tag_name.replace(/^v/i, '');
  const current = app.getVersion();
  console.log(`[Update] current=${current}, latest=${latest}`);
  if (!isNewer(latest, current)) return;

  const asset = (release.assets || []).find(a => /Setup.*\.exe$/i.test(a.name));
  if (!asset) {
    console.log('[Update] release has no Setup.exe asset — skipping');
    return;
  }

  cachedRelease = { latest, current, asset };
  showUpdateWindow(parent);
}

module.exports = { checkForUpdates };
