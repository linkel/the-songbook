// Importing speedy-pitcher's library (#/import): recordings, loops and
// settings. On GitHub Pages both apps share an origin, so its IndexedDB can be
// read directly; anywhere else, speedy-pitcher's Settings → Export library
// makes a zip (js/zip.js) to import here. Each song is matched to one in your
// library by its title (or file name), like batch analysis, and you confirm.

import { esc, toast, ICONS } from "./ui.js";
import { loadLibrary, songKey, normTitle, addManualSong, put, get, getAll, savePrefs, loadPrefs } from "./library.js";
import { fromFileName } from "./tags.js";
import { saveRecording, recordingMeta, fmtBytes } from "./recordings.js";
import { readZip } from "./zip.js";
import { invalidateSongs } from "./songs.js";
import { PLAYER_DEFAULTS } from "./player.js";

const SP_DB = "speedy-pitcher";

// items: [{ spId, type, title, fileName, size, settings, loops, videoId, blob() }]
let pending = null;   // { from, items, rows }
let running = false;

export const importState = () => pending && { from: pending.from, rows: pending.rows.map((r) => ({ title: r.item.title, choice: r.choice, sure: r.sure, status: r.status })) };

// Is speedy-pitcher's library on this origin? Never opens (and so never
// creates) its database unless the browser lists it.
export async function speedyPitcherHere() {
  if (!indexedDB.databases) return false;
  try { return (await indexedDB.databases()).some((d) => d.name === SP_DB); } catch (e) { return false; }
}

function openSp() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SP_DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // It didn't exist after all: don't leave an empty one behind.
    req.onupgradeneeded = () => { req.transaction.abort(); };
  });
}

function spGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, "readonly").objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function spGet(db, store, id) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, "readonly").objectStore(store).get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function itemFrom(rec, blobFn, size) {
  return {
    spId: rec.id, type: rec.type === "youtube" ? "youtube" : "file", title: rec.title || rec.fileName || "Untitled",
    fileName: rec.fileName || null, mime: rec.mime || "", size: size ?? rec.size ?? 0, videoId: rec.videoId || null,
    sourceId: rec.sourceId || null, settings: rec.settings || {}, loops: rec.loops || [], blob: blobFn,
  };
}

export async function loadFromHere() {
  const db = await openSp();
  if (!db.objectStoreNames.contains("songs")) { db.close(); throw new Error("speedy-pitcher's library is empty here."); }
  const songs = await spGetAll(db, "songs");
  return songs.map((s) => itemFrom(s, async () => { const r = await spGet(db, "blobs", s.id); return r ? r.blob : null; }));
}

export async function loadFromZip(file) {
  const entries = await readZip(file);
  const lib = entries.get("library.json");
  if (!lib) throw new Error("That zip isn't a speedy-pitcher export (no library.json).");
  const data = JSON.parse(await lib.blob.text());
  if (!data || data.app !== "speedy-pitcher" || !Array.isArray(data.songs)) throw new Error("That zip isn't a speedy-pitcher export.");
  return data.songs.map((s) => {
    const name = [...entries.keys()].find((k) => k.startsWith(`audio/${s.id}.`));
    const entry = name ? entries.get(name) : null;
    return itemFrom(s, async () => (entry ? entry.blob : null), entry ? entry.size : 0);
  });
}

// "Artist - Title" (a file name or a YouTube title) -> a library match.
function matchItem(item, lib) {
  const base = item.title.replace(/\s*[([](official|lyrics?|audio|video|hd|hq)[^)\]]*[)\]]/gi, "");
  const guess = fromFileName(base + ".mp3");
  const tries = [guess, { title: base, artist: "" }];
  for (const g of tries) {
    const key = songKey(g.title, g.artist);
    const exact = [...lib.entries.values()].filter((e) => songKey(e.title, e.artist) === key);
    if (exact.length) return { id: exact[0].id, sure: true, guess };
  }
  for (const g of tries) {
    const nt = normTitle(g.title);
    const same = nt ? [...lib.entries.values()].filter((e) => normTitle(e.title) === nt) : [];
    if (same.length) return { id: same[0].id, sure: false, guess, candidates: same.slice(0, 12) };
  }
  return { id: null, sure: false, guess };
}

export async function startImport(from, items) {
  const lib = await loadLibrary();
  pending = {
    from,
    items,
    rows: items.map((item) => {
      const m = matchItem(item, lib);
      return { item, match: m, sure: m.sure, choice: m.id || "new", status: "waiting" };
    }),
  };
  location.hash = "#/import";
}

