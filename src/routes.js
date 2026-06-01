/**
 * Maps a WatchVerse route key + params to a Discord Rich Presence payload.
 *
 * Two ways this module is fed:
 *   1. URL-based detection in main.js (basic data — id, kind, episode…)
 *   2. Frontend hook via window.watchverse.setPresence (rich data — title,
 *      cover, episode title, watch-party code…)
 *
 * Frontend calls override URL-based ones because they fire later with more info.
 *
 * Per spec:
 *   - No small image (always omitted)
 *   - Large image = cover/backdrop URL when available, else the "big_image"
 *     asset uploaded to the WatchVerse Discord Dev Portal
 *   - Custom states for what makes WatchVerse WatchVerse: watching a
 *     film/série/animé, the live TV, and the Watch Party.
 */

// Prefix for relative image URLs + base for RPC button links.
const SITE_URL = process.env.WATCHVERSE_PUBLIC_URL || 'https://watchverse.watch';
// Grande image Discord par défaut (idle / navigation / dans une vox). AVANT :
// la clé d'asset 'big_image' du Dev Portal — si l'asset n'est pas uploadé (ou
// porte un autre nom), Discord affiche un "?" à la place du logo (bug user :
// pas de logo WatchVerse quand on est dans une vox). Discord PROXIE une URL
// https passée en largeImageKey (exactement comme les covers TMDB qui marchent
// déjà), donc on pointe directement sur le logo public 512×512 → zéro
// dépendance au Dev Portal, plus jamais de "?".
const FALLBACK_LARGE_KEY = SITE_URL.replace(/\/$/, '') + '/icon-512.png';
// Public Discord invite. ⚠️ TODO(confirm): set the real WatchVerse invite, or
// override at runtime with WATCHVERSE_DISCORD_INVITE. An invalid invite only
// breaks the button, not the rest of the presence.
const DISCORD_INVITE_URL = process.env.WATCHVERSE_DISCORD_INVITE || 'https://discord.gg/EtFSEn39CE';

function buildDefaultButtons() {
  return [
    { label: 'Ouvrir WatchVerse', url: SITE_URL },
    { label: 'Rejoindre le Discord', url: DISCORD_INVITE_URL },
  ];
}

const SORT_LABELS = {
  recent:    'Nouveautés',
  popular:   'Plus populaires',
  rating:    'Mieux notés',
  alpha:     'Ordre alphabétique',
  trending:  'Tendances',
};

function kindSegment(kind) {
  if (kind === 'movie' || kind === 'film') return 'film';
  if (kind === 'anime') return 'anime';
  if (kind === 'tv' || kind === 'serie') return 'serie';
  return 'title';
}
function kindLabel(kind) {
  if (kind === 'movie' || kind === 'film') return 'Film';
  if (kind === 'anime') return 'Animé';
  if (kind === 'tv' || kind === 'serie') return 'Série';
  return 'Œuvre';
}
function isEpisodic(kind) {
  return kind === 'tv' || kind === 'serie' || kind === 'anime';
}

/**
 * Normalise legacy ScanVerse route names the forked SITE still pushes via its
 * useDiscordPresence hook:  'manga' → 'title',  'reader' → 'player'.
 * Mapping here means a site push lands on the right WatchVerse payload AND
 * matches what main.js's URL parser produces (so the cached rich cover/title
 * isn't discarded on the next re-emit).
 */
function normalizeRoute(route) {
  if (route === 'manga') return 'title';
  if (route === 'reader') return 'player';
  return route;
}

