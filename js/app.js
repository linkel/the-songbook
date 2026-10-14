// The Songbook: tabs, routing (#/songs, #/practice, #/settings,
// #/song/<id>/<mode>), theme, settings and start-up.

import { setChordDb } from "./chords.js";
import { renderSongs } from "./songs.js";
import { openSong, closeSong, togglePlay, transposeBy, tempoBy, popoverOpen, closePopover, songState, getPlayer } from "./sheet.js";
import { onAudioState, resumeAudio, StringVoices, strum, warmNotes, audioContext } from "./audio.js";
import { esc, toast, hideToast } from "./ui.js";

export const VERSION = "0.1.0";

const views = {
  songs: document.getElementById("view-songs"),
  practice: document.getElementById("view-practice"),
  settings: document.getElementById("view-settings"),
  song: document.getElementById("view-song"),
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
  if (parts[0] === "song" && parts[1]) return { name: "song", id: parts[1], mode: parts[2] || null };
  if (parts[0] === "practice" || parts[0] === "settings") return { name: parts[0] };
  return { name: "songs" };
}

async function go() {
  const prev = route;
  route = parseHash();
  if (prev.name === "song" && (route.name !== "song" || route.id !== prev.id)) closeSong();
  for (const [name, el] of Object.entries(views)) el.classList.toggle("hidden", name !== route.name);
  document.body.classList.toggle("in-song", route.name === "song");
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === route.name;
    t.classList.toggle("on", on);
    if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  });
  if (route.name === "songs") await renderSongs(views.songs);
  else if (route.name === "practice") renderPractice();
  else if (route.name === "settings") renderSettings();
  else if (route.name === "song") await openSong(views.song, route.id, route.mode);
}

window.addEventListener("hashchange", go);

/* ---- Practice tab ---- */

function renderPractice() {
  views.practice.innerHTML = `<div class='view-inner'>
    <h1 class='page-title'>Practice</h1>
    <div class='card empty'><b>Nothing saved yet.</b><br>Loops and sections you're working on will collect here, with your speed-trainer progress, once the recording player arrives.</div>
  </div>`;
}

/* ---- Settings tab ---- */

function renderSettings() {
  const pref = themePref();
  views.settings.innerHTML = `<div class='view-inner'>
    <h1 class='page-title'>Settings</h1>
    <div class='card set-group'>
      <div class='set-row'><div><div class='set-label'>Theme</div><div class='meta'>Auto follows your phone: Mocha when dark, Latte when light.</div></div></div>
      <div class='seg' role='group' aria-label='Theme' style='margin-bottom:12px'>${[["auto", "Auto"], ["mocha", "Mocha"], ["latte", "Latte"]].map(([v, l]) =>
        `<button data-theme-pref='${v}' class='${v === pref ? "on" : ""}' aria-pressed='${v === pref}'>${l}</button>`).join("")}</div>
      <div class='set-row'><div><div class='set-label'>Sound check</div><div class='meta'>Strums a G chord on the app guitar.</div></div>
        <button class='btn outline small' id='sound-check'>▶ Strum</button></div>
    </div>
    <div class='card credits'>
      <p><b>The Songbook</b> ${esc(VERSION)}. Every chart says where its chords came from: detected, web (cited), mine or verified.</p>
      <p>Colours: Catppuccin (MIT). Chord shapes: chords-db by David Rubert (MIT). Guitar synth, patterns and notation from Pimapeggio; speed and pitch from speedy-pitcher.</p>
    </div>
  </div>`;
  views.settings.querySelectorAll("[data-theme-pref]").forEach((b) => b.addEventListener("click", () => {
    setTheme(b.dataset.themePref);
    renderSettings();
  }));
  views.settings.querySelector("#sound-check").addEventListener("click", soundCheck);
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
  if (!p.playing) return;
  resumeAudio();
  setTimeout(() => {
    if (p.playing && audioContext().state !== "running") toast("Audio was paused. Tap anywhere to resume.", 0);
  }, 500);
});

/* ---- Desktop shortcuts ----
   Space play/stop, ←/→ transpose, ↑/↓ tempo, Esc back. */

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, textarea, select")) return;
  if (e.key === "Escape") {
    if (popoverOpen()) closePopover();
    else if (route.name === "song") location.hash = "#/songs";
    return;
  }
  if (route.name !== "song" || popoverOpen()) return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); if (!e.repeat) togglePlay(); }
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
  await go();
  document.documentElement.dataset.ready = "1";
}

// For the browser tests.
window.songbook = { songState, getPlayer, VERSION };

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