export async function renderImport(view) {
  const lib = await loadLibrary();
  const name = (id) => { const e = lib.entries.get(id); return e ? `${e.title} · ${e.artist}` : id; };
  if (!pending) {
    view.innerHTML = `<div class='topbar'><a class='back' href='#/settings' aria-label='Back to settings'>${ICONS.back}</a>
      <div class='topbar-title'><div class='t'>Import from speedy-pitcher</div></div></div>
      <div class='song-body'><div class='song-scroll'><div class='song-main-col'><div class='card empty'>Start an import from Settings.</div></div></div></div>`;
    return;
  }
  const todo = pending.rows.filter((r) => r.choice !== "skip" && r.status !== "done").length;
  view.innerHTML = `
    <div class='topbar'>
      <a class='back' href='#/settings' aria-label='Back to settings'>${ICONS.back}</a>
      <div class='topbar-title'><div class='t'>Import from speedy-pitcher</div><div class='meta'>${pending.from === "here" ? "Read from speedy-pitcher on this site" : "From an export file"} · ${pending.rows.length} songs</div></div>
    </div>
    <div class='song-body'><div class='song-scroll'><div class='song-main-col'>
      <p class='note' style='padding:0 2px'>Each song brings its recording, loops (to Practice) and player settings: speed, pitch, fine tune, count-in and trainer. A song that already has a recording here keeps it.</p>
      <div class='card list'>${pending.rows.map((r, i) => rowHtml(r, i, name)).join("")}</div>
      ${pending.rows.some((r) => r.match.id && !r.sure) ? "<p class='note'>“check” means only the title matched: make sure it's the right song.</p>" : ""}
    </div></div></div>
    <div class='transport always'>
      <a class='btn outline' href='#/settings'>Cancel</a>
      <button class='btn primary' data-act='import' style='flex:1' ${todo && !running ? "" : "disabled"}>${running ? "Importing…" : todo ? `Import ${todo}` : "Done"}</button>
    </div>`;
  view.querySelectorAll("select[data-row]").forEach((s) => s.addEventListener("change", () => { pending.rows[+s.dataset.row].choice = s.value; renderImport(view); }));
  view.querySelector("[data-act=import]").addEventListener("click", () => run(view));
}

function rowHtml(r, i, name) {
  const it = r.item;
  const what = it.type === "youtube" ? "YouTube link" : it.size ? fmtBytes(it.size) : "file";
  const loops = it.loops.length ? ` · ${it.loops.length} loop${it.loops.length === 1 ? "" : "s"}` : "";
  const opts = [];
  if (r.match.id) opts.push([r.match.id, name(r.match.id) + (r.sure ? "" : " (check)")]);
  for (const c of r.match.candidates || []) if (c.id !== r.match.id) opts.push([c.id, `${c.title} · ${c.artist}`]);
  opts.push(["new", `Add as a new song: ${r.match.guess.title}${r.match.guess.artist ? " · " + r.match.guess.artist : ""}`], ["skip", "Skip"]);
  const status = r.status === "done" ? "<span class='badge mine'>Imported</span>" : r.status === "error" ? `<span class='badge need' title='${esc(r.error)}'>Failed</span>`
    : r.status === "busy" ? "<span class='meta'>…</span>" : r.match.id && !r.sure ? "<span class='badge detected'>check</span>" : "";
  return `<div class='row batch-row'>
    <div style='min-width:0;flex:1'><div class='set-label ellipsis'>${esc(it.title)}</div><div class='meta'>${what}${loops}</div>
      <select class='select' data-row='${i}' aria-label='Import ${esc(it.title)} into' ${running || r.status === "done" ? "disabled" : ""}>${opts.map(([v, l]) =>
        `<option value='${esc(v)}' ${v === r.choice ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
    ${status}</div>`;
}

async function run(view) {
  if (running) return;
  running = true;
  renderImport(view);
  let n = 0;
  for (const r of pending.rows) {
    if (r.choice === "skip" || r.status === "done") continue;
    r.status = "busy";
    renderImport(view);
    try {
      await importOne(r);
      r.status = "done";
      n++;
    } catch (e) {
      r.status = "error";
      r.error = e.message || String(e);
    }
  }
  running = false;
  invalidateSongs();
  renderImport(view);
  toast(`Imported ${n} song${n === 1 ? "" : "s"} from speedy-pitcher.`);
}

async function importOne(r) {
  const it = r.item;
  let id = r.choice;
  if (id === "new") id = await addManualSong(r.match.guess.title, r.match.guess.artist || "");
  const chart = await get("charts", id).catch(() => null);
  const prefs = await loadPrefs(id, chart);
  const s = it.settings || {};
  const player = { ...structuredClone(PLAYER_DEFAULTS), ...(prefs.player || {}) };
  Object.assign(player, {
    speed: s.speed ?? player.speed, semis: s.semis ?? player.semis, cents: s.cents ?? player.cents, formant: !!s.formant,
    // A fine tune set in speedy-pitcher is kept, not matched over.
    ...(s.cents ? { matchTuning: false } : {}),
    a: s.a ?? null, b: s.b ?? null, loopOn: !!s.loopOn, position: s.position || 0,
    countIn: s.countIn || 0, trainer: { ...player.trainer, ...(s.trainer || {}) },
  });
  if (it.type === "youtube") {
    player.youtube = { id: it.videoId, title: it.title };
    if (!(await recordingMeta(id))) player.source = "youtube";
  } else {
    const have = await recordingMeta(id);
    if (!have) {
      const blob = await it.blob();
      if (blob) {
        await saveRecording(id, new File([blob], it.fileName || it.title + ".m4a", { type: it.mime || blob.type || "audio/mp4" }),
          { source: "speedy-pitcher", link: it.sourceId ? "https://www.youtube.com/watch?v=" + it.sourceId : null });
      }
    }
    player.source = "file";
  }
  prefs.player = player;
  await savePrefs(id, prefs);
  // Loops go to Practice (once).
  const existing = (await getAll("loops").catch(() => [])).filter((l) => l.songId === id);
  const lib = await loadLibrary();
  const entry = lib.entries.get(id);
  for (const [k, l] of it.loops.entries()) {
    if (existing.some((x) => Math.abs(x.a - l.a) < 0.01 && Math.abs(x.b - l.b) < 0.01)) continue;
    await put("loops", { id: `sp-${it.spId}-${k}`, songId: id, name: l.name || `Loop ${k + 1}`, a: l.a, b: l.b, bars: null,
      createdAt: Date.now(), practice: null, title: entry ? entry.title : r.match.guess.title, artist: entry ? entry.artist : r.match.guess.artist, from: "speedy-pitcher" });
  }
}