function getPresenceForRoute(rawRoute, params = {}, extras = {}) {
  const route = normalizeRoute(rawRoute);
  const base = {
    largeImageKey: FALLBACK_LARGE_KEY,
    largeImageText: 'WatchVerse',
    buttons: buildDefaultButtons(),
  };

  const online = Number(extras.onlineCount) || 0;
  const onlineSuffix = online > 1 ? ` · ${online} en ligne` : '';

  switch (route) {
    case 'home':
      return { ...base, details: "Sur l'accueil", state: 'Parcourt le catalogue' + onlineSuffix };

    case 'catalogue': {
      const typeLabel =
        params.type === 'film'   ? 'Films'
        : params.type === 'serie' ? 'Séries'
        : params.type === 'anime' ? 'Animés'
        : params.type === 'bibliotheque' ? 'Ma bibliothèque'
        : 'Catalogue';
      let stateText;
      if (params.q && params.q.trim()) {
        stateText = `Recherche : ${truncate(params.q.trim(), 64)}`;
      } else if (Array.isArray(params.genres) && params.genres.length > 0) {
        const top = params.genres.slice(0, 2).join(', ');
        const more = params.genres.length > 2 ? ` +${params.genres.length - 2}` : '';
        stateText = `${truncate(top, 60)}${more}`;
      } else if (params.sort) {
        stateText = SORT_LABELS[params.sort] || `Tri : ${params.sort}`;
      } else {
        stateText = typeLabel + onlineSuffix;
      }
      const filtering = params.q || (params.genres && params.genres.length > 0) || params.sort;
      const detailsText = filtering ? `Filtre ${typeLabel.toLowerCase()}` : 'Parcourt le catalogue';
      return { ...base, details: detailsText, state: stateText };
    }

    case 'title': {
      const cover = sanitizeImage(params.cover || params.poster);
      const title = params.title || 'une œuvre';
      // "Type · Année" when the kind is KNOWN; else fall back to the legacy
      // 'manga' push's `author` (the site sets it to the year for films) so the
      // line is never the generic "Œuvre". kindLabel() defaults unknown→"Œuvre",
      // which would shadow the author fallback, so gate on a known kind here.
      const kindKnown = ['movie', 'film', 'tv', 'serie', 'anime'].includes(params.kind);
      const meta = [kindKnown ? kindLabel(params.kind) : null, params.year].filter(Boolean).join(' · ') || params.author || '';
      return {
        ...base,
        _sessionKey: `title:${params.id || 'unknown'}`,
        details: `Regarde la fiche de ${truncate(title, 96)}`,
        state: truncate(meta || 'Choisit quoi regarder', 96),
        largeImageKey: cover || FALLBACK_LARGE_KEY,
        largeImageText: truncate(params.title || 'WatchVerse', 96),
        buttons: buildTitleButton(params.kind, params.id),
      };
    }

    case 'player': {
      const cover = sanitizeImage(params.cover || params.backdrop || params.poster);
      const title = params.title || 'une œuvre';
      const epLabel = formatEpisodeLabel(params);
      const inParty = !!params.party;

      let stateText;
      if (epLabel) stateText = epLabel;
      else if (isEpisodic(params.kind)) stateText = 'En cours';
      else stateText = kindLabel(params.kind);

      const detailsVerb = params.idle ? '⏸️ En pause sur' : (inParty ? '👥 Watch Party ·' : 'Regarde');

      return {
        ...base,
        _sessionKey: `player:${params.id || 'unknown'}${inParty ? ':party' : ''}`,
        details: `${detailsVerb} ${truncate(title, 92)}`,
        state: truncate(stateText, 128),
        largeImageKey: cover || FALLBACK_LARGE_KEY,
        largeImageText: truncate(params.title || 'WatchVerse', 96),
        buttons: inParty
          ? buildPartyButton(params.party, params.kind, params.id)
          : buildTitleButton(params.kind, params.id),
      };
    }

    case 'livetv': {
      const channel = params.channel || params.title || null;
      return {
        ...base,
        _sessionKey: 'livetv',
        details: '📺 Regarde la TV en direct',
        state: truncate(channel ? channel : ('En direct' + onlineSuffix), 128),
        largeImageKey: sanitizeImage(params.logo) || FALLBACK_LARGE_KEY,
        largeImageText: channel ? truncate(channel, 96) : 'WatchVerse TV',
      };
    }

    case 'party': {
      const code = (params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      const title = params.title || null;
      return {
        ...base,
        _sessionKey: `party:${code || 'room'}`,
        details: title ? `👥 Watch Party · ${truncate(title, 90)}` : '👥 Dans une Watch Party',
        state: code ? `Salon ${code}` : "Salle d'attente",
        largeImageKey: sanitizeImage(params.cover || params.poster) || FALLBACK_LARGE_KEY,
        largeImageText: title ? truncate(title, 96) : 'WatchVerse Watch Party',
        buttons: buildPartyButton(code, params.kind, params.id),
      };
    }

    case 'profile': {
      const avatar = sanitizeImage(params.avatar);
      const handle = params.username ? `@${truncate(params.username, 30)}` : 'Page profil';
      return {
        ...base,
        details: params.isOwn ? 'Sur son profil' : 'Regarde un profil',
        state: handle,
        largeImageKey: avatar || FALLBACK_LARGE_KEY,
        largeImageText: params.username ? `@${truncate(params.username, 96)}` : 'WatchVerse',
      };
    }

    case 'friends':
      return { ...base, details: 'Gère ses amis', state: online > 1 ? `${online} en ligne` : "Liste d'amis" };

    case 'wrapped':
      return { ...base, details: 'Regarde son Wrapped', state: `Année ${params.year || new Date().getFullYear()}` };

    case 'admin':
      return { ...base, details: 'Espace admin', state: 'Tableau de bord' };

    case 'login':
      return { ...base, details: 'Se connecte', state: 'Authentification' };

    case 'register':
      return { ...base, details: 'Crée un compte', state: 'Inscription' };

    case 'settings':
      return { ...base, details: 'Personnalise son profil', state: 'Réglages du compte' };

    case 'settings-blocked':
      return { ...base, details: 'Gère ses blocages', state: 'Comptes bloqués' };

    case 'settings-privacy':
      return { ...base, details: 'Règle sa confidentialité', state: 'Visibilité du profil' };

    case 'settings-appearance':
      return { ...base, details: 'Personnalise son thème', state: 'Apparence du profil' };

    case 'settings-music':
      return { ...base, details: 'Choisit sa musique', state: 'Musique du profil' };

    case 'settings-reader':
      return { ...base, details: 'Règle son lecteur', state: 'Préférences de lecture' };

    case 'universe':
      return { ...base, details: 'Explore un univers', state: 'Saga / multivers' };

    case 'suggestions':
      return { ...base, details: 'Lit les suggestions', state: 'Idées de la communauté' };

    case 'premium':
      return { ...base, details: 'Découvre WatchVerse+', state: 'Offre premium' };

    case 'about':
      return { ...base, details: 'À propos de WatchVerse', state: 'Présentation du projet' };

    case 'contact':
      return { ...base, details: 'Page contact', state: 'Nous écrire' };

    case 'privacy':
      return { ...base, details: 'Politique de confidentialité', state: 'Mentions légales' };

    case 'terms':
      return { ...base, details: "Conditions d'utilisation", state: 'Mentions légales' };

    case 'changelog':
      return { ...base, details: 'Lit les notes de version', state: 'Historique des updates' };

    case 'messages':
      return { ...base, details: 'Dans la messagerie', state: 'En conversation' };

    case 'notfound':
      return { ...base, details: "S'est perdu", state: 'Page introuvable' };

    default:
      return { ...base, details: 'Sur WatchVerse', state: 'En exploration' };
  }
}

function truncate(str, max) {
  if (!str) return ' ';
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Episode label for the player state line. Accepts rich data
 * ({season, number/episode, episodeTitle}) or a raw "s1e3" string in
 * params.episode. Returns "" for films / when no episode info exists.
 */
function formatEpisodeLabel(params) {
  if (params.kind === 'movie' || params.kind === 'film') return '';
  let season = Number(params.season);
  let number = Number(params.number ?? params.episode);
  if ((!Number.isFinite(season) || !Number.isFinite(number)) && typeof params.episode === 'string') {
    const m = /^s(\d+)e(\d+)$/i.exec(params.episode.trim());
    if (m) { season = parseInt(m[1], 10); number = parseInt(m[2], 10); }
  }
  if (!Number.isFinite(season) || !Number.isFinite(number)) return '';
  const code = `S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}`;
  const t = params.episodeTitle ? ` — ${params.episodeTitle}` : '';
  return truncate(code + t, 128);
}

/**
 * Discord proxies a full HTTPS URL passed as largeImageKey through its CDN.
 * LAN URLs aren't reachable by Discord → null → fall back to "big_image".
 * Relative URLs get the public site URL prefixed.
 */
function sanitizeImage(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url)) {
    return null;
  }
  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://')) {
    const isPublic = !/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
    return isPublic ? url.replace(/^http:\/\//, 'https://') : null;
  }
  if (url.startsWith('/')) {
    const baseUrl = SITE_URL.replace(/\/$/, '');
    if (!baseUrl.startsWith('https://')) return null;
    return baseUrl + url;
  }
  return null;
}

