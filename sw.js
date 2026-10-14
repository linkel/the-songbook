// Bump the version on every change, so installed copies pick up the update.
const CACHE = "songbook-v1";

// The app shell and shipped data. Large optional assets (WASM, models) are not
// listed: they're cached the first time they're fetched.
const ASSETS = [
  ".",
  "index.html",
  "style.css",
  "manifest.json",
  "icon-180.png",
  "icon-512.png",
  "js/app.js",
  "js/audio.js",
  "js/scheduler.js",
  "js/chartplay.js",
  "js/chords.js",
  "js/diagram.js",
  "js/patterns.js",
  "js/notation.js",
  "js/library.js",
  "js/songs.js",
  "js/sheet.js",
  "js/ui.js",
  "vendor/chords-db/guitar.json",
  "songs/index.json",
  "songs/babe-im-gonna-leave-you.json",
  "songs/candy-man.json",
  "songs/dear-prudence.json",
  "songs/dont-think-twice-its-all-right.json",
  "songs/dust-in-the-wind.json",
  "songs/freight-train.json",
  "songs/julia.json",
  "songs/landslide.json",
  "songs/nothing-else-matters.json",
  "songs/romance.json",
  "songs/the-boxer.json",
  "songs/the-house-of-the-rising-sun.json",
  "songs/the-sound-of-silence.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("songbook-") && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for the app's own files, falling back to the cache: updates
// arrive when online, and everything already seen works offline. Other origins
// (YouTube, the PC helper) and the private/ folder are left alone.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/private/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
