// =========================================================
// Songbook — app.js
// Data-driven: song content lives as one JSON file per song under
// /data/songs/ (see data/songs/manifest.json), loaded at runtime by
// loadSongData(). Adding a song = add a JSON file + one line in the
// manifest — nothing here needs to change.
// =========================================================

const APP_VERSION = 'v1.0.1';

// --- Hard update backstop -------------------------------------------------
// Everything above (scrollRestoration, controllerchange auto-reload,
// updateViaCache) fixes the *normal* service-worker update path. This is a
// second, independent line of defense that doesn't rely on any of that
// machinery noticing anything: it runs the instant this script itself
// executes, compares APP_VERSION against what's remembered from last time,
// and if they don't match, wipes every service worker + cache directly and
// forces one reload. So even if a device somehow never sees a normal SW
// update (host-level caching quirks, timing races, whatever), the first
// time it happens to load a genuinely fresh copy of this file, it will
// self-heal rather than staying stuck on stale code indefinitely.
(function hardUpdateBackstop() {
  try {
    const key = 'ngw_seen_version';
    const seen = localStorage.getItem(key);
    if (seen && seen !== APP_VERSION) {
      localStorage.setItem(key, APP_VERSION);
      const wipe = [];
      if ('serviceWorker' in navigator) {
        wipe.push(navigator.serviceWorker.getRegistrations().then(regs => Promise.all(regs.map(r => r.unregister()))));
      }
      if ('caches' in window) {
        wipe.push(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
      }
      Promise.all(wipe).catch(() => {}).finally(() => window.location.reload());
      return;
    }
    localStorage.setItem(key, APP_VERSION);
  } catch (e) {
    // localStorage unavailable (e.g. private browsing edge cases) — the
    // normal service-worker update path above still applies, just skip
    // this extra backstop rather than letting it break anything.
  }
})();

// Song sources: each is an independent collection of songs — its own list,
// its own load-state, and (see SONGDB_STORES further down) its own offline
// backup store. Version 1 only ever populates and shows 'official'. The
// list/search/sort/song-view code below all takes a source key as a
// parameter rather than assuming 'official' is the only one, so a future
// 'user' source (v2's User Songs) can reuse it — add its loader, its own
// page, and a call site — without rewriting any of this.
const state = {
  sources: {
    official: { songs: [], loadFailed: false },
  },
  sortBy: 'num',       // 'alpha' | 'num'
  sortOrder: 'asc',     // 'asc' | 'desc'
  query: '',
  activeSong: null,
  activeSourceKey: 'official', // which source the open song view came from
  transpose: 0,
  lyricsSize: 1.05,   // rem
  chordSize: 0.82,    // rem
  lang: 'mn',
  currentPage: 'songs', // mirrors whichever page is currently visible (see showPage)
};

// Registry of every page the router (showPage/bindNav) knows about. Adding
// a new page later — e.g. v2's "user-songs", or Playlists/Sheet Music —
// means adding one entry here plus its <main id="…"> and its
// <button data-nav="…"> in index.html; showPage() and bindNav() below
// don't need to change either way.
//   elId            — the <main> element's id.
//   navKey           — which bottom-nav button (its data-nav value) should
//                       light up while this page is open. song-view has no
//                       button of its own, so it borrows 'songs' (the list
//                       it was opened from). Omit for a page that hides the
//                       nav bar entirely (see hideNav).
//   hideNav          — true if the bottom nav should be hidden on this page.
//   rememberScroll    — true if this page's scroll position should be saved
//                       and restored across navigation. song-view is false:
//                       it shows different content each time it's opened,
//                       so it always starts at the top instead.
//   onEnter          — optional callback run each time this page is shown.
const PAGES = {
  'songs':     { elId: 'page-songs',     navKey: 'songs',    rememberScroll: true },
  'song-view': { elId: 'page-song-view', navKey: 'songs',    rememberScroll: false, hideNav: true },
  'settings':  { elId: 'page-settings',  navKey: 'settings', rememberScroll: true, onEnter: () => resetContactUI() },
};

// Remembers each rememberScroll page's scroll position (each .page
// element's own scrollTop — see the CSS notes on .page for why it's no
// longer window/document scroll) across navigation, so leaving a page (open
// a song, switch tabs) and coming back lands where you left off, instead of
// jumping to the top every time. Derived from PAGES so a new page opts in
// just by setting rememberScroll: true there — nothing to add here. See
// showPage().
const scrollMemory = {};
Object.entries(PAGES).forEach(([name, page]) => {
  if (page.rememberScroll) scrollMemory[name] = 0;
});

// Chord transpose is limited to a full octave in either direction —
// beyond that you're just back to an enharmonic equivalent of an in-range key.
const TRANSPOSE_LIMIT = 12;

const CHROMATIC_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const CHROMATIC_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const FLAT_KEYS = new Set(['F','Bb','Eb','Ab','Db','Gb','Dm','Gm','Cm','Fm','Bbm']);

// ---------------------------------------------------------
// Icons: every icon the app uses lives as its own file under
// icons/svg/ — this loader fetches each one and injects its markup into
// the matching <svg data-icon="…"> placeholder. To use a different icon,
// replace (or edit) the file in icons/svg/ — nothing here needs to change.
// A replacement file's own viewBox/attributes are honored, so a
// differently-proportioned icon still renders correctly.
// ---------------------------------------------------------
const ICON_FILES = {
  'brand-mark': 'icons/svg/brand-music-note.svg',
  'search': 'icons/svg/search.svg',
  'back-arrow': 'icons/svg/back-arrow.svg',
  'contact-mail': 'icons/svg/mail-contact.svg',
  'copy': 'icons/svg/copy.svg',
  'nav-songs': 'icons/svg/nav-songs-bookmark.svg',
  'nav-settings': 'icons/svg/nav-settings-gear.svg',
  'social-facebook': 'icons/svg/social-facebook.svg',
  'social-youtube': 'icons/svg/social-youtube.svg',
  'social-instagram': 'icons/svg/social-instagram.svg',
  'social-website': 'icons/svg/social-website.svg',
};

const iconFileCache = new Map();
function loadIconFile(path) {
  if (!iconFileCache.has(path)) {
    iconFileCache.set(path, fetch(path).then((res) => {
      if (!res.ok) throw new Error(`${path} responded ${res.status}`);
      return res.text();
    }));
  }
  return iconFileCache.get(path);
}

async function injectIcon(el) {
  const name = el.dataset.icon;
  const path = ICON_FILES[name];
  if (!path) return;
  try {
    const svgText = await loadIconFile(path);
    const src = new DOMParser().parseFromString(svgText, 'image/svg+xml').querySelector('svg');
    if (!src) throw new Error('no <svg> root found');
    // Adopt the file's own viewBox/attributes (so a replacement icon with
    // different proportions still renders correctly), but never touch
    // class/id — those belong to the placeholder markup, not the icon file.
    Array.from(src.attributes).forEach((attr) => {
      if (attr.name === 'class' || attr.name === 'id') return;
      el.setAttribute(attr.name, attr.value);
    });
    el.innerHTML = src.innerHTML;
  } catch (err) {
    console.warn(`Songbook: could not load icon "${name}" from ${path} —`, err);
  }
}

function initIcons(root = document) {
  return Promise.all(Array.from(root.querySelectorAll('[data-icon]')).map(injectIcon));
}

// Social links shown in Settings → About. Leave `url` empty in config.js to
// hide that icon entirely — nothing else needs to change when these are
// filled in. Each icon's artwork lives in icons/svg/ (see ICON_FILES above);
// this table just maps a platform to its label and icon file key.
const SOCIAL_ICONS = {
  facebook: { label: 'Facebook', icon: 'social-facebook' },
  youtube: { label: 'YouTube', icon: 'social-youtube' },
  instagram: { label: 'Instagram', icon: 'social-instagram' },
  website: { label: 'Website', icon: 'social-website' },
};

function renderSocialLinks() {
  const el = document.getElementById('about-social');
  if (!el) return;
  const social = (window.SONGBOOK_APP_CONFIG && window.SONGBOOK_APP_CONFIG.social) || {};
  el.innerHTML = Object.keys(SOCIAL_ICONS)
    .filter(key => social[key])
    .map(key => `<a href="${escapeHtml(social[key])}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(SOCIAL_ICONS[key].label)}"><svg data-icon="${SOCIAL_ICONS[key].icon}" viewBox="0 0 24 24"></svg></a>`)
    .join('');
  initIcons(el);
}

function t(key, ...args) {
  const dict = (window.SONGBOOK_LANG && window.SONGBOOK_LANG[state.lang]) || {};
  const entry = dict[key];
  if (typeof entry === 'function') return entry(...args);
  return entry !== undefined ? entry : key;
}

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', init);

// Each startup step runs independently — if one throws (a missing element,
// a bad selector, anything), the rest still run. Without this, one broken
// step could silently prevent applyLanguage() from ever running, leaving
// the static English placeholders in index.html on screen permanently
// instead of the real (translated) content.
function safe(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`Songbook: "${label}" failed during startup —`, err);
  }
}

