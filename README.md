# Next Gen Worship — Worship Song App (v1.0.0 — first official release)

An offline-first worship songbook PWA. Static HTML/CSS/JS, no build step, no
backend — built to run on GitHub Pages and install like a native app.

This is **Version 1** of the planning doc's roadmap: official songs, settings,
light/dark mode, smart search, and chord transpose. User Songs, Playlists,
and Sheet Music are Version 2+ — see "Built for what's next", below, for how
the app is already set up to grow into them without a rewrite.

## What's in this version

- Official songs library with search (title, song number, artist, and lyric
  phrases — try searching "God awesome")
- Sort: A–Z, Z–A, number low–high, number high–low
- Song view with chords rendered above lyrics
- Chord transpose (up/down by semitone, resets to original key)
- Independent lyric and chord font size controls
- Light / dark mode (saved on-device)
- **Interface language: Mongolian (default) and English**, switchable in
  Settings
- Settings page with a song-database selector and an **Install App** button
- Full PWA support: manifest, service worker, offline caching
- Bottom navigation shows only what's live in this version (Songs, Settings) —
  User Songs, Playlists, and Sheet Music are not yet in the nav; they'll be
  added back in when their versions land

## Project structure

```
index.html          App shell — every page lives here, toggled by JS
offline.html         Self-contained offline fallback page (see "Offline screen" below)
css/style.css        Design tokens + styles (light & dark themes)
js/app.js            All app logic: search, sort, transpose, language switching, install
app.js               Mirror of js/app.js — not loaded by index.html; kept in
                     sync as a convenience copy at the repo root
data/songs/           One JSON file per song + manifest.json listing them
lang/*.js         Interface text — one file per language (config.js + eng.js/mn.js/kr.js)
manifest.json         PWA manifest
service-worker.js     Offline caching (cache-first w/ background refresh)
icons/                App icons, logos, and icons/svg/ — one SVG file per UI icon
```

`index.html` only ever loads `js/app.js` — if you edit app logic, edit
`js/app.js` and copy the same change into the root `app.js` (or just remove
the root copy if it isn't needed; it's not referenced anywhere).

## Why song data moved to one JSON file per song

Each song is its own file under `data/songs/` (e.g. `s001.json`), listed in
`data/songs/manifest.json`. This makes adding, editing, or handing off a
single song trivial — no more scrolling a 2,000-line file to find one song,
and version-control diffs stay small and readable.

**Trade-off:** this loads the data with `fetch()`, which browsers block when
a page is opened directly from disk (`file://…/index.html`) — the exact
problem an earlier draft of this app avoided by using a single `.js` file
with a global variable instead. That workaround is gone now. **The app must
be served over `http://` or `https://`** — even `http://localhost` is
enough — for the song list to load at all. This same requirement already
applied to installability and offline support, so it isn't a new category of
limitation, just a stricter version of one that was already there.

## Replacing an icon

Every icon the app uses lives as its own file under `icons/svg/` (search,
back arrow, contact envelope, social icons, etc — names are descriptive, e.g.
`nav-songs-bookmark.svg`). To swap one out, just replace that file's content
with a different SVG — the app fetches and injects each icon at runtime, so
no code changes are needed, and a replacement with a different `viewBox`
still renders correctly. The splash-screen and about-page logos
(`icons/splash-logo.png`, `icons/about-logo.png`) are separate PNGs and can
be swapped the same simple way — the splash logo in particular is shown at
its own aspect ratio, never stretched, whatever size image you give it.

## Editing the song list

To add a song: create `data/songs/sNNN.json` (copy an existing one as a
template) and add its filename to `data/songs/manifest.json`. To edit a
song: open its file directly. Nothing in `js/app.js` needs to change either
way — the manifest is the only "index" the app needs.

Chords are written inline in the lyric line using square brackets right
before the syllable they land on:

```js
"lyrics": [
  "[Am]Oh Holy [G]Amazing God we pray"
]
```

renders as "Am" above "Oh" and "G" above "Amazing". A `""` empty string in
the `lyrics` array creates a blank line (verse/chorus break).

Fields match the planning doc's data structure: `id`, `number`, `title`,
`alternateTitles`, `artist`, `key`, `lyrics`, `labels`, `metadata`, `audio`,
`sheetMusic`. `audio` and `sheetMusic` are wired into the data model now so
later versions can light them up without a schema change.

## Interface language (Mongolian / English)

`lang/` holds one file per interface language (config.js sets the default and order). The app defaults to
**Mongolian** — set by `window.SONGBOOK_DEFAULT_LANG = "mn"` at the bottom of
that file. Change that line to `"en"` if you want English as the default;
either way, people can switch languages themselves from **Settings → App
language**, and their choice is remembered on their device.

This is the *interface* language (menus, buttons, labels) — separate from
the song database selector, which controls which songbook's content you're
viewing, matching the plan's note that these are independent settings.

To add a new language: copy `lang/eng.js`, translate every value, set its key, add a <script> line in index.html
each value, add it under a new key (e.g. `ko`), and add an `<option>` for it
in the `#ui-lang-select` dropdown in `index.html`.

## Running locally

