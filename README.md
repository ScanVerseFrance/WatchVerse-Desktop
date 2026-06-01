# WatchVerse Webview (Windows)

Native desktop wrapper for [WatchVerse](https://watchverse.watch) with Discord Rich Presence.

Loads the WatchVerse site in a borderless Chromium window and pushes a custom
Discord activity based on the page being viewed — including custom states for
**watching a film/série/animé**, the **TV en direct**, and the **Watch Party**.

## Stack

- **Electron 41** — webview shell
- **discord-rpc** — IPC to the local Discord client (no internet needed)
- **Discord App ID** : `1510782927779139705`
- **Large image asset key** : `big_image` (the WatchVerse logo, uploaded to the Discord Dev Portal)

## Setup & run

```bash
cd "WatchVerse Webview"
npm install
npm start        # loads https://watchverse.watch
npm run dev      # localhost:5173 + DevTools
```

Env vars: `WATCHVERSE_URL`, `WATCHVERSE_DEV`, `WATCHVERSE_PUBLIC_URL`
(RPC button base, default `https://watchverse.watch`), `WATCHVERSE_API`
(online-count base, default `https://api.watchverse.watch`),
`WATCHVERSE_DISCORD_INVITE` (**TODO: confirm the real invite**),
`WATCHVERSE_DESKTOP_REPO` (updater repo, default `ScanVerseFrance/WatchVerse-Desktop`).

## Discord Rich Presence

Two modes, both active:

1. **URL-based** — parses the webview URL. Covered: `/`, `/films` `/series`
   `/anime` `/catalogue` `/bibliotheque`, `/film/:id` `/serie/:id` `/anime/:id`
   `/title/:id`, `/watch/:id/:episode` (+ `?party=CODE`), `/tv`, `/party/:code`,
   `/profile`, `/friends`, `/wrapped`, `/premium`, `/admin`, static pages, 404.
2. **Page-emitted** — `window.watchverse.setPresence(route, params)` (and
   `window.scanverse` back-compat alias, since the site forked from ScanVerse).
   Legacy route names `manga`/`reader` are auto-mapped to `title`/`player`.

```js
const wv = window.watchverse || window.scanverse;
if (wv?.isElectron) {
  wv.setPresence('player', {
    id: 'f1-le-film-911430', kind: 'movie', title: 'F1® Le Film',
    cover: 'https://image.tmdb.org/t/p/w780/....jpg',
    season: 1, number: 3, episodeTitle: '...',  // séries/animés
    party: 'ABC123',                             // en Watch Party
  });
}
```

### Custom WatchVerse states

| Route | details | state |
|---|---|---|
| `/watch/:id` (film) | Regarde *Titre* | Film |
| `/watch/:id/s1e3` (série) | Regarde *Titre* | S01E03 — *épisode* |
| `/watch/...?party=CODE` | 👥 Watch Party · *Titre* | S01E03 |
| `/tv` | 📺 Regarde la TV en direct | *chaîne* |
| `/party/:code` | 👥 Dans une Watch Party | Salon *CODE* |
| idle 10 min | ⏸️ En pause sur *Titre* | … |

Player/party payloads carry context buttons: **"Voir l'œuvre"** (deep link to
the title page) and, in a party, **"Rejoindre la Watch Party"** (`/party/CODE`).

## Discord Dev Portal — one-time

1. https://discord.com/developers/applications/1510782927779139705
2. **Rich Presence → Art Assets** → WatchVerse logo under key `big_image` (done).
3. Covers come from TMDB at runtime; no other assets needed.

## `watchverse://` deep links

```
watchverse://film/<id>   (serie/anime/title)
watchverse://watch/<id>/s1e3
watchverse://party/<CODE>
watchverse://tv
```

## Build

```bash
npm run build:art    # regenerate installer art (BMP/ICO) from assets/icon.png
npm run build:setup  # custom branded installer → dist/WatchVerse-Setup-X.Y.Z.exe
npm run build:win    # plain NSIS + portable
```

CI (`.github/workflows/release.yml`) builds on tag push (`vX.Y.Z`) and attaches
`dist/WatchVerse-Setup-*.exe` to a GitHub Release; the in-app updater polls it.

## TODO before shipping

- Confirm the real **Discord invite** (`WATCHVERSE_DISCORD_INVITE`).
- Create the **updater repo** (`WATCHVERSE_DESKTOP_REPO`).
- Run `npm run build:art` so the NSIS sidebar/header/icon reflect the
  WatchVerse logo (the BMP/ICO were inherited from ScanVerse).
- The **online count** polls `${WATCHVERSE_API}/api/presence/online-count`; if
  that route doesn't exist the count silently stays hidden (non-breaking).