async function init() {
  safe('initIcons', initIcons);
  safe('initSplash', initSplash);
  safe('loadPrefs', loadPrefs);
  safe('bindNav', bindNav);
  safe('bindSongsPage', bindSongsPage);
  safe('bindSongView', bindSongView);
  safe('bindSettings', bindSettings);
  safe('applyLanguage', applyLanguage);
  safe('registerServiceWorker', registerServiceWorker);
  safe('setupInstallPrompt', setupInstallPrompt);
  safe('initHistoryNav', initHistoryNav);
  requestPersistentStorage(); // fire-and-forget; never block startup on this

  await loadSongData();
  safe('applyLanguage (post-load)', applyLanguage); // re-run so the results count reflects the loaded songs
}

// Ask the browser not to automatically evict our Cache Storage / IndexedDB
// under storage pressure. This is a real, standard API — but it's worth
// being clear about what it does and doesn't cover: it protects against
// the browser's own automatic eviction, not against a user (or an OEM
// "phone manager" cleanup tool) explicitly clearing the app's storage —
// that's a stronger, OS-level action no web page can prevent.
async function requestPersistentStorage() {
  if (!(navigator.storage && navigator.storage.persist)) return;
  try {
    const already = await navigator.storage.persisted();
    if (already) return;
    const granted = await navigator.storage.persist();
    console.log('Songbook: persistent storage', granted ? 'granted' : 'not granted (browser declined)');
  } catch (err) {
    console.warn('Songbook: persistent storage request failed —', err);
  }
}

// ---------------------------------------------------------
// Song data: one JSON file per song, listed in data/songs/manifest.json.
// Adding a song = add its JSON file + one line in the manifest; nothing
// else in the app needs to change.
// ---------------------------------------------------------
async function fetchSongData({ forceRefresh = false } = {}) {
  const headers = forceRefresh ? { 'X-Force-Refresh': '1' } : {};
  const manifestRes = await fetch('data/songs/manifest.json', { headers });
  if (!manifestRes.ok) throw new Error(`manifest.json responded ${manifestRes.status}`);
  const files = await manifestRes.json();

  return Promise.all(files.map(async (file) => {
    const res = await fetch(`data/songs/${file}`, { headers });
    if (!res.ok) throw new Error(`${file} responded ${res.status}`);
    return res.json();
  }));
}

// ---------------------------------------------------------
// IndexedDB backup: a second, independent offline copy of the song data.
// Cache Storage (used by the service worker) is the primary mechanism and
// is enough on its own in normal use — this exists purely as a fallback
// for the edge case where Cache Storage has been evicted by the OS under
// storage pressure (a real, documented mobile behavior, and a different
// eviction policy than IndexedDB's) while the network is also unavailable.
// ---------------------------------------------------------
const SONGDB_NAME = 'songbook-db';
// Bumped 1 → 2 to add the 'user-songs' store below (an IndexedDB store can
// only be created inside onupgradeneeded, which only fires on a version
// increase). onupgradeneeded is written to only create stores that don't
// already exist, so this upgrade is additive for already-installed
// devices — their existing official-songs backup is untouched.
const SONGDB_VERSION = 2;
// One object store per song source (see state.sources above), so each
// source's offline backup lives independently and nothing collides. Only
// 'official' is written to in Version 1. 'user' is reserved now, unused,
// so v2's User Songs source can start saving to IndexedDB immediately —
// no further DB version bump needed when that day comes.
const SONGDB_STORES = {
  official: 'songs', // kept as 'songs', not renamed to 'official-songs', so
                      // existing installs' offline backup carries over as-is
  user: 'user-songs',
};

function openSongDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(SONGDB_NAME, SONGDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      Object.values(SONGDB_STORES).forEach((storeName) => {
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSongsToIndexedDb(sourceKey, songs) {
  const storeName = SONGDB_STORES[sourceKey];
  if (!storeName) return;
  try {
    const db = await openSongDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(songs, 'all-songs');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    // Non-fatal — this is a backup layer, not the primary path.
    console.warn(`Songbook: could not save "${sourceKey}" songs to IndexedDB —`, err);
  }
}

async function loadSongsFromIndexedDb(sourceKey) {
  const storeName = SONGDB_STORES[sourceKey];
  if (!storeName) return null;
  const db = await openSongDb();
  const songs = await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get('all-songs');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return songs;
}

async function loadSongData() {
  const source = state.sources.official;
  try {
    source.songs = await fetchSongData();
    saveSongsToIndexedDb('official', source.songs); // fire-and-forget; don't block on this
  } catch (err) {
    console.error('Songbook: failed to load song data over the network —', err);
    try {
      const backup = await loadSongsFromIndexedDb('official');
      if (backup && backup.length) {
        console.warn('Songbook: network/cache load failed — recovered songs from IndexedDB backup.');
        source.songs = backup;
        return;
      }
    } catch (dbErr) {
      console.error('Songbook: IndexedDB backup also unavailable —', dbErr);
    }
    // Most likely cause if there's no backup either: the app was opened
    // directly from disk (file://), where browsers block fetch() of local
    // files. Serving it over http(s) — even just localhost — resolves this.
    source.songs = [];
    source.loadFailed = true;
  }
}

// Manual "Refresh song database" button: asks the service worker to try the
// network first (see the X-Force-Refresh handling in service-worker.js),
// falling back to the existing cached copy if that fails — so a refresh
// attempted while offline just silently keeps the offline copy intact
// instead of ever deleting it. The cache is only ever replaced by data
// that's confirmed to have loaded successfully. Unlike the initial load, a
// failure here also leaves the source's songs alone — no point wiping out songs
// that were already showing just because this refresh attempt failed.
async function reloadSongLibrary() {
  const btn = document.getElementById('reload-songs-btn');
  btn.disabled = true;
  btn.textContent = t('reloadBtnBusy');

  try {
    const songs = await fetchSongData({ forceRefresh: true });
    const source = state.sources.official;
    source.songs = songs;
    source.loadFailed = false;
    saveSongsToIndexedDb('official', source.songs);
    renderSongList();
    showToast(navigator.onLine ? t('toastLibraryReloaded') : t('toastLibraryOffline'));
  } catch (err) {
    console.error('Songbook: manual song database refresh failed —', err);
    showToast(t('toastLibraryReloadFailed'));
  } finally {
    btn.disabled = false;
    btn.textContent = t('reloadBtn');
  }
}

// Manual "Reload app" button: a different, heavier reload than the song
// database refresh above — this clears the offline app-shell cache and the
// service worker entirely, then reloads the page, so it picks up a fresh
// copy of everything (HTML/CSS/JS included), not just the song data. This
// exists as an explicit, deliberate action the person has to tap, since the
// browser's native swipe-down-to-reload gesture is disabled in this app
// (accidental pull-to-refresh mid-scroll was closing songs/losing state).
async function reloadApp() {
  const btn = document.getElementById('reload-app-btn');
  btn.disabled = true;
  btn.textContent = t('reloadAppBtnBusy');

  // Offline: unregistering the service worker and clearing every cache
  // leaves nothing behind to serve the reload with — nothing can be
  // re-downloaded without a connection. That combination used to be
  // exactly what stranded people on a broken/blank reload while offline.
  // Skip the destructive cleanup entirely here and just reload normally —
  // the still-intact service worker and cache keep serving the app as-is,
  // and the offline fallback page (see service-worker.js) covers it even
  // if something's still missing.
  if (!navigator.onLine) {
    showToast(t('toastReloadAppOffline'));
    btn.disabled = false;
    btn.textContent = t('reloadAppBtn');
    window.location.reload();
    return;
  }

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.error('Songbook: app reload cleanup failed —', err);
  } finally {
    window.location.reload();
  }
}

// ---------------------------------------------------------
// In-app back navigation: the hardware/gesture/browser back button should
// move within the app (song → list, settings → list) instead of leaving
// it, and only exit after a second back press at the root within a short
// window — the same "press back again to exit" pattern many apps use.
// ---------------------------------------------------------
let lastBackPressAt = 0;
const EXIT_CONFIRM_WINDOW_MS = 2000;

function initHistoryNav() {
  // Every pushState below reuses the same URL (only the state object
  // changes — {page: 'songs'} vs {page: 'song-view'}, etc.), since this is
  // a single-page app with no per-page URLs. Left on its default 'auto',
  // the browser tries to restore its own remembered scroll position on
  // top of ours whenever you navigate back/forward — and because all the
  // entries share one URL, it can restore the wrong one (typically 0),
  // silently overwriting the position showPage() just set. Switching to
  // 'manual' hands scroll restoration entirely to our own code below,
  // which is the only thing that actually knows which page is showing.
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  // Establish the app's root state so the very first back press has
  // something of ours to land on instead of leaving immediately.
  history.replaceState({ page: 'songs' }, '', location.href);

  window.addEventListener('popstate', (e) => {
    const st = e.state;
    if (st && st.page) {
      if (st.page === 'song-view' && st.songId) {
        const sourceKey = st.sourceKey || 'official';
        const source = state.sources[sourceKey];
        const song = source && source.songs.find(s => s.id === st.songId);
        if (song) { openSong(song, { pushHistory: false, sourceKey }); return; }
      }
      showPage(st.page, { pushHistory: false });
      return;
    }

    // No app state left to land on — the next back would leave the app.
    const now = Date.now();
    if (now - lastBackPressAt < EXIT_CONFIRM_WINDOW_MS) {
      // Second press in time: let this one actually exit.
      return;
    }
    lastBackPressAt = now;
    // Re-plant the root state so this press doesn't leave the app, and
    // tell the person to press back again if they really want to exit.
    history.pushState({ page: 'songs' }, '', location.href);
    showPage('songs', { pushHistory: false });
    showToast(t('toastPressBackAgain'));
  });
}

// ---------------------------------------------------------
// Splash screen: shown briefly on launch, then fades into the app
// ---------------------------------------------------------
function initSplash() {
  const splash = document.getElementById('splash-screen');
  if (!splash) return;
  const MIN_DISPLAY_MS = 900;
  const FADE_MS = 1100;
  const shownAt = Date.now();
  const hide = () => {
    const wait = Math.max(0, MIN_DISPLAY_MS - (Date.now() - shownAt));
    setTimeout(() => {
      splash.classList.add('is-hidden');
      setTimeout(() => splash.remove(), FADE_MS);
    }, wait);
  };
  if (document.readyState === 'complete') {
    hide();
  } else {
    window.addEventListener('load', hide);
  }
}

// ---------------------------------------------------------
// Preferences (persisted locally — offline-first, no cloud)
// ---------------------------------------------------------
function loadPrefs() {
  const theme = localStorage.getItem('sb-theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').setAttribute('aria-checked', String(theme === 'dark'));

  const accent = localStorage.getItem('sb-accent') || 'aqua';
  document.documentElement.setAttribute('data-accent', accent);
  document.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.accent === accent));
  });

  const savedLang = localStorage.getItem('sb-ui-lang');
  const available = Object.keys(window.SONGBOOK_LANG || {});
  const preferredOrder = window.SONGBOOK_LANG_ORDER || [];
  const orderedLangs = [
    ...preferredOrder.filter(code => available.includes(code)),
    ...available.filter(code => !preferredOrder.includes(code)).sort(),
  ];
  state.lang = (savedLang && available.includes(savedLang)) ? savedLang
    : (available.includes(window.SONGBOOK_DEFAULT_LANG) ? window.SONGBOOK_DEFAULT_LANG : orderedLangs[0]);
  document.documentElement.setAttribute('lang', state.lang);

  const langSelect = document.getElementById('ui-lang-select');
  if (langSelect) {
    langSelect.innerHTML = orderedLangs
      .map(code => `<option value="${code}">${(window.SONGBOOK_LANG[code].meta && window.SONGBOOK_LANG[code].meta.name) || code}</option>`)
      .join('');
    langSelect.value = state.lang;
  }

  const lyricsSize = parseFloat(localStorage.getItem('sb-lyrics-size'));
  const chordSize = parseFloat(localStorage.getItem('sb-chord-size'));
  if (!Number.isNaN(lyricsSize)) state.lyricsSize = lyricsSize;
  if (!Number.isNaN(chordSize)) state.chordSize = chordSize;
  applyFontSizes();
}