Any static file server works, e.g.:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Opening `index.html` directly via `file://` now works for browsing and
searching songs too (see above), but **the service worker and the Install
button require HTTPS or `localhost`** — that's a browser security rule, not
something this app can opt out of. Use a local server (or GitHub Pages) to
test those two specifically. When the page isn't on a secure origin, the
Install row in Settings explains this instead of showing a dead button.

## Deploying to GitHub Pages

1. Create a new GitHub repository and push this folder's contents to it
   (this folder should be the repo root, or the root of the branch/folder
   you configure Pages to serve).
2. In the repo: **Settings → Pages → Build and deployment → Source** = "Deploy
   from a branch", pick `main` and `/ (root)`.
3. Wait for the Pages build to finish, then visit the URL GitHub gives you
   (`https://<username>.github.io/<repo-name>/`).
4. All paths in this project are relative (`./`, `css/…`, `data/…`), so it
   works whether it's served from a root domain or a `/repo-name/`
   subpath — no path edits needed.
5. GitHub Pages serves everything over HTTPS automatically, which is exactly
   what the service worker and Install button need to work.

### Updating the app later

Bump `CACHE_VERSION` at the top of `service-worker.js` (e.g. `songbook-v1.0.1`)
whenever you ship changed files. That's what tells installed devices to fetch
the new version instead of serving the old cached copy. Also bump
`APP_VERSION` at the top of `js/app.js` (and its mirror at the repo root,
`app.js` — see below) when app logic changes, since that drives the
hard-update backstop described in that file's own comments.

## Installing the app (PWA)

- **Android / Desktop Chrome, Edge:** open the site (over HTTPS), go to
  **Settings → Install app**, or use the browser's own install icon in the
  address bar. The button only appears once the browser decides the site is
  installable — that can take a moment after the page first loads.
- **iOS Safari:** Safari doesn't support the automatic install prompt, so the
  Install button opens a hint instead — tap the **Share** icon, then
  **Add to Home Screen**.
- Once installed, the Settings page shows an "Installed" badge instead of
  the button.
- **If Install still doesn't appear on a real HTTPS deployment:** check the
  browser console for a service worker registration error, and confirm
  `manifest.json` and both icon files are reachable at their exact paths —
  those are the two most common installability blockers.

## Offline screen

`offline.html` is a small, self-contained fallback page (no dependency on
`css/style.css`, fonts, or `js/app.js` — deliberately, since it exists for
the case where something else failed to load) that the service worker shows
instead of the browser's own generic "no internet" page whenever a page
navigation fails with nothing cached to fall back to — the thing that used
to make an installed, offline PWA suddenly look like a broken website. It
reads the same `sb-theme` / `sb-accent` / `sb-ui-lang` values from
`localStorage` that the main app saves, so it matches light/dark mode,
accent color, and language without needing its own settings. It's part of
`CORE_SHELL` in `service-worker.js`, so it's always cached alongside the
rest of the required app shell.

Settings → **Reload app** also checks `navigator.onLine` before doing
anything: while offline, it skips clearing the cache/service worker (there's
nothing to safely replace them with without a connection) and just reloads
normally instead, so the still-cached app keeps working rather than
reloading into a blank/broken page.

## Built for what's next

Version 1 only ever shows one song list (Songs) and two pages (Songs,
Settings), but the underlying code doesn't assume that's all there'll ever
be. Four things were generalized ahead of time specifically so Version 2+
(User Songs, Playlists, Sheet Music) can be added without reworking existing
code:

- **Song data (`state.sources`)** — songs live under `state.sources.official`,
  not a single flat list. Adding a `state.sources.user` entry for User Songs
  is additive; `renderSongList()`, `matchesQuery()`, `sortSongs()`, and
  `openSong()` already take a source key as a parameter instead of assuming
  `official` is the only source.
- **Pages (`PAGES` registry in `js/app.js`)** — `showPage()` and `bindNav()`
  read every page's element id, which nav button lights up for it, and
  whether it hides the bottom bar from one `PAGES` object, instead of
  hardcoded if/else branches. Adding a page (e.g. `user-songs`) means adding
  one `PAGES` entry, one `<main id="…">`, and one `<button data-nav="…">` —
  not touching the routing logic itself.
- **Offline backup (`SONGDB_STORES` in `js/app.js`)** — the IndexedDB backup
  already has a reserved `user-songs` object store (unused, empty, until v2
  starts writing to it), so turning on User Songs won't need another
  IndexedDB version bump/migration down the line.
- **Bottom nav (`.bottom-nav-inner` in `css/style.css`)** — the nav buttons
  are laid out with `flex: 1 1 0` + `space-evenly` inside a width-capped
  inner wrapper, so it distributes cleanly whether there are 2 buttons (now)
  or 5 (once User Songs, Playlists, and Sheet Music are added) — no gap/width
  retuning needed.

A few things this does *not* pre-build, on purpose (per the plan's "avoid
unnecessary complexity early"): there's still only one on-screen song list
and one song-view page in the DOM — a second page for User Songs still needs
its own `<main>`, its own nav button, and its own loader (User Songs are
locally-imported, not `fetch()`-loaded from a manifest like official songs,
so `fetchSongData()` itself is intentionally left specific to the official
source rather than generalized to a fetch pattern that wouldn't fit User
Songs anyway). The song data model also already includes `labels`, `audio`,
and `sheetMusic` fields so Version 3+ features don't require restructuring
existing song data.
