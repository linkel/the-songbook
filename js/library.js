// On-device data: IndexedDB "songbook" (library, charts, sheets, lyricTiming,
// arrangements, loops, songPrefs), plus the shipped charts in songs/.
// The database name and every localStorage key start with "songbook" because
// Pimapeggio and speedy-pitcher share this origin on GitHub Pages.
// The IndexedDB helpers follow speedy-pitcher's js/library.js.

const DB_NAME = "songbook";
const DB_VERSION = 1;
export const STORES = ["library", "charts", "sheets", "lyricTiming", "arrangements", "loops", "songPrefs"];

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
    t.onerror = () => reject(t.error);
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
    capo: chart && chart.capo ? chart.capo : 0,
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

export async function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch (e) { return false; }
  }
  return false;
}