function applyFontSizes() {
  document.documentElement.style.setProperty('--lyrics-size', state.lyricsSize + 'rem');
  document.documentElement.style.setProperty('--chord-size', state.chordSize + 'rem');
}

// ---------------------------------------------------------
// Language: apply the active language to every labeled element
// ---------------------------------------------------------
function applyLanguage() {
  document.documentElement.setAttribute('lang', state.lang);

  const map = {
    't-appTitle': 'appTitle',
    't-topbarAppName': 'appTitle',
    't-navSongs': 'navSongs',
    't-navSettings': 'navSettings',
    't-keyLabel': 'keyLabel',
    't-lyricsGroup': 'lyricsGroup',
    't-chordsGroup': 'chordsGroup',
    't-settingsTitle': 'settingsTitle',
    't-sectionAppearance': 'sectionAppearance',
    't-darkModeTitle': 'darkModeTitle',
    't-darkModeSub': 'darkModeSub',
    't-accentTitle': 'accentTitle',
    't-accentSub': 'accentSub',
    't-sectionLangDb': 'sectionLangDb',
    't-uiLangTitle': 'uiLangTitle',
    't-uiLangSub': 'uiLangSub',
    't-dbTitle': 'dbTitle',
    't-dbSub': 'dbSub',
    't-sectionApp': 'sectionApp',
    't-reloadTitle': 'reloadTitle',
    't-reloadSub': 'reloadSub',
    't-sectionAbout': 'sectionAbout',
    't-versionTitle': 'versionTitle',
  };
  Object.entries(map).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  });

  document.getElementById('search-input').placeholder = t('searchPlaceholder');
  document.getElementById('back-btn').setAttribute('aria-label', t('backAria'));
  document.getElementById('transpose-reset').textContent = t('transposeReset');

  document.querySelector('.sort-btn[data-sort-by="alpha"]').textContent = t('sortByAlpha');
  document.querySelector('.sort-btn[data-sort-by="num"]').textContent = t('sortByNumber');
  document.querySelector('.sort-btn[data-sort-order="asc"]').textContent = t('sortAsc');
  document.querySelector('.sort-btn[data-sort-order="desc"]').textContent = t('sortDesc');

  document.getElementById('db-option-en').textContent = t('dbComingSoon', 'English');

  document.getElementById('empty-state').textContent = t('emptyState');
  document.getElementById('about-version-line').textContent = t('versionSub', APP_VERSION);
  document.getElementById('scripture-verse-text').textContent = `«${t('scriptureVerse')}»`;
  document.getElementById('scripture-verse-ref').textContent = t('scriptureRef');

  const appConfig = window.SONGBOOK_APP_CONFIG || {};
  const orgName = appConfig.orgName || '';
  document.getElementById('about-copyright').textContent =
    `© ${new Date().getFullYear()} ${orgName}. All rights reserved.`;

  document.getElementById('t-contactBtn').textContent = t('contactBtn');
  document.getElementById('about-contact-copy').setAttribute('aria-label', t('copyEmailAria'));
  if (appConfig.contactEmail) {
    document.getElementById('about-contact-email').textContent = appConfig.contactEmail;
  }
  resetContactUI();

  const reloadBtn = document.getElementById('reload-songs-btn');
  if (!reloadBtn.disabled) reloadBtn.textContent = t('reloadBtn');
  const reloadAppBtn = document.getElementById('reload-app-btn');
  if (!reloadAppBtn.disabled) reloadAppBtn.textContent = t('reloadAppBtn');

  renderSocialLinks();

  refreshInstallLabels();
  renderSongList();
  if (state.activeSong) updateTransposeUI();
}

