// On-device data: IndexedDB "songbook" (library, charts, sheets, lyricTiming, parts,
// arrangements, loops, songPrefs, recordings), plus the shipped charts in songs/.
// The database name and every localStorage key start with "songbook" because
// Pimapeggio and speedy-pitcher share this origin on GitHub Pages.
// The IndexedDB helpers follow speedy-pitcher's js/library.js.

const DB_NAME = "songbook";
const DB_VERSION = 3;
export const STORES = ["library", "charts", "sheets", "lyricTiming", "arrangements", "parts", "loops", "songPrefs", "recordings"];

let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("The songbook database is open in an older tab."));
    });
  }
  return dbp;
}

function tx(stores, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error("This browser wouldn't store that here (private browsing?)."));
    t.onabort = () => reject(t.error || new Error("Storage transaction aborted"));
  }));
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const get = (store, id) => tx([store], "readonly", (t) => req(t.objectStore(store).get(id)));
export const getAll = (store) => tx([store], "readonly", (t) => req(t.objectStore(store).getAll()));
export const put = (store, value) => tx([store], "readwrite", (t) => { t.objectStore(store).put(value); });
export const del = (store, id) => tx([store], "readwrite", (t) => { t.objectStore(store).delete(id); });

/* ---- Song prefs: transpose, capo, simple, font size, tempo, chosen voicings ---- */

export function defaultPrefs(chart) {
  return {
    transpose: 0,
    capo: null,        // null: as the chart or sheet is written
    simple: false,
    font: 0,           // steps from the default sheet font size
    tempo: chart && chart.tempo ? chart.tempo : null,
    voicings: {},      // chord name -> chosen shape spec
  };
}

export async function loadPrefs(id, chart) {
  try {
    const p = await get("songPrefs", id);
    return { ...defaultPrefs(chart), ...(p ? p.prefs : {}) };
  } catch (e) {
    return defaultPrefs(chart);
  }
}

export function savePrefs(id, prefs) {
  return put("songPrefs", { id, prefs, savedAt: Date.now() }).catch(() => {});
}

/* ---- Shipped charts (songs/index.json + songs/<id>.json) ---- */

let shippedIndex = null;
const chartCache = new Map();

