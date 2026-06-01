// Two-stage build for the WatchVerse Setup .exe.
//   1. Build the main WatchVerse desktop app in --dir mode (no installer
//      wrapping). Output: dist/win-unpacked/ — the actual app the user
//      will run after install.
//   2. Copy that win-unpacked tree into installer/payload/ so the next
//      electron-builder pass picks it up via extraResources, then build
//      the installer itself as a single portable .exe.
//
// Output: dist/WatchVerse-Setup-X.Y.Z.exe (signed, branded, frameless UI)
//
// Run with: npm run build:setup
const path = require('path');
const fs   = require('fs');
const fsp  = fs.promises;
const { spawnSync } = require('child_process');

const ROOT       = path.resolve(__dirname, '..');
const DIST       = path.join(ROOT, 'dist');
const APP_OUT    = path.join(DIST, 'win-unpacked');           // main app, --dir output
const PAYLOAD_DIR = path.join(ROOT, 'installer', 'payload');  // copied into installer/

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(' ')} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}

async function rmrf(p) {
  if (!fs.existsSync(p)) return;
  await fsp.rm(p, { recursive: true, force: true });
}

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else                 await fsp.copyFile(s, d);
  }
}

(async () => {
  console.log('━━━ WatchVerse Setup builder ━━━');

  // 1) Build the main desktop app in --dir mode.
  console.log('\n[1/3] Build main WatchVerse app (--dir)…');
  await rmrf(APP_OUT);
  run('npx', ['electron-builder', '--win', '--dir']);
  if (!fs.existsSync(APP_OUT)) {
    console.error('✗ dist/win-unpacked/ missing after main build');
    process.exit(1);
  }

  // 2) Stage payload for the installer.
  console.log('\n[2/3] Stage payload for installer…');
  await rmrf(PAYLOAD_DIR);
  await copyDir(APP_OUT, PAYLOAD_DIR);
  console.log(`  ✓ ${PAYLOAD_DIR}`);

  // 3) Build the installer with its own builder config.
  console.log('\n[3/3] Build installer .exe…');
  run('npx', [
    'electron-builder',
    '--config', 'electron-builder.installer.json',
    '--win',
  ]);

  // Cleanup: payload is huge, no need to keep it after the .exe is built.
  await rmrf(PAYLOAD_DIR);
  console.log('\n✓ Setup ready in dist/');
})();
