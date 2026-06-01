/**
 * WatchVerse Setup — custom Electron installer.
 *
 * This is a separate mini-Electron app whose only job is to deploy the
 * actual WatchVerse desktop app onto the user's machine. Replaces the
 * default NSIS wizard so we can render the install flow with the same
 * design tokens as the rest of WatchVerse (dark + red, Syne typeface,
 * animated accents) instead of generic Win32 controls.
 *
 * Bundle layout when packed:
 *   process.resourcesPath/
 *     ├── app.asar              ← this installer's main+preload+ui
 *     └── payload/              ← the actual WatchVerse app bytes
 *         └── (win-unpacked/)
 *
 * On install:
 *   1. User picks an install path (default %LOCALAPPDATA%\Programs\WatchVerse).
 *   2. We copy `payload/` into that path.
 *   3. We register an uninstall key in HKCU so Apps & features lists WatchVerse.
 *   4. We create Start Menu + Desktop shortcuts via PowerShell.
 *   5. Optionally launch the app and quit the installer.
 *
 * Uninstall is handled by a separate `uninstall.exe` — for v1 we ship the
 * "Apps & features" entry pointing at a small `Uninstall.cmd` we drop in
 * the install folder. Good enough for closed beta.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
// `original-fs` is Electron's unpatched fs. Regular `fs` treats `.asar` files
// as directories (so you can require() into them), which is *terrible* when
// you want to copy them byte-for-byte during install — readdir() walks into
// the archive contents and copyFile() chokes with ENOENT on the virtual
// entries. We use ofs strictly for the payload copy.
const ofs  = require('original-fs');
const ofsp = ofs.promises;
const { spawn, execFile } = require('child_process');
const os = require('os');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.watchverse.installer');
}

// ── Silent mode detection ────────────────────────────────────────────────────
// When the running WatchVerse app downloads an update and wants to apply it
// without bothering the user, it spawns this installer with
//   WatchVerse-Setup-X.Y.Z.exe --silent --install-path <existing-install-dir>
// In that mode we skip the wizard UI entirely, kill the old app process,
// overwrite the install dir in place, then relaunch WatchVerse.
function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return null;
}
const IS_SILENT = process.argv.includes('--silent');
const SILENT_INSTALL_PATH = getArg('install-path');

// Single-instance: don't let two installer windows run at once.
// Silent mode skips the lock — the calling WatchVerse already quit, but the
// portable launcher mechanism may briefly overlap during update self-extract.
const lock = IS_SILENT ? true : app.requestSingleInstanceLock();
if (!lock) { app.quit(); }

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// ── Paths ────────────────────────────────────────────────────────────────────
// In dev (electron .) the payload sits next to this script under ./payload.
// In packed builds electron-builder unpacks it under resourcesPath/payload.
function resolvePayloadPath() {
  const packed = path.join(process.resourcesPath || '', 'payload');
  if (fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, 'payload');
  if (fs.existsSync(dev)) return dev;
  return null;
}

const DEFAULT_INSTALL_DIR = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'Programs', 'WatchVerse',
);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 520,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: true,
    backgroundColor: '#0a0a0f',
    title: 'Installation de WatchVerse',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    frame: false,                  // we paint our own titlebar in HTML
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (process.env.WATCHVERSE_INSTALLER_DEV) win.webContents.openDevTools({ mode: 'detach' });
}

if (IS_SILENT) {
  app.whenReady().then(runSilentInstall);
} else {
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => app.quit());

// ── Silent install path ──────────────────────────────────────────────────────
// Headless update — invoked by the running WatchVerse app via:
//   spawn(setupExe, ['--silent', '--install-path', <existingDir>])
// Steps:
//   1. Wait a beat for the calling process to die so file locks release.
//   2. taskkill any leftover WatchVerse.exe just in case.
//   3. Overwrite-copy the payload over the existing install (no clean —
//      orphan files from old versions will linger, that's fine).
//   4. Re-write the uninstaller + uninstall registry key with the new
//      version string.
//   5. Launch the new WatchVerse.exe and quit.
//
// All of this runs without UI. Errors go to %TEMP%/watchverse-installer.log
// where the user can find them if something breaks.
async function runSilentInstall() {
  const installPath = SILENT_INSTALL_PATH || DEFAULT_INSTALL_DIR;
  const logPath = path.join(os.tmpdir(), 'watchverse-installer.log');
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] [silent] ${msg}\n`;
    return fsp.appendFile(logPath, line).catch(() => {});
  };

  await log(`Start. installPath=${installPath} pid=${process.pid}`);
  try {
    // 1. Let the caller's process clean up (file handles release).
    await sleep(2000);

    // 2. Force-kill any stale WatchVerse.exe (caller should have quit
    //    already, but if it crashed mid-quit we need files unlocked).
    await new Promise(resolve => {
      execFile('taskkill', ['/IM', 'WatchVerse.exe', '/F', '/T'],
        { windowsHide: true }, () => resolve());
    });
    await sleep(800);

    const payload = resolvePayloadPath();
    if (!payload) {
      await log('ABORT: payload not found');
      app.quit();
      return;
    }

    // 3. Overwrite-copy the payload. We deliberately skip ensureCleanDir —
    //    in update mode we want to preserve any user-side files in the
    //    install dir (cache etc.) and just replace the binaries.
    await ofsp.mkdir(installPath, { recursive: true });
    await copyDir(payload, installPath, () => {});
    await log(`Copy done`);

    // 4. Refresh uninstaller + registry with the new version.
    await writeUninstaller(installPath);
    const exePath = path.join(installPath, 'WatchVerse.exe');
    await registerUninstall(installPath, exePath);
    await log(`Registry refreshed`);

    // 5. Launch the new app, detached.
    if (fs.existsSync(exePath)) {
      spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
      await log(`Launched ${exePath}`);
    } else {
      await log(`ERROR: ${exePath} missing after copy`);
    }
  } catch (err) {
    await log(`FAIL: ${err && (err.stack || err.message || err)}`);
  } finally {
    // Give the spawned WatchVerse a moment to take over before we exit.
    setTimeout(() => app.quit(), 500);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Force-kill toute instance de WatchVerse.exe (PAS l'installeur, qui s'appelle
// "WatchVerse Setup"/"WatchVerse-Setup-x.y.z"). Indispensable AVANT d'écraser
// une install existante : un .exe/.dll en cours d'exécution est verrouillé, et
// rm/copyFile échoue dessus → l'install entière avortait quand l'ancienne 0.1.0
// tournait encore (bug user 2026-06-02 « ça ne remplace pas les fichiers »).
function killRunningApp() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    execFile('taskkill', ['/IM', 'WatchVerse.exe', '/F', '/T'],
      { windowsHide: true }, () => setTimeout(resolve, 700));
  });
}

// copyFile résilient : retry sur EBUSY/EPERM (fichier brièvement verrouillé,
// p.ex. juste après le taskkill). Sans ça, un seul fichier encore tenu faisait
// échouer toute la copie.
async function copyFileRetry(src, dst) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await ofsp.copyFile(src, dst); return; }
    catch (err) {
      if (attempt === 3) throw err;
      await sleep(350);
    }
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────
// Renderer asks for default path / picks a folder / kicks off install.

ipcMain.handle('installer:default-path', () => DEFAULT_INSTALL_DIR);

ipcMain.handle('installer:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir le dossier d\'installation',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: DEFAULT_INSTALL_DIR,
  });
  if (r.canceled || !r.filePaths[0]) return null;
  // We always append "WatchVerse" so the user doesn't accidentally install
  // into a populated directory. Skip the append if the leaf already is it.
  let target = r.filePaths[0];
  if (path.basename(target).toLowerCase() !== 'watchverse') {
    target = path.join(target, 'WatchVerse');
  }
  return target;
});

ipcMain.handle('installer:install', async (_event, opts = {}) => {
  const installPath = String(opts.installPath || DEFAULT_INSTALL_DIR);
  const createDesktop  = opts.createDesktop !== false;
  const createStartMenu = opts.createStartMenu !== false;
  const launchAfter     = opts.launchAfter !== false;

  const payload = resolvePayloadPath();
  if (!payload) {
    return { ok: false, error: 'payload introuvable (build incomplet ?)' };
  }

  try {
    // 0. Tuer toute instance en cours AVANT d'écraser : sinon les binaires
    //    verrouillés (app 0.1.0 ouverte) font échouer rm/copyFile et l'install
    //    n'écrase rien (bug user 2026-06-02). Le chemin silent le faisait déjà ;
    //    le chemin UI (install manuelle par-dessus) ne le faisait pas.
    win.webContents.send('installer:progress', { phase: 'copy', cur: 0, total: 1 });
    await killRunningApp();

    // 1. Copy the payload into the install path.
    await ensureCleanDir(installPath);
    await copyDir(payload, installPath, (cur, total) => {
      win.webContents.send('installer:progress', { phase: 'copy', cur, total });
    });

    const exePath = path.join(installPath, 'WatchVerse.exe');
    if (!fs.existsSync(exePath)) {
      return { ok: false, error: `WatchVerse.exe manquant dans ${installPath}` };
    }

    // 2. Drop a small Uninstall.cmd that wipes the install folder + registry.
    await writeUninstaller(installPath);

    // 3. Register in Apps & features (HKCU so we don't need admin).
    win.webContents.send('installer:progress', { phase: 'registry' });
    await registerUninstall(installPath, exePath);

    // 4. Shortcuts.
    win.webContents.send('installer:progress', { phase: 'shortcuts' });
    if (createStartMenu) {
      await createShortcut({
        target: exePath,
        location: path.join(
          process.env.APPDATA || os.homedir(),
          'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WatchVerse.lnk',
        ),
      });
    }
    if (createDesktop) {
      await createShortcut({
        target: exePath,
        location: path.join(
          os.homedir(), 'Desktop', 'WatchVerse.lnk',
        ),
      });
    }

    // 5. Launch (optional) + quit installer.
    if (launchAfter) {
      spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
    }

    return { ok: true, installPath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.on('installer:close',    () => app.quit());
ipcMain.on('installer:minimize', () => win?.minimize());
ipcMain.on('installer:open-url', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureCleanDir(dir) {
  await ofsp.mkdir(dir, { recursive: true });
  // If the dir already has files (re-install over previous version), wipe
  // them — safer than merging since old versions may have stale files.
  // BEST-EFFORT : un fichier encore verrouillé NE DOIT PAS faire échouer toute
  // l'install (copyDir réécrit par-dessus de toute façon). On retente quelques
  // fois pour les fichiers tout juste libérés par killRunningApp, puis on
  // continue quoi qu'il arrive. (Avant : un seul rm en échec avortait tout →
  // « ça ne remplace pas la 0.1.0 ».)
  let existing = [];
  try { existing = await ofsp.readdir(dir); } catch { return; }
  for (const name of existing) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await ofsp.rm(path.join(dir, name), { recursive: true, force: true }); break; }
      catch { await sleep(300); }
    }
  }
}

async function copyDir(src, dst, onProgress) {
  // Two passes: first count files for an accurate progress bar, then copy.
  // ALL fs ops go through original-fs because the source tree contains
  // `resources/app.asar` (the main WatchVerse app bundled as an asar), and
  // patched fs would walk *into* that archive and try to copy its virtual
  // contents as if they were on disk. ofs treats it as a single file blob.
  let total = 0;
  let cur   = 0;
  async function count(p) {
    const entries = await ofsp.readdir(p, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) await count(full);
      else total++;
    }
  }
  await count(src);
  if (onProgress) onProgress(0, total);

  async function walk(srcDir, dstDir) {
    await ofsp.mkdir(dstDir, { recursive: true });
    const entries = await ofsp.readdir(srcDir, { withFileTypes: true });
    for (const e of entries) {
      const sFull = path.join(srcDir, e.name);
      const dFull = path.join(dstDir, e.name);
      if (e.isDirectory()) {
        await walk(sFull, dFull);
      } else {
        await copyFileRetry(sFull, dFull);
        cur++;
        if (onProgress && (cur % 8 === 0 || cur === total)) onProgress(cur, total);
      }
    }
  }
  await walk(src, dst);
}

async function writeUninstaller(installPath) {
  // Désinstallateur PowerShell — SILENCIEUX (aucune fenêtre) et FIABLE.
  //
  // Pourquoi PowerShell et plus le .cmd : l'ancien Uninstall.cmd vivait DANS le
  // dossier qu'il devait supprimer. Un .cmd en cours d'exécution garde son
  // propre fichier ouvert (cmd lit ligne par ligne) → `rmdir /s /q <dir>` ne
  // pouvait pas effacer le dossier (fichier verrouillé) → fenêtre CMD visible +
  // dossier résiduel (bug user 2026-06-02 « ça ouvre juste un CMD, ça bug »).
  //
  // PowerShell parse TOUT le script en mémoire au lancement (il ne garde pas le
  // .ps1 ouvert pendant l'exécution) ET on se recopie d'abord dans %TEMP% puis
  // on relance caché : la copie temp peut donc effacer la TOTALITÉ du dossier
  // d'install, y compris le Uninstall.ps1 d'origine. Zéro résidu, zéro fenêtre.
  const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WatchVerse';
  const ps = `# WatchVerse - desinstallateur silencieux (genere par l'installeur).
param([switch]$Relocated)
$ErrorActionPreference = 'SilentlyContinue'
$installPath = '${installPath.replace(/'/g, "''")}'

if (-not $Relocated) {
  # Se recopier dans %TEMP% et relancer cache, pour pouvoir supprimer le dossier
  # d'install en entier (script d'origine inclus).
  $tmp = Join-Path $env:TEMP 'WatchVerse-Uninstall.ps1'
  Copy-Item -LiteralPath $PSCommandPath -Destination $tmp -Force
  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $tmp + '"'),'-Relocated'
  return
}

Start-Sleep -Milliseconds 600
Stop-Process -Name 'WatchVerse' -Force
Start-Sleep -Seconds 1
reg delete '${regKey}' /f | Out-Null
Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\WatchVerse.lnk') -Force
Remove-Item -LiteralPath (Join-Path $env:USERPROFILE 'Desktop\\WatchVerse.lnk') -Force
# Suppression du dossier avec retries (un AV/indexeur peut tenir un fichier une
# fraction de seconde apres le kill).
for ($i = 0; $i -lt 6; $i++) {
  Remove-Item -LiteralPath $installPath -Recurse -Force
  if (-not (Test-Path -LiteralPath $installPath)) { break }
  Start-Sleep -Milliseconds 500
}
# Auto-suppression de la copie temporaire.
Remove-Item -LiteralPath $PSCommandPath -Force
`;
  await fsp.writeFile(path.join(installPath, 'Uninstall.ps1'), ps, 'utf8');
  // Nettoyage d'un éventuel ancien Uninstall.cmd (install <= 0.1.2) pour ne pas
  // laisser traîner le désinstallateur cassé à côté du nouveau.
  await fsp.rm(path.join(installPath, 'Uninstall.cmd'), { force: true }).catch(() => {});
}

function registerUninstall(installPath, exePath) {
  return new Promise((resolve, reject) => {
    // We use reg.exe directly — no extra deps, no permissions surprise.
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WatchVerse';
    // Désinstallation via PowerShell caché (cf. writeUninstaller) — plus de
    // fenêtre CMD, et le dossier d'install est réellement supprimé en entier.
    const ps1 = path.join(installPath, 'Uninstall.ps1');
    const uninstallCmd = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}"`;
    const sets = [
      ['DisplayName', 'WatchVerse'],
      ['DisplayVersion', require('./package.json').version],
      ['Publisher', 'Team WatchVerse'],
      ['DisplayIcon', exePath],
      ['InstallLocation', installPath],
      ['UninstallString', uninstallCmd],
      ['QuietUninstallString', uninstallCmd],
      ['NoModify', '1', 'REG_DWORD'],
      ['NoRepair', '1', 'REG_DWORD'],
      ['EstimatedSize', String(48 * 1024), 'REG_DWORD'], // ~48 MB key (KB units)
    ];
    let i = 0;
    function next() {
      if (i >= sets.length) return resolve();
      const [name, value, type = 'REG_SZ'] = sets[i++];
      execFile('reg', ['add', key, '/v', name, '/t', type, '/d', value, '/f'],
        { windowsHide: true }, (err) => err ? reject(err) : next());
    }
    next();
  });
}

function createShortcut({ target, location }) {
  // PowerShell one-liner is the cheapest way to create a .lnk without a
  // native module. Hides the working dir = install dir so the app starts
  // from a sane place.
  return new Promise((resolve) => {
    const wd = path.dirname(target);
    const ps = [
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${location.replace(/'/g, "''")}');`,
      `$s.TargetPath = '${target.replace(/'/g, "''")}';`,
      `$s.WorkingDirectory = '${wd.replace(/'/g, "''")}';`,
      `$s.IconLocation = '${target.replace(/'/g, "''")},0';`,
      `$s.Save()`,
    ].join(' ');
    execFile('powershell', ['-NoProfile', '-Command', ps],
      { windowsHide: true }, () => resolve());
  });
}
