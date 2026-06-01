// Wizard navigation + IPC glue. Keeps the install flow as a tiny state
// machine: pages = ['welcome', 'license', 'path', 'progress', 'done', 'error'].
const pages = Array.from(document.querySelectorAll('.page'));
function show(name) {
  for (const p of pages) p.classList.toggle('active', p.dataset.page === name);
}

// ── Titlebar buttons ────────────────────────────────────────────────────────
document.getElementById('tb-min').addEventListener('click', () => window.installer.minimize());
document.getElementById('tb-close').addEventListener('click', () => window.installer.close());

// ── Site link on the welcome page ───────────────────────────────────────────
for (const el of document.querySelectorAll('[data-link]')) {
  el.addEventListener('click', () => window.installer.openUrl(el.dataset.link));
}

// ── Page transitions ────────────────────────────────────────────────────────
// Welcome → License → Path → Progress → Done/Error
const flow = ['welcome', 'license', 'path'];
function indexOfActive() {
  return pages.findIndex(p => p.classList.contains('active'));
}
for (const el of document.querySelectorAll('[data-next]')) {
  el.addEventListener('click', () => {
    const cur = pages[indexOfActive()].dataset.page;
    const next = flow[flow.indexOf(cur) + 1];
    if (next) show(next);
  });
}
for (const el of document.querySelectorAll('[data-back]')) {
  el.addEventListener('click', () => {
    const cur = pages[indexOfActive()].dataset.page;
    const prev = flow[flow.indexOf(cur) - 1];
    if (prev) show(prev);
  });
}

// ── License agreement gate ──────────────────────────────────────────────────
const cb = document.getElementById('agree-cb');
const licenseNext = document.getElementById('license-next');
cb.addEventListener('change', () => { licenseNext.disabled = !cb.checked; });

// ── Install path ────────────────────────────────────────────────────────────
const pathInput = document.getElementById('path-input');
window.installer.defaultPath().then(p => { pathInput.value = p; });
document.getElementById('path-pick').addEventListener('click', async () => {
  const next = await window.installer.pickFolder();
  if (next) pathInput.value = next;
});

// ── Install ─────────────────────────────────────────────────────────────────
const installBtn = document.getElementById('install-btn');
installBtn.addEventListener('click', async () => {
  show('progress');
  startProgressListener();
  const r = await window.installer.install({
    installPath: pathInput.value,
    createDesktop:  document.getElementById('opt-desktop').checked,
    createStartMenu: document.getElementById('opt-startmenu').checked,
    launchAfter:    document.getElementById('opt-launch').checked,
  });
  stopProgressListener();
  if (r?.ok) {
    document.getElementById('done-msg').textContent =
      `WatchVerse a été installé dans ${r.installPath}. Tu peux fermer cette fenêtre.`;
    show('done');
  } else {
    document.getElementById('error-msg').textContent =
      r?.error || 'Une erreur inconnue est survenue.';
    show('error');
  }
});

// ── Progress listener ───────────────────────────────────────────────────────
const bar     = document.getElementById('progress-bar');
const phase   = document.getElementById('progress-phase');
const detail  = document.getElementById('progress-detail');
let progressUnsub = null;
function startProgressListener() {
  progressUnsub = window.installer.onProgress(({ phase: ph, cur, total }) => {
    if (ph === 'copy') {
      phase.textContent = 'Copie des fichiers…';
      const pct = total ? Math.round((cur / total) * 95) : 0;
      bar.style.width = pct + '%';
      detail.textContent = `${cur} / ${total} fichier${total > 1 ? 's' : ''}`;
    } else if (ph === 'registry') {
      phase.textContent = 'Enregistrement dans Apps & fonctionnalités…';
      bar.style.width = '97%';
      detail.textContent = '';
    } else if (ph === 'shortcuts') {
      phase.textContent = 'Création des raccourcis…';
      bar.style.width = '100%';
      detail.textContent = '';
    }
  });
}
function stopProgressListener() {
  if (progressUnsub) progressUnsub();
  progressUnsub = null;
}

// ── Done / Error footer buttons ─────────────────────────────────────────────
document.getElementById('finish-btn').addEventListener('click', () => window.installer.close());
document.getElementById('error-close').addEventListener('click', () => window.installer.close());
document.getElementById('error-retry').addEventListener('click', () => show('path'));