export async function shippedSongs() {
  if (!shippedIndex) {
    const res = await fetch("songs/index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("songs/index.json: " + res.status);
    shippedIndex = (await res.json()).songs;
  }
  return shippedIndex;
}

export async function loadChart(id) {
  if (chartCache.has(id)) return chartCache.get(id);
  // A chart of the owner's own (edited or detected) wins over the shipped one.
  let chart = null;
  try { chart = await get("charts", id); } catch (e) { /* no IndexedDB */ }
  if (!chart) {
    const index = await shippedSongs();
    if (!index.some((s) => s.id === id)) return null;
    const res = await fetch("songs/" + encodeURIComponent(id) + ".json", { cache: "no-cache" });
    if (!res.ok) return null;
    chart = await res.json();
  }
  chartCache.set(id, chart);
  return chart;
}

/* ---- Song identity ----
   A song is its normalised title and first artist, so the same song in Liked
   songs, a playlist, a hand-added entry and a shipped chart is one song, and
   ids stay the same when the export is refreshed. */

const fold = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const VERSION_WORDS = /remaster|version|live|mono|stereo|edit|mix|recorded|demo|single|bonus|acoustic|from |feat|with /i;

export function normTitle(t) {
  let s = String(t || "");
  // "Song - 2011 Remaster", "Song (feat. X)", "Song [Live]"
  s = s.replace(/\s+-\s+([^-]*)$/, (m, tail) => (VERSION_WORDS.test(tail) ? "" : m));
  s = s.replace(/\s*[([][^)\]]*(?:feat|with|remaster|version|live|mono|stereo|edit|mix|acoustic|demo)[^)\]]*[)\]]/gi, "");
  return fold(s).replace(/^(the|a|an)\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function normArtist(a) {
  const first = String(a || "").split(/,\s+/)[0];
  return fold(first).replace(/^the\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export const songKey = (title, artist) => normTitle(title) + "|" + normArtist(artist);

// FNV-1a, base 36: short ids that are safe in a URL.
export function songIdFor(title, artist) {
  let h = 0x811c9dc5;
  for (const ch of songKey(title, artist)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return "s" + h.toString(36);
}

/* ---- The library: the Spotify export, songs added by hand, shipped charts ---- */

const EXPORT_ID = "spotify-export";
let libraryPromise = null;

export function isLocal() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

// Throws with a readable message if the file isn't a library export.
export function validateExport(data) {
  if (!data || typeof data !== "object") throw new Error("That file isn't JSON from the import tool.");
  const liked = Array.isArray(data.liked) ? data.liked : [];
  const playlists = Array.isArray(data.playlists) ? data.playlists : [];
  if (!liked.length && !playlists.length) throw new Error("No liked songs or playlists in that file.");
  const ok = (s) => s && typeof s.title === "string" && typeof s.artist === "string";
  if (!liked.every(ok) || !playlists.every((p) => typeof p.name === "string" && Array.isArray(p.songs) && p.songs.every(ok))) {
    throw new Error("Some songs in that file have no title or artist.");
  }
  return { fetched: data.fetched || null, liked, playlists };
}

export async function importLibraryText(text, from = "file") {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("That file isn't valid JSON."); }
  const v = validateExport(data);
  await put("library", { id: EXPORT_ID, ...v, from, importedAt: Date.now() });
  invalidateLibrary();
  requestPersist();
  return v;
}

export function invalidateLibrary() { libraryPromise = null; }

// Locally (python -m http.server), private/spotify-library.json is read when
// it's newer than what's stored. On Pages it doesn't exist.
async function refreshFromLocalFile() {
  if (!isLocal()) return;
  try {
    const res = await fetch("private/spotify-library.json", { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    const v = validateExport(data);
    const stored = await get("library", EXPORT_ID).catch(() => null);
    if (!stored || stored.fetched !== v.fetched) await put("library", { id: EXPORT_ID, ...v, from: "local file", importedAt: Date.now() });
  } catch (e) { /* no file, or not a library: fine */ }
}

export function loadLibrary() {
  if (!libraryPromise) libraryPromise = buildLibrary();
  return libraryPromise;
}

async function buildLibrary() {
  await refreshFromLocalFile();
  const [exp, records, shipped] = await Promise.all([
    get("library", EXPORT_ID).catch(() => null),
    getAll("library").catch(() => []),
    shippedSongs().catch(() => []),
  ]);
  const entries = new Map();   // id -> entry
  const byKey = new Map();     // song key -> id
  const shippedByKey = new Map(shipped.map((s) => [songKey(s.title, s.artist), s]));

  const add = (song, list) => {
    const key = songKey(song.title, song.artist);
    let id = byKey.get(key);
    if (!id) {
      const sh = shippedByKey.get(key);
      id = sh ? sh.id : songIdFor(song.title, song.artist);
      byKey.set(key, id);
      entries.set(id, { id, title: song.title, artist: song.artist, album: song.album || "", lists: [], added: song.added || null, shipped: sh || null, manual: false });
    }
    const e = entries.get(id);
    if (list && !e.lists.includes(list)) e.lists.push(list);
    if (song.added && (!e.added || song.added > e.added)) e.added = song.added;
    return id;
  };

  const lists = [];
  if (exp) {
    const liked = [...exp.liked].sort((a, b) => String(b.added || "").localeCompare(String(a.added || "")));
    lists.push({ name: "Liked songs", ids: liked.map((s) => add(s, "Liked songs")) });
    for (const p of exp.playlists) {
      if (!p.songs.length) continue;
      lists.push({ name: p.name, ids: [...new Set(p.songs.map((s) => add(s, p.name)))] });
    }
  }
  const manual = records.filter((r) => r.kind === "manual").sort((a, b) => a.addedAt - b.addedAt);
  if (manual.length) {
    const ids = manual.map((m) => { const id = add(m, "Added by hand"); entries.get(id).manual = true; return id; });
    lists.push({ name: "Added by hand", ids });
  }
  // Shipped charts that aren't in the library still show up.
  for (const s of shipped) {
    if (!entries.has(s.id)) entries.set(s.id, { id: s.id, title: s.title, artist: s.artist, album: "", lists: [], added: null, shipped: s, manual: false });
  }
  return {
    entries, lists,
    meta: exp ? { fetched: exp.fetched, importedAt: exp.importedAt, from: exp.from, liked: exp.liked.length, playlists: exp.playlists.length } : null,
  };
}

export async function getEntry(id) {
  return (await loadLibrary()).entries.get(id) || null;
}

export async function addManualSong(title, artist) {
  title = String(title || "").trim();
  artist = String(artist || "").trim();
  if (!title) throw new Error("A song needs a title.");
  const id = songIdFor(title, artist);
  const lib = await loadLibrary();
  if (!lib.entries.has(id)) {
    await put("library", { id: "manual:" + id, kind: "manual", title, artist, addedAt: Date.now() });
    invalidateLibrary();
  }
  return id;
}

export async function deleteManualSong(id) {
  await del("library", "manual:" + id);
  invalidateLibrary();
}

/* ---- Sheets (ChordPro, device only) ---- */

export const getSheet = (id) => get("sheets", id).catch(() => null);
export const allSheets = () => getAll("sheets").catch(() => []);
export async function saveSheet(rec) { await put("sheets", { ...rec, savedAt: Date.now() }); requestPersist(); }
export const deleteSheet = (id) => del("sheets", id);

// Charts of the owner's own (detected or checked) in IndexedDB.
export const deviceCharts = () => getAll("charts").catch(() => []);
export async function saveChart(chart) { await put("charts", { ...chart, savedAt: Date.now() }); chartCache.delete(chart.id); }
export async function deleteChart(id) { await del("charts", id); chartCache.delete(id); }
export async function shippedChart(id) {
  const index = await shippedSongs().catch(() => []);
  if (!index.some((s) => s.id === id)) return null;
  const res = await fetch("songs/" + encodeURIComponent(id) + ".json", { cache: "no-cache" });
  return res.ok ? res.json() : null;
}

export async function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch (e) { return false; }
  }
  return false;
}