// ---------------------------------------------------------
// Navigation — data-driven off PAGES above, so it doesn't need to change
// when a page is added; only PAGES (+ its markup) does.
// ---------------------------------------------------------
function bindNav() {
  document.querySelectorAll('.nav-btn[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const target = btn.dataset.nav;
      // Tapping a tab you're ALREADY on is a deliberate "jump to top of
      // the list" action — standard tab-bar behavior. Tapping it to come
      // back from a different page (settings, a song) is a normal "go
      // back" and should instead restore wherever that list was
      // scrolled to, same as the in-song back button.
      const alreadyThere = state.currentPage === target;
      showPage(target, { pushHistory: true, resetScroll: alreadyThere });
    });
  });
}

function showPage(name, opts = {}) {
  const { pushHistory = false, replaceHistory = false, resetScroll = false } = opts;
  const page = PAGES[name];
  if (!page) {
    console.error(`Songbook: showPage() called with unknown page "${name}"`);
    return;
  }

  // Re-navigating to the page already on screen (e.g. tapping the "Songs"
  // tab while already viewing the song list) normally shouldn't move the
  // scroll at all — just leave it exactly where it is. resetScroll is the
  // explicit override for that (see bindNav's already-there case): it
  // always wins and jumps to the top, even on the same page.
  const isSamePage = state.currentPage === name;

  // Otherwise, before switching away, remember where we were scrolled on
  // the page's own scroll container (see the CSS/.page notes for why it's
  // an element's scrollTop now, not window.scrollY) so coming back to it
  // later restores that exact spot.
  if (!isSamePage && (state.currentPage in scrollMemory)) {
    const prevPage = PAGES[state.currentPage];
    const prevEl = prevPage && document.getElementById(prevPage.elId);
    if (prevEl) scrollMemory[state.currentPage] = prevEl.scrollTop;
  }

  Object.values(PAGES).forEach(p => { document.getElementById(p.elId).hidden = true; });
  const targetEl = document.getElementById(page.elId);
  targetEl.hidden = false;

  document.querySelectorAll('.nav-btn[data-nav]').forEach(b => b.classList.remove('is-active'));
  if (page.navKey) {
    const navBtn = document.querySelector(`.nav-btn[data-nav="${page.navKey}"]`);
    if (navBtn) navBtn.classList.add('is-active');
  }
  if (page.onEnter) page.onEnter();

  // A page can opt to hide the bottom tab bar so nothing competes with its
  // content (song-view does this — it has its own slim top bar instead).
  document.getElementById('bottom-nav').hidden = !!page.hideNav;
  document.body.classList.toggle('nav-hidden', !!page.hideNav);

  if (resetScroll) {
    // Explicit override: always end up at the top, same page or not.
    if (isSamePage) {
      // Already on this page (tapping the tab you're on) — animate back to
      // the top instead of an instant cut, so the jump reads as motion.
      targetEl.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      // Landing on the page fresh (e.g. opening a song): nothing to
      // animate from, just start at the top.
      targetEl.scrollTop = 0;
    }
  } else if (!isSamePage) {
    if (name in scrollMemory) {
      // Returning to a page we've been on before: put the scroll back where it was.
      targetEl.scrollTop = scrollMemory[name];
    } else {
      // Fresh page (e.g. opening a song): start at the top.
      targetEl.scrollTop = 0;
    }
  }

  state.currentPage = name;

  if (pushHistory) {
    history.pushState({ page: name }, '', location.href);
  } else if (replaceHistory) {
    history.replaceState({ page: name }, '', location.href);
  }
}

// ---------------------------------------------------------
// Songs page: search + sort + list rendering
// ---------------------------------------------------------
function bindSongsPage() {
  const input = document.getElementById('search-input');
  input.addEventListener('input', () => {
    state.query = input.value.trim().toLowerCase();
    renderSongList();
  });

  document.querySelectorAll('.sort-btn[data-sort-by]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sortBy = btn.dataset.sortBy;
      document.querySelectorAll('.sort-btn[data-sort-by]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      renderSongList();
    });
  });

  document.querySelectorAll('.sort-btn[data-sort-order]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sortOrder = btn.dataset.sortOrder;
      document.querySelectorAll('.sort-btn[data-sort-order]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      renderSongList();
    });
  });
}

function stripChords(lyricsArr) {
  return lyricsArr.join(' \n ').replace(/\[[^\]]+\]/g, '');
}

function matchesQuery(song, q) {
  if (!q) return true;

  const haystack = [
    song.title,
    String(song.number),
    ...(song.alternateTitles || []),
    song.artist || '',
    stripChords(song.lyrics),
  ].join(' \n ').toLowerCase();

  // Every word in the query must appear somewhere in the combined text,
  // in any order — so "God awesome" matches "God Is an Awesome God"
  // even though that exact phrase never appears contiguously.
  const words = q.split(/\s+/).filter(Boolean);
  return words.every(word => haystack.includes(word));
}

// Lower rank = more relevant. Used only while a search query is active,
// so exact/close title matches float to the top instead of being buried
// among "contains the word somewhere in the lyrics" results.
function relevanceRank(song, q) {
  const query = q.trim().toLowerCase();
  if (!query) return 6;

  const title = (song.title || '').toLowerCase();
  const altTitles = (song.alternateTitles || []).filter(Boolean).map(a => a.toLowerCase());
  const artist = (song.artist || '').toLowerCase();

  if (title === query) return 0;                              // exact title match
  if (title.startsWith(query)) return 1;                       // title starts with query
  if (title.includes(query)) return 2;                         // title contains query
  if (altTitles.some(a => a === query)) return 3;               // exact alternate title
  if (altTitles.some(a => a.includes(query))) return 4;         // alternate title contains query
  if (artist.includes(query)) return 5;                         // artist match
  return 6;                                                     // everything else (e.g. lyrics)
}

