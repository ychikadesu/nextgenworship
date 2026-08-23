// Songbook service worker — offline-first app shell + data cache.
// Bump CACHE_VERSION whenever shipped files change so clients pick up updates.
const CACHE_VERSION = 'songbook-v1.0.1';

// The core shell: without any one of these the app can't run at all, so
// these are cached atomically — if even one fails, the whole install fails
// and the OLD service worker (and its cache) stays in control until a
// retry succeeds. This is intentional for the core shell.
const CORE_SHELL = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './config.js',
  './lang/config.js',
  './lang/eng.js',
  './lang/mn.js',
  './lang/kr.js',
  './lang/mn2.js',
];

// Icons and other assets: cached best-effort, one at a time. A single
// missing or renamed file here (e.g. after swapping in a custom icon)
// must NEVER be able to fail the whole install — that would leave every
// visitor stuck on an old cached version indefinitely, with no way to
// pick up a fix short of manually clearing site data.
const BEST_EFFORT_ASSETS = [
  './icons/app-icon-192.png',
  './icons/app-icon-512.png',
  './icons/app-icon-maskable-192.png',
  './icons/app-icon-maskable-512.png',
  './icons/splash-logo.png',
  './icons/about-logo.png',

  './icons/svg/brand-music-note.svg',
  './icons/svg/search.svg',
  './icons/svg/back-arrow.svg',
  './icons/svg/mail-contact.svg',
  './icons/svg/copy.svg',
  './icons/svg/nav-songs-bookmark.svg',
  './icons/svg/nav-settings-gear.svg',
  './icons/svg/social-facebook.svg',
  './icons/svg/social-youtube.svg',
  './icons/svg/social-instagram.svg',
  './icons/svg/social-website.svg',
];

function cacheBestEffort(cache, urls) {
  return Promise.allSettled(
    urls.map((url) =>
      cache.add(url).catch((err) => {
        console.warn('Songbook SW: could not precache', url, '—', err);
      })
    )
  );
}

self.addEventListener('install', (event) => {
  // Deliberately minimal and fast: only the small core shell is required
  // for the install to succeed. A slow or interrupted install is exactly
  // the kind of thing aggressive mobile battery/task managers cut short —
  // keeping this fast is what makes the install itself reliable.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(CORE_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );

  // Bulk precaching of icons + all song files happens here, in the
  // background, deliberately OUTSIDE of event.waitUntil — so activation
  // itself completes fast and unconditionally, and this can never delay or
  // break it. If it gets interrupted partway (tab closed, device sleeps),
  // it simply doesn't finish this time; nothing is left broken, and songs
  // still get cached individually as they're viewed via the fetch handler
  // below, plus the IndexedDB backup in app.js covers the rest.
  precacheEverythingElseInBackground();
});

function precacheEverythingElseInBackground() {
  caches.open(CACHE_VERSION).then((cache) => {
    cacheBestEffort(cache, BEST_EFFORT_ASSETS);
    fetch('./data/songs/manifest.json')
      .then((res) => res.json())
      .then((songFiles) => {
        const songUrls = songFiles.map((f) => `./data/songs/${f}`);
        return cacheBestEffort(cache, ['./data/songs/manifest.json', ...songUrls]);
      })
      .catch((err) => {
        console.warn('Songbook SW: background song precache skipped —', err);
      });
  });
}

// Strategy: cache-first for everything, EXCEPT requests explicitly marked
// as a manual refresh (X-Force-Refresh header) — those go network-first,
// updating the cache on success, and fall back to whatever's already
// cached if the network fails. This means a manual refresh attempted while
// offline just silently keeps the existing offline copy instead of ever
// deleting it — the cache is only ever replaced by data that's confirmed
// to have loaded successfully, never cleared ahead of time "just in case".
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.headers.get('X-Force-Refresh') === '1') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          if (cached) return cached;
          // Nothing cached AND the network failed. For a page navigation,
          // this is the case that used to fall through to the browser's
          // own generic "no internet" page — jarring in an installed app.
          // Show our own offline screen instead (also core-shell cached,
          // so it's always available). Any other kind of request (a
          // script, an image, song data) just fails as before; the app's
          // own code already handles those (e.g. loadSongData()'s
          // IndexedDB fallback).
          const isNavigation = event.request.mode === 'navigate'
            || event.request.destination === 'document';
          return isNavigation ? caches.match('./offline.html') : undefined;
        });

      return cached || networkFetch;
    })
  );
});
