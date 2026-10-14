// The Songbook: tabs, routing (#/songs, #/practice, #/settings,
// #/song/<id>/<mode>[/<loop>], #/analyse, #/import), theme, settings and start-up.

import { setChordDb } from "./chords.js";
import { renderSongs, invalidateSongs } from "./songs.js";
import { openSong, closeSong, togglePlay, transposeBy, tempoBy, toggleScroll, songMode, songState, getPlayer } from "./song.js";
import { loadLibrary, importLibraryText, get, deviceCharts, shippedChart, songIdFor, getSheet } from "./library.js";
import { parseChordPro } from "./chordpro.js";
import { lyricLines } from "./lyrics.js";
import { chartsFile } from "./chartfile.js";
import { storageInfo, listRecordings, deleteRecording, fmtBytes, listStems, deleteStems, stemsSize } from "./recordings.js";
import { importBundle } from "./bundle.js";
import { readZip } from "./zip.js";
import { renderBatch } from "./batch.js";
import { onAudioState, resumeAudio, StringVoices, strum, warmNotes, audioContext } from "./audio.js";
import { esc, toast, hideToast, popoverOpen, closePopover } from "./ui.js";
import { renderPractice } from "./practice.js";
import { playerState, speedBy, pitchBy, loopCurrentSection, focusMixer, playerNow } from "./player.js";
import { helperUrl, setHelperUrl, pingHelper } from "./helper-client.js";
import { lrclibOn, setLrclib } from "./prefs.js";
import { speedyPitcherHere, loadFromHere, loadFromZip, startImport, renderImport, importState } from "./spimport.js";
import { pcJobs } from "./pcjob.js";

export const VERSION = "0.6.0";

const views = {
  songs: document.getElementById("view-songs"),
  practice: document.getElementById("view-practice"),
  settings: document.getElementById("view-settings"),
  song: document.getElementById("view-song"),
  batch: document.getElementById("view-batch"),
  import: document.getElementById("view-import"),
};

/* ---- Theme: auto (system) / Mocha / Latte ---- */

const THEME_KEY = "songbook-theme";
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function themePref() {
  try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { return "auto"; }
}

export function applyTheme(pref = themePref()) {
  const theme = pref === "mocha" || pref === "latte" ? pref : (darkQuery.matches ? "mocha" : "latte");
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector("meta[name=theme-color]");
  if (meta) meta.content = theme === "mocha" ? "#181825" : "#e6e9ef";
}

function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* blocked */ }
  applyTheme(pref);
}

darkQuery.addEventListener("change", () => { if (themePref() === "auto") applyTheme(); });

/* ---- Routing ---- */

let route = { name: "songs" };

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "song" && parts[1]) return { name: "song", id: parts[1], mode: parts[2] || null, arg: parts[3] || null };
  if (parts[0] === "practice" || parts[0] === "settings") return { name: parts[0] };
  if (parts[0] === "analyse") return { name: "batch" };
  if (parts[0] === "import") return { name: "import" };
  return { name: "songs" };
}

async function go() {
  const prev = route;
  route = parseHash();
  if (prev.name === "song" && (route.name !== "song" || route.id !== prev.id)) closeSong();
  for (const [name, el] of Object.entries(views)) el.classList.toggle("hidden", name !== route.name);
  document.body.classList.toggle("in-song", ["song", "batch", "import"].includes(route.name));
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === route.name;
    t.classList.toggle("on", on);
    if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  });
  if (route.name === "songs") await renderSongs(views.songs);
  else if (route.name === "practice") await renderPractice(views.practice);
  else if (route.name === "settings") await renderSettings();
  else if (route.name === "song") await openSong(views.song, route.id, route.mode, route.arg);
  else if (route.name === "batch") await renderBatch(views.batch);
  else if (route.name === "import") await renderImport(views.import);
}

window.addEventListener("hashchange", go);

/* ---- Settings tab ---- */