/**
 * Buttons for a title / player presence. Discord rejects the WHOLE payload on
 * a bad URI, so we encode + validate via URL().
 */
function buildTitleButton(kind, id) {
  if (!id || typeof id !== 'string') return buildDefaultButtons();
  try {
    const url = `${SITE_URL}/${kindSegment(kind)}/${encodeURIComponent(id)}`;
    new URL(url);
    return [
      { label: "Voir l'œuvre", url },
      { label: 'Rejoindre le Discord', url: DISCORD_INVITE_URL },
    ];
  } catch {
    return buildDefaultButtons();
  }
}

/**
 * Buttons for a Watch Party: a deep link to /party/<code> so a friend on
 * Discord can jump into the room, plus "Voir l'œuvre" when we know the title.
 */
function buildPartyButton(code, kind, id) {
  const clean = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const buttons = [];
  if (clean.length >= 4) {
    try {
      const joinUrl = `${SITE_URL}/party/${clean}`;
      new URL(joinUrl);
      buttons.push({ label: 'Rejoindre la Watch Party', url: joinUrl });
    } catch { /* skip */ }
  }
  if (id && typeof id === 'string') {
    try {
      const url = `${SITE_URL}/${kindSegment(kind)}/${encodeURIComponent(id)}`;
      new URL(url);
      buttons.push({ label: "Voir l'œuvre", url });
    } catch { /* skip */ }
  }
  if (buttons.length === 0) return buildDefaultButtons();
  if (buttons.length === 1) buttons.push({ label: 'Ouvrir WatchVerse', url: SITE_URL });
  return buttons.slice(0, 2);
}

module.exports = { getPresenceForRoute, formatEpisodeLabel, normalizeRoute };