function sortSongs(list, q) {
  const arr = [...list];
  const dir = state.sortOrder === 'desc' ? -1 : 1;
  const query = (q || '').trim();

  arr.sort((a, b) => {
    if (query) {
      const rankA = relevanceRank(a, query);
      const rankB = relevanceRank(b, query);
      if (rankA !== rankB) return rankA - rankB;
    }
    if (state.sortBy === 'num') {
      return (a.number - b.number) * dir;
    }
    return a.title.localeCompare(b.title) * dir;
  });

  return arr;
}

function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(text.slice(idx + q.length));
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// sourceKey picks which state.sources entry to render (defaults to
// 'official', the only one that exists in Version 1). listElId/emptyElId/
// countElId let a future second list page (e.g. User Songs) reuse this
// same function against its own DOM ids instead of needing its own copy —
// every v1 call site below uses the defaults, so nothing changes for now.
function renderSongList(opts = {}) {
  const {
    sourceKey = 'official',
    listElId = 'song-list',
    emptyElId = 'empty-state',
    countElId = 'results-count',
  } = opts;

  const source = state.sources[sourceKey];
  const listEl = document.getElementById(listElId);
  const emptyEl = document.getElementById(emptyElId);
  const countEl = document.getElementById(countElId);

  if (!source || source.loadFailed) {
    listEl.innerHTML = `<li class="load-error">${escapeHtml(t('songLoadError'))}</li>`;
    emptyEl.hidden = true;
    countEl.textContent = '';
    return;
  }

  const filtered = sortSongs(source.songs.filter(s => matchesQuery(s, state.query)), state.query);

  countEl.textContent = filtered.length === source.songs.length
    ? t('resultsAll', filtered.length)
    : t('resultsFiltered', filtered.length, source.songs.length);

  listEl.innerHTML = '';
  emptyEl.hidden = filtered.length !== 0;

  const q = state.query;
  filtered.forEach(song => {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.className = 'song-row';
    row.innerHTML = `
      <span class="song-badge">${song.number}</span>
      <span class="song-row-text">
        <span class="song-row-title">${highlight(song.title, q)}</span>
        ${song.artist ? `<span class="song-row-sub">${escapeHtml(song.artist)}</span>` : ''}
      </span>
    `;
    row.addEventListener('click', () => openSong(song, { sourceKey }));
    li.appendChild(row);
    listEl.appendChild(li);
  });
}

// ---------------------------------------------------------
// Song view: chord-over-lyric rendering + transpose
// ---------------------------------------------------------
function bindSongView() {
  document.getElementById('back-btn').addEventListener('click', () => history.back());

  document.getElementById('transpose-up').addEventListener('click', () => {
    if (state.transpose >= TRANSPOSE_LIMIT) return;
    state.transpose += 1;
    updateTransposeUI();
  });
  document.getElementById('transpose-down').addEventListener('click', () => {
    if (state.transpose <= -TRANSPOSE_LIMIT) return;
    state.transpose -= 1;
    updateTransposeUI();
  });
  document.getElementById('transpose-reset').addEventListener('click', () => {
    state.transpose = 0;
    updateTransposeUI();
  });

  document.querySelectorAll('[data-font]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.font;
      if (action === 'lyrics-up') state.lyricsSize = Math.min(1.6, state.lyricsSize + 0.08);
      if (action === 'lyrics-down') state.lyricsSize = Math.max(0.75, state.lyricsSize - 0.08);
      if (action === 'chords-up') state.chordSize = Math.min(1.2, state.chordSize + 0.06);
      if (action === 'chords-down') state.chordSize = Math.max(0.6, state.chordSize - 0.06);
      applyFontSizes();
      localStorage.setItem('sb-lyrics-size', state.lyricsSize);
      localStorage.setItem('sb-chord-size', state.chordSize);
    });
  });
}