async function renderSettings() {
  const pref = themePref();
  const lib = await loadLibrary();
  const m = lib.meta;
  const when = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const libText = m
    ? `${m.liked.toLocaleString()} liked songs and ${m.playlists} playlists${m.fetched ? ", exported " + when(m.fetched) : ""}. ${m.from === "local file" ? "Read from private/ on this computer." : "Imported " + when(m.importedAt) + "."}`
    : "Not imported yet. Run <code>node tools/spotify-import.mjs</code> on the PC, then import the file it saves.";
  views.settings.innerHTML = `<div class='view-inner'>
    <h1 class='page-title'>Settings</h1>
    <div class='card set-group'>
      <div class='set-row'><div><div class='set-label'>Library</div><div class='meta' id='lib-status'>${libText}</div></div></div>
      <div class='set-row'><div><div class='set-label'>Import library file</div><div class='meta'>The JSON from the Spotify import tool. Stays on this device.</div></div>
        <label class='btn outline small file-btn'>Choose file<input type='file' id='lib-file' accept='.json,application/json' class='sr-only'></label></div>
      <div class='set-row'><div><div class='set-label'>Export your charts</div><div class='meta' id='charts-out'>Chords you've detected or checked, as a file for the repo (node tools/add-charts.mjs), so the deployed app has them. Chords and timing only; recordings stay here.</div></div>
        <button class='btn outline small' id='charts-export'>Export</button></div>
    </div>
    ${await storageCard(lib)}
    ${await playerCard()}
    <div class='card set-group'>
      <div class='set-row'><div><div class='set-label'>Theme</div><div class='meta'>Auto follows your phone: Mocha when dark, Latte when light.</div></div></div>
      <div class='seg' role='group' aria-label='Theme' style='margin-bottom:12px'>${[["auto", "Auto"], ["mocha", "Mocha"], ["latte", "Latte"]].map(([v, l]) =>
        `<button data-theme-pref='${v}' class='${v === pref ? "on" : ""}' aria-pressed='${v === pref}'>${l}</button>`).join("")}</div>
      <div class='set-row'><div><div class='set-label'>Sound check</div><div class='meta'>Strums a G chord on the app guitar.</div></div>
        <button class='btn outline small' id='sound-check'>▶ Strum</button></div>
    </div>
    <div class='card credits'>
      <p><b>The Songbook</b> ${esc(VERSION)}. Every chart says where its chords came from: detected, web (cited), mine or verified.</p>
      <p>Colours: Catppuccin (MIT). Chord shapes: chords-db by David Rubert (MIT). Guitar synth, patterns and notation from Pimapeggio; the recording player from speedy-pitcher.
        Speed and pitch: Signalsmith Stretch (MIT). Tempo, beats and key: essentia.js (AGPL-3.0); chords from a chroma after NNLS Chroma (Mauch and Dixon). Synced lyrics: LRCLIB, when you ask.</p>
    </div>
  </div>`;
  views.settings.querySelectorAll("[data-theme-pref]").forEach((b) => b.addEventListener("click", () => {
    setTheme(b.dataset.themePref);
    renderSettings();
  }));
  views.settings.querySelector("#sound-check").addEventListener("click", soundCheck);
  wirePlayerCard();
  views.settings.querySelector("#charts-export").addEventListener("click", async () => {
    const out = views.settings.querySelector("#charts-out");
    const file = chartsFile(await deviceCharts());
    if (!file.charts.length) { out.textContent = "No charts with chords on this device yet."; return; }
    const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `songbook-charts-${file.exported.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    out.textContent = `${file.charts.length} chart${file.charts.length === 1 ? "" : "s"}: ${file.charts.map((c) => c.title).join(", ")}. Then: node tools/add-charts.mjs <that file>.`;
  });
  views.settings.querySelectorAll("[data-del-stems]").forEach((b) => b.addEventListener("click", async () => {
    if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Tap again"; return; }
    await deleteStems(b.dataset.delStems);
    toast("Stems deleted. The recording and chords stay.");
    renderSettings();
  }));
  views.settings.querySelectorAll("[data-del-rec]").forEach((b) => b.addEventListener("click", async () => {
    if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Tap again"; return; }
    await deleteRecording(b.dataset.delRec);
    invalidateSongs();
    toast("Recording deleted. Its chords stay.");
    renderSettings();
  }));
  views.settings.querySelector("#lib-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const v = await importLibraryText(await f.text(), "file");
      invalidateSongs();
      toast(`Imported ${v.liked.length.toLocaleString()} liked songs and ${v.playlists.length} playlists.`);
      renderSettings();
    } catch (err) {
      toast(err.message, 4000);
    }
  });
}

// Storage: a meter, whether the browser keeps it, and each recording with Delete.
async function storageCard(lib) {
  const [info, recs, stems] = await Promise.all([storageInfo(), listRecordings(), listStems()]);
  const pct = info.quota ? Math.max(1, Math.min(100, (info.usage / info.quota) * 100)) : 0;
  const recPct = info.quota ? Math.min(pct, (info.recordings / info.quota) * 100) : 0;
  const titleOf = async (id) => {
    const e = lib.entries.get(id);
    if (e) return e.title;
    const c = await get("charts", id).catch(() => null);
    return c ? c.title : id;
  };
  const rows = await Promise.all(recs.map(async (r) => `<div class='set-row'><div style='min-width:0'>
      <a class='set-label ellipsis row-link' href='#/song/${encodeURIComponent(r.id)}/chords'>${esc(await titleOf(r.id))}</a>
      <div class='meta ellipsis'>${esc(r.name)} · ${fmtBytes(r.size)}</div></div>
      <button class='btn outline small' data-del-rec='${esc(r.id)}'>Delete</button></div>`));
  const stemRows = await Promise.all(stems.map(async (m) => `<div class='set-row'><div style='min-width:0'>
      <a class='set-label ellipsis row-link' href='#/song/${encodeURIComponent(m.songId)}/player'>${esc(await titleOf(m.songId))}: stems</a>
      <div class='meta ellipsis'>${esc(m.stems.map((x) => x.label).join(", "))} · ${fmtBytes(stemsSize(m))}</div></div>
      <button class='btn outline small' data-del-stems='${esc(m.songId)}'>Delete</button></div>`));
  rows.push(...stemRows);
  return `<div class='card set-group'>
    <div class='set-row'><div style='flex:1'><div class='set-label'>Storage</div>
      <div class='meta' id='storage-text'>Recordings ${fmtBytes(info.recordings)} · everything ${fmtBytes(info.usage)}${info.quota ? " of " + fmtBytes(info.quota) + " available" : ""}</div>
      <div class='meter' role='meter' aria-label='Storage used' aria-valuemin='0' aria-valuemax='100' aria-valuenow='${Math.round(pct)}'><i class='all' style='width:${pct}%'></i><i class='rec' style='width:${recPct}%'></i></div>
      <div class='meta'>${info.persisted ? "Kept: the browser won't clear it to make room." : "Not marked as kept yet. Adding the app to your Home Screen helps keep it."}</div></div></div>
    ${rows.length ? rows.join("") : "<div class='set-row'><div class='meta'>No recordings on this device yet.</div></div>"}
    <div class='set-row'><div><div class='set-label'>Analyse many recordings</div><div class='meta'>Pick files; each is matched to a song by its tags.</div></div>
      <a class='btn outline small' href='#/analyse'>Open</a></div>
  </div>`;
}

// The recording player: the PC helper, LRCLIB, speedy-pitcher's library, and the stretch benchmark.
async function playerCard() {
  const here = await speedyPitcherHere();
  return `<div class='card set-group' id='player-card'>
    <div class='set-row'><div><div class='set-label'>PC helper</div><div class='meta'>Downloads a YouTube link's audio at home, and analyses recordings on the PC's GPU: stems, chords, sections and lyric timing. Setup: helper/README.md in the repo.</div></div></div>
    <form class='set-row link-row' id='helper-form'>
      <input class='text-input' id='helper-url' type='url' inputmode='url' placeholder='https://your-pc.tailnet.ts.net' value='${esc(helperUrl())}' aria-label='Helper address' autocomplete='off'>
      <button class='btn outline small' type='submit'>Test</button></form>
    <div class='meta' id='helper-status' aria-live='polite' style='padding:0 0 10px'></div>
    <div class='set-row'><div><div class='set-label'>Import an analysis bundle</div><div class='meta' id='bundle-out'>A .zip from the helper's private/songs folder, if a job's results didn't come over by themselves.</div></div>
      <label class='btn outline small file-btn'>Choose zip<input type='file' id='bundle-file' accept='.zip,application/zip' class='sr-only'></label></div>
    <div class='set-row'><div><div class='set-label'>Synced lyrics (LRCLIB)</div><div class='meta'>"Find on LRCLIB" in a sheet looks up line timings at lrclib.net, sending the title, artist and length. Nothing is sent otherwise.</div></div>
      <button class='switch ${lrclibOn() ? "on" : ""}' role='switch' aria-checked='${lrclibOn()}' id='lrclib-switch' aria-label='Synced lyrics from LRCLIB'></button></div>
    <div class='set-row'><div><div class='set-label'>speedy-pitcher</div><div class='meta'>${here ? "Its library is on this site: bring over recordings, loops and settings." : "Bring over its recordings, loops and settings: in speedy-pitcher, Settings → Export library, then choose that file here."}</div></div>
      ${here ? "<button class='btn outline small' id='sp-here'>Import</button>" : ""}</div>
    <div class='set-row'><div class='meta'>${here ? "Or import an export file." : ""}</div>
      <label class='btn outline small file-btn'>Choose export<input type='file' id='sp-file' accept='.zip,application/zip' class='sr-only'></label></div>
    <div class='set-row'><div><div class='set-label'>Test stretch speed</div><div class='meta' id='bench-out'>How much faster than real time speed and pitch run on this device.</div></div>
      <button class='btn outline small' id='bench'>Run</button></div>
  </div>`;
}

function wirePlayerCard() {
  const v = views.settings;
  v.querySelector("#helper-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = v.querySelector("#helper-url").value.trim();
    setHelperUrl(url);
    const out = v.querySelector("#helper-status");
    if (!url) { out.textContent = "Helper turned off."; return; }
    out.textContent = "Testing…";
    try {
      const r = await pingHelper(url);
      const a = r.analysis;
      out.textContent = `Connected: yt-dlp ${r.yt_dlp || "?"}. ` + (a && a.available ? `Analysis ready on ${a.gpu || "the CPU"}.` : a ? "Downloads only: " + a.reason : "Downloads only (an older helper).");
    } catch (err) {
      out.textContent = err.message;
    }
  });
  v.querySelector("#lrclib-switch").addEventListener("click", () => { setLrclib(!lrclibOn()); renderSettings(); });
  v.querySelector("#bundle-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const out = v.querySelector("#bundle-out");
    out.textContent = "Importing…";
    try {
      const r = await importBundleFile(f);
      out.textContent = r.partsOnly ? `The guitar part for ${r.parts} section${r.parts === 1 ? "" : "s"}.`
        : `${r.chart.title || "The song"}: ${r.chart.bars.length} bars of chords${r.stems ? `, ${r.stems} stems` : ""}${r.parts ? `, the guitar part for ${r.parts} section${r.parts === 1 ? "" : "s"}` : ""}${r.timing ? `, timing for ${r.timing} lyric lines` : ""}${r.audio ? ", and the recording" : ""}.`;
      invalidateSongs();
    } catch (err) {
      out.textContent = err.message;
    }
  });
  const here = v.querySelector("#sp-here");
  if (here) here.addEventListener("click", async () => {
    try { await startImport("here", await loadFromHere()); } catch (err) { toast(err.message, 4000); }
  });
  v.querySelector("#sp-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { await startImport("file", await loadFromZip(f)); } catch (err) { toast(err.message, 4000); }
  });
  v.querySelector("#bench").addEventListener("click", async (e) => {
    const b = e.currentTarget, out = v.querySelector("#bench-out");
    b.disabled = true;
    out.textContent = "Running (10 seconds of audio, twice)…";
    try {
      const { benchmark } = await import("./bench.js");
      const x = await benchmark();
      const verdict = (y) => (y > 4 ? "plenty of headroom" : y > 1.5 ? "fine, with some headroom" : "tight: expect dropouts");
      out.textContent = `Recording: ${x.toFixed(1)}× real time at 75% speed, +2 semitones (${verdict(x)}). Now 6 stems…`;
      const y = await benchmark(10, 6);
      out.textContent = `Recording: ${x.toFixed(1)}× real time (${verdict(x)}). Six stems: ${y.toFixed(1)}× (${verdict(y)}). At 75% speed, +2 semitones.`;
    } catch (err) {
      out.textContent = "Couldn't run: " + err.message;
    }
    b.disabled = false;
  });
}

// A bundle zip chosen by hand: it's for the song it says, or the one with its title and artist.
async function importBundleFile(f) {
  const files = await readZip(f);
  const mf = files.get("bundle.json");
  if (!mf) throw new Error("That zip isn't an analysis bundle from the PC helper.");
  const m = JSON.parse(await mf.blob.text());
  const lib = await loadLibrary();
  const id = m.songId && (lib.entries.has(m.songId) || await get("charts", m.songId).catch(() => null)) ? m.songId : songIdFor(m.title || "", m.artist || "");
  const e = lib.entries.get(id);
  const sheet = await getSheet(id);
  const shipped = await shippedChart(id).catch(() => null);
  const chart = (await get("charts", id).catch(() => null)) || shipped;
  return importBundle(f, id, { title: (e && e.title) || m.title, artist: (e && e.artist) || m.artist, shipped, chart,
    lyricCount: sheet ? lyricLines(parseChordPro(sheet.chordpro)).length : 0 });
}

let checkVoices = null;
async function soundCheck() {
  await resumeAudio();
  const frets = [3, 2, 0, 0, 0, 3];
  await warmNotes([43, 47, 50, 55, 59, 67]);
  checkVoices = checkVoices || new StringVoices("guitar");
  strum(checkVoices, frets, audioContext().currentTime + 0.03, { level: 0.4 });
}

/* ---- Audio interruptions (iOS calls, Siri) ---- */

onAudioState((state) => {
  if (state === "running") { hideToast(); return; }
  const p = getPlayer();
  const rec = playerNow();
  if (!p.playing && !(rec && rec.playing)) return;
  resumeAudio();
  setTimeout(() => {
    const still = p.playing || (playerNow() && playerNow().playing);
    if (still && audioContext().state !== "running") toast("Audio was paused. Tap anywhere to resume.", 0);
  }, 500);
});

/* ---- Desktop shortcuts ----
   Space play/stop, ←/→ transpose, ↑/↓ tempo, S auto-scroll, Esc back. */

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Esc closes a popover even from a text field inside it.
  if (e.key === "Escape" && popoverOpen()) { closePopover(); return; }
  if (e.target.closest && e.target.closest("input, textarea, select")) return;
  if (e.key === "Escape") {
    if (popoverOpen()) closePopover();
    else if (route.name === "song" && songMode() === "edit") location.hash = `#/song/${encodeURIComponent(route.id)}`;
    else if (route.name === "song" && songMode() === "analyse") location.hash = `#/song/${encodeURIComponent(route.id)}/chords`;
    else if (route.name === "batch" || route.name === "import") location.hash = "#/settings";
    else if (route.name === "song") location.hash = "#/songs";
    return;
  }
  if (route.name !== "song" || popoverOpen() || songMode() === "edit" || songMode() === "analyse") return;
  const k = e.key;
  // Player: ↑/↓ speed, ←/→ pitch, L loops the section, M the mixer.
  if (songMode() === "player") {
    if (k === " ") { e.preventDefault(); if (!e.repeat) togglePlay(); }
    else if (k === "ArrowUp") { e.preventDefault(); speedBy(0.05); }
    else if (k === "ArrowDown") { e.preventDefault(); speedBy(-0.05); }
    else if (k === "ArrowLeft") { e.preventDefault(); pitchBy(-1); }
    else if (k === "ArrowRight") { e.preventDefault(); pitchBy(1); }
    else if (k === "l" || k === "L") loopCurrentSection();
    else if (k === "m" || k === "M") focusMixer();
    return;
  }
  if (k === " ") { e.preventDefault(); if (!e.repeat) togglePlay(); }
  else if (k === "s" || k === "S") toggleScroll();
  else if (k === "ArrowLeft") { e.preventDefault(); transposeBy(-1); }
  else if (k === "ArrowRight") { e.preventDefault(); transposeBy(1); }
  else if (k === "ArrowUp") { e.preventDefault(); tempoBy(e.shiftKey ? 5 : 1); }
  else if (k === "ArrowDown") { e.preventDefault(); tempoBy(e.shiftKey ? -5 : -1); }
});

/* ---- Start-up ---- */

async function init() {
  applyTheme();
  try {
    const res = await fetch("vendor/chords-db/guitar.json");
    setChordDb(await res.json());
  } catch (e) {
    console.warn("chords-db didn't load; only built-in shapes are available", e);
  }
  try {
    await go();
  } catch (e) {
    // Never a blank app: say what went wrong and offer a reload.
    console.error("start-up failed", e);
    const v = document.querySelector(".view:not(.hidden)") || views.songs;
    v.innerHTML = `<div class='view-inner'><div class='card empty' role='alert'><b>The Songbook didn't start properly.</b><br>${esc(e && e.message || String(e))}
      <div style='margin-top:12px'><button class='btn primary' onclick='location.reload()'>Reload</button></div></div></div>`;
  }
  document.documentElement.dataset.ready = "1";
}

// For the browser tests.
window.songbook = { songState, getPlayer, playerState, playerNow, importState, pcJobs, VERSION };

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