function openSong(song, opts = {}) {
  const { pushHistory = true, sourceKey = 'official' } = opts;
  state.activeSong = song;
  state.activeSourceKey = sourceKey;
  state.transpose = 0;

  document.getElementById('sv-number').textContent = `#${song.number}`;
  document.getElementById('sv-title').textContent = song.title;

  const altEl = document.getElementById('sv-alt-title');
  const altTitles = (song.alternateTitles || []).filter(Boolean);
  if (altTitles.length) {
    altEl.textContent = altTitles.join(' • ');
    altEl.hidden = false;
  } else {
    altEl.textContent = '';
    altEl.hidden = true;
  }

  const artistEl = document.getElementById('sv-artist');
  if (song.artist) {
    artistEl.textContent = song.artist;
    artistEl.hidden = false;
  } else {
    artistEl.textContent = '';
    artistEl.hidden = true;
  }

  const labelsEl = document.getElementById('sv-labels');
  labelsEl.innerHTML = (song.labels || [])
    .map(l => `<span class="sv-label-chip">${escapeHtml(l)}</span>`).join('');

  const audioEl = document.getElementById('sv-audio');
  if (song.audio && song.audio.length) {
    audioEl.hidden = false;
    audioEl.innerHTML = song.audio.map(a => {
      const url = escapeHtml(a.url || a);
      const fileName = escapeHtml((a.url || a).split('/').pop());
      return `
        <div class="audio-item">
          <audio controls style="width:100%" src="${url}"></audio>
          <a class="audio-download" href="${url}" download="${fileName}">⭳ ${t('downloadAudio')}</a>
        </div>`;
    }).join('');
  } else {
    audioEl.hidden = true;
    audioEl.innerHTML = '';
  }

  const linksEl = document.getElementById('sv-links');
  if (song.links && song.links.length) {
    linksEl.hidden = false;
    linksEl.innerHTML = song.links.map(l => {
      const url = typeof l === 'string' ? l : l.url;
      const label = (typeof l === 'object' && l.label) ? l.label : t('listenLink');
      return `<a class="sv-link-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    }).join('');
  } else {
    linksEl.hidden = true;
    linksEl.innerHTML = '';
  }

  updateTransposeUI();
  showPage('song-view', { resetScroll: true });
  if (pushHistory) {
    history.pushState({ page: 'song-view', songId: song.id, sourceKey }, '', location.href);
  }
}

function updateTransposeUI() {
  document.getElementById('transpose-offset').textContent =
    (state.transpose > 0 ? '+' : '') + state.transpose;
  document.getElementById('transpose-up').disabled = state.transpose >= TRANSPOSE_LIMIT;
  document.getElementById('transpose-down').disabled = state.transpose <= -TRANSPOSE_LIMIT;
  const song = state.activeSong;
  document.getElementById('sv-key').textContent = song ? transposeChord(song.key, state.transpose) : '—';
  renderLyrics();
}

function transposeChord(chord, steps) {
  if (!chord || !steps) return chord;
  // Split root (+ optional accidental) from the rest (quality/extensions), and handle slash bass.
  const parts = chord.split('/');
  const transposedParts = parts.map(part => transposeSingle(part, steps));
  return transposedParts.join('/');
}

function transposeSingle(token, steps) {
  const m = token.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return token;
  const [, letter, accidental, rest] = m;
  const useFlats = FLAT_KEYS.has(letter + (accidental || '') + (rest.startsWith('m') ? 'm' : ''));
  const name = letter + (accidental || '');
  let idx = CHROMATIC_SHARP.indexOf(name);
  if (idx === -1) idx = CHROMATIC_FLAT.indexOf(name);
  if (idx === -1) return token;
  const newIdx = ((idx + steps) % 12 + 12) % 12;
  const table = useFlats ? CHROMATIC_FLAT : CHROMATIC_SHARP;
  return table[newIdx] + rest;
}

function renderLyrics() {
  const container = document.getElementById('lyrics-container');
  const song = state.activeSong;
  container.innerHTML = '';
  if (!song) return;

  // Group lines into sections (verses/choruses) using blank lines as
  // boundaries — the same simple convention a future song editor can
  // produce by just leaving a blank line between parts. A section whose
  // first line starts with leading whitespace in the source is treated as
  // an indented part (e.g. a chorus set off from the verses), matching how
  // it's laid out in the original songbook document.
  const sections = [];
  let current = [];
  song.lyrics.forEach(rawLine => {
    if (rawLine.trim() === '') {
      if (current.length) { sections.push(current); current = []; }
    } else {
      current.push(rawLine);
    }
  });
  if (current.length) sections.push(current);

  // Only number parts when there's more than one — a single-section song
  // has nothing to distinguish, so a lone "1" would just be noise.
  const numberParts = sections.length > 1;

  sections.forEach((sectionLines, sectionIdx) => {
    const isIndented = /^\s{2,}/.test(sectionLines[0]);

    const sectionEl = document.createElement('div');
    sectionEl.className = 'lyric-section' + (isIndented ? ' is-indented' : '');

    if (numberParts) {
      const numEl = document.createElement('div');
      numEl.className = 'lyric-section-number';
      numEl.textContent = String(sectionIdx + 1);
      sectionEl.appendChild(numEl);
    }

    sectionLines.forEach((rawLine, lineIdx) => {
      // Leading whitespace on the first line is only a structural indent
      // marker (see isIndented above), not literal spacing to render.
      const line = lineIdx === 0 ? rawLine.replace(/^\s+/, '') : rawLine;

      const lineEl = document.createElement('div');
      lineEl.className = 'lyric-line';

      // Tokenize on [Chord] markers: each chord attaches to the text run that follows it,
      // up to the next chord marker (or end of line). Leading text with no chord is its own token.
      const chordPositions = [...line.matchAll(/\[([^\]]+)\]/g)];
      const tokens = [];
      if (chordPositions.length === 0) {
        tokens.push({ chord: null, text: line });
      } else {
        if (chordPositions[0].index > 0) {
          tokens.push({ chord: null, text: line.slice(0, chordPositions[0].index) });
        }
        chordPositions.forEach((cm, i) => {
          const textStart = cm.index + cm[0].length;
          const textEnd = i + 1 < chordPositions.length ? chordPositions[i + 1].index : line.length;
          tokens.push({ chord: cm[1], text: line.slice(textStart, textEnd) });
        });
      }

      tokens.forEach(tok => {
        const wrap = document.createElement('span');
        wrap.className = 'lyric-token';
        if (tok.chord) {
          const chordEl = document.createElement('span');
          chordEl.className = 'chord-tag';
          chordEl.textContent = transposeChord(tok.chord, state.transpose);
          wrap.appendChild(chordEl);
        } else if (tok.text) {
          const spacer = document.createElement('span');
          spacer.className = 'chord-tag-spacer';
          wrap.appendChild(spacer);
        }
        const textEl = document.createElement('span');
        textEl.className = 'lyric-word';
        textEl.textContent = tok.text || '\u00A0';
        wrap.appendChild(textEl);
        lineEl.appendChild(wrap);
      });

      sectionEl.appendChild(lineEl);
    });

    container.appendChild(sectionEl);
  });
}

// ---------------------------------------------------------
// Settings: theme, UI language, database select, install
// ---------------------------------------------------------
async function copyContactEmail(opts = {}) {
  const { silent = false } = opts;
  const email = (window.SONGBOOK_APP_CONFIG && window.SONGBOOK_APP_CONFIG.contactEmail) || '';
  if (!email) return;
  try {
    await navigator.clipboard.writeText(email);
    if (!silent) showToast(t('toastEmailCopied'));
  } catch (err) {
    console.error('Songbook: clipboard copy failed —', err);
    if (!silent) showToast(t('toastEmailCopyFailed'));
  }
}

// Puts the contact button/email-fallback back to its starting state: button
// visible, fallback hidden. Called on language refresh and every time the
// Settings page is (re)opened, so the button reliably comes back after
// switching pages, reloading, or reopening the app — even though within a
// single visit to Settings it disappears the moment it's clicked.
function resetContactUI() {
  const contactBtn = document.getElementById('about-contact-btn');
  const contactFallback = document.getElementById('about-contact-fallback');
  if (!contactBtn || !contactFallback) return;
  const email = (window.SONGBOOK_APP_CONFIG && window.SONGBOOK_APP_CONFIG.contactEmail) || '';
  if (!email) {
    contactBtn.hidden = true;
    contactFallback.hidden = true;
    return;
  }
  contactBtn.href = `mailto:${email}`;
  contactBtn.hidden = false;
  contactFallback.hidden = true;
}

function bindSettings() {
  document.getElementById('reload-songs-btn').addEventListener('click', reloadSongLibrary);
  document.getElementById('reload-app-btn').addEventListener('click', reloadApp);

  document.getElementById('about-contact-btn').addEventListener('click', () => {
    // Let the mailto: link proceed as normal (opens the person's mail app,
    // where available) — this fires alongside that, not instead of it.
    copyContactEmail({ silent: true });
    document.getElementById('about-contact-btn').hidden = true;
    document.getElementById('about-contact-fallback').hidden = false;
  });

  document.getElementById('about-contact-copy').addEventListener('click', () => {
    copyContactEmail();
  });

  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    toggle.setAttribute('aria-checked', String(next === 'dark'));
    localStorage.setItem('sb-theme', next);
  });

  document.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const accent = btn.dataset.accent;
      document.documentElement.setAttribute('data-accent', accent);
      localStorage.setItem('sb-accent', accent);
      document.querySelectorAll('.accent-swatch').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    });
  });

  const langSelect = document.getElementById('ui-lang-select');
  langSelect.addEventListener('change', () => {
    state.lang = langSelect.value;
    localStorage.setItem('sb-ui-lang', state.lang);
    applyLanguage();
  });

  const dbSelect = document.getElementById('db-select');
  // Only 'mn' is a real, selectable option right now (others are coming
  // soon) — this also corrects a stale value left over from an older
  // version of the app that allowed picking a different database.
  dbSelect.value = 'mn';
  localStorage.setItem('sb-db', 'mn');
  dbSelect.addEventListener('change', () => {
    localStorage.setItem('sb-db', dbSelect.value);
    showToast(t('toastDbSaved'));
  });
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

// ---------------------------------------------------------
// PWA: install prompt (Android/Desktop) + iOS fallback
// ---------------------------------------------------------
let deferredPrompt = null;
let installState = 'unavailable'; // 'unavailable' | 'insecure' | 'ios' | 'promptable' | 'installed'

function isStandaloneNow() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function setupInstallPrompt() {
  if (isStandaloneNow()) {
    installState = 'installed';
    refreshInstallLabels();
    return;
  }

  // Install (and the underlying service worker) only work on HTTPS or localhost —
  // this is a browser security requirement, not something the app can work around.
  if (!window.isSecureContext) {
    installState = 'insecure';
    refreshInstallLabels();
    return;
  }

  // Modern iPadOS (13+) spoofs its user agent as a desktop Mac by default, so a
  // plain UA check misses iPads. We additionally detect that case: a "MacIntel"
  // platform that actually has touch support is an iPad, not a real Mac.
  const ua = window.navigator.userAgent;
  const isSpoofedIPad = window.navigator.platform === 'MacIntel'
    && navigator.maxTouchPoints > 1
    && !window.MSStream;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || isSpoofedIPad;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installState = 'promptable';
    refreshInstallLabels();
  });

  document.getElementById('install-btn').addEventListener('click', async () => {
    if (deferredPrompt) {
      // The prompt is single-use: capture and clear it before awaiting, so a
      // stray second click can't reuse an already-consumed prompt event.
      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      promptEvent.prompt();
      await promptEvent.userChoice;
      // Intentionally not branching on `outcome` here: accepting the native
      // dialog does not guarantee installation actually completed. The
      // `appinstalled` event (and isStandaloneNow() as a fallback) is the
      // only source of truth for "installed" — see the listener below.
      if (!isStandaloneNow()) {
        installState = 'unavailable';
        refreshInstallLabels();
      }
    } else if (isIOS) {
      showToast(t('toastIosHint'));
    }
  });

  installState = isIOS ? 'ios' : 'unavailable';
  refreshInstallLabels();

  window.addEventListener('appinstalled', () => {
    installState = 'installed';
    refreshInstallLabels();
  });
}

function refreshInstallLabels() {
  const installBtn = document.getElementById('install-btn');
  const installedBadge = document.getElementById('installed-badge');
  const installSub = document.getElementById('install-sub');
  const installTitle = document.getElementById('install-title');

  installTitle.textContent = t('installTitle');
  installBtn.textContent = t('installBtn');

  switch (installState) {
    case 'installed':
      installBtn.hidden = true;
      installedBadge.hidden = false;
      installedBadge.textContent = t('installedBadgeDone');
      installSub.textContent = t('installSubInstalled');
      break;
    case 'insecure':
      installBtn.hidden = true;
      installedBadge.hidden = true;
      installSub.textContent = t('installSubInsecure');
      break;
    case 'ios':
      installBtn.hidden = false;
      installedBadge.hidden = true;
      installSub.textContent = t('installSubIOS');
      break;
    case 'promptable':
      installBtn.hidden = false;
      installedBadge.hidden = true;
      installSub.textContent = t('installSub');
      break;
    default:
      installBtn.hidden = true;
      installedBadge.hidden = true;
      installSub.textContent = t('installSub');
  }
}

// ---------------------------------------------------------
// Service worker registration (offline-first)
// Requires HTTPS or localhost — browsers refuse to register
// service workers on plain http:// or file:// origins.
// ---------------------------------------------------------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Songbook: service workers are not supported in this browser — offline mode and Install are unavailable.');
    return;
  }
  if (!window.isSecureContext) {
    console.warn('Songbook: not a secure context (HTTPS or localhost) — service worker registration skipped.');
    return;
  }

  // When an updated service worker takes over an already-open tab/PWA
  // window, the JS that's already parsed and running in memory here is
  // still the OLD version — only the *next* navigation gets the new files.
  // A single manual reload isn't reliably enough to trigger that either:
  // per the spec, a reload's navigation request can start (and still get
  // served by the outgoing worker) before the new one has fully taken
  // over. So instead of relying on the person to notice something's stale
  // and refresh, reload automatically — exactly once — the moment control
  // actually changes hands.
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    // updateViaCache: 'none' makes the browser always fetch this script
    // (and anything it imports) fresh over the network when checking for
    // updates, rather than potentially reusing an HTTP-cached copy.
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then((reg) => {
      console.log('Songbook: service worker registered with scope', reg.scope);
    }).catch(err => {
      console.error('Songbook: service worker registration failed —', err);
    });
  });
}
