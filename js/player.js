// Player mode (#/song/<id>/player, mockups 6 and 7): your recording with speed
// and pitch (Signalsmith Stretch, js/engine.js), or a YouTube link in YouTube's
// own player (speed and loops, no pitch). A waveform with section and chord
// lanes, loops that snap to the analysed bar lines (saved ones show up under
// Practice), count-in, the speed trainer, a mixer with the app guitar
// strumming the chart on the recording's beats, and lock-screen controls.
// Everything that follows the music (lanes, chord now, the synced sheet, the
// app guitar) works in song time, mapped through the engine's schedule, so it
// stays locked at any speed and across loop jumps.
// With stems from the PC helper, the mixer has a row per stem instead of the
// one recording row: all of them go through one stretcher, so they stay in
// sync at any speed and pitch.

import { FileEngine } from "./engine.js";
import { YouTubeEngine, parseYouTubeId, youTubeTitle } from "./youtube.js";
import { WaveView } from "./waveform.js";
import { decodeSong, estimateTuning, makeAnalysis } from "./wavedata.js";
import { SPEED_MIN, SPEED_MAX, fmtTime, fmtSemis, fmtCents, clamp } from "./trainer.js";
import { audioContext, resumeAudio, track, StringVoices, strum, warmNotes, requestWakeLock, releaseWakeLock } from "./audio.js";
import { Lookahead } from "./scheduler.js";
import { getRecording, recordingMeta, saveRecording, fmtBytes, stemsMeta, getStems } from "./recordings.js";
import { put, getAll, savePrefs } from "./library.js";
import { findSections } from "./detect.js";
import { bestVoicing, prettyChord } from "./chords.js";
import { helperUrl, downloadAudio } from "./helper-client.js";
import { pcJob, onPcJob, startPcJob, cancelPcJob, clearPcJob } from "./pcjob.js";
import { esc, toast, showPopover, closePopover, ICONS } from "./ui.js";

const SECTION_COLORS = ["--blue", "--mauve", "--lavender", "--teal", "--pink", "--sky"];
const MIX = [["recording", "Recording", "your file"], ["guitar", "App guitar", "strums the chords"], ["click", "Count-in", "clicks"]];
const TRACK = { recording: "recording", guitar: "app-guitar", click: "click" };
const trackOf = (key) => TRACK[key] || "stem-" + key.slice(5);
// Stems play in stereo on a computer; on a phone each is mono, which halves
// the memory and the stretcher's work.
const stereoStems = () => !(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);

export const PLAYER_DEFAULTS = {
  source: null,          // "file" | "youtube"
  youtube: null,         // { id, title }
  speed: 1, semis: 0, cents: 0, formant: false,
  a: null, b: null, loopOn: false, loopId: null, snap: true,
  stems: true,           // play the stems (when the helper made some) rather than the recording
  countIn: 0,            // bars
  trainerOn: false, trainer: { start: 0.7, step: 0.05, every: 2, target: 1 },
  mix: { recording: { vol: 1, on: true }, guitar: { vol: 0.6, on: false }, click: { vol: 0.8, on: true } },
  position: 0, view: null,
};

let S = null;                 // the session for the open song
let fileEngine = null;
let ytEngine = null;
const frameListeners = new Set();

function getFileEngine() {
  if (!fileEngine) {
    fileEngine = new FileEngine();
    for (const type of ["state", "seek", "rate", "wrap", "beat", "ended"]) fileEngine.addEventListener(type, (e) => onEngine(type, e.detail, fileEngine));
  }
  return fileEngine;
}

function getYtEngine(host) {
  if (!ytEngine) {
    ytEngine = new YouTubeEngine(host);
    for (const type of ["state", "seek", "rate", "wrap", "beat", "ended", "error", "needs-tap"]) ytEngine.addEventListener(type, (e) => onEngine(type, e.detail, ytEngine));
  }
  ytEngine.host = host;
  return ytEngine;
}

/* ---- Public: for the song view, the sheet and the keyboard ---- */

// What's playing: { id, kind, pos, playing } or null.
export function playerNow() {
  if (!S || !S.engine) return null;
  return { id: S.id, kind: S.kind, pos: S.engine.position, playing: S.engine.playing };
}

// Chords follow pitch: semitones the recording is shifted by (file only).
export function pitchShift(id) {
  return S && S.id === id && S.kind === "file" ? S.set.semis : 0;
}

export function onPlayerFrame(fn) { frameListeners.add(fn); return () => frameListeners.delete(fn); }

// The app guitar plays your guitar part instead of strumming (Picking mode's
// play-along): events [{ t (song time), string, midi, level }], sorted, or null.
export function setPartLayer(id, events) {
  partLayers.set(id, events && events.length ? events : null);
  if (S && S.id === id) {
    S.partEvents = partLayers.get(id);
    S.partTimes = S.partEvents ? S.partEvents.map((e) => e.t) : null;
    stopGuitar();
    if (S.engine && S.engine.playing && S.set.mix.guitar.on) startGuitar();
    syncMixer();
  }
}
const partLayers = new Map();

// A/B in Picking mode: "both", "recording" (the recording's guitar: the guitar
// stem when there are stems, else the whole recording) or "part" (the app's).
export function setPartAB(mode) {
  if (!S) return;
  const recKey = S.playingStems && S.stems.stems.some((x) => x.name === "guitar") ? "stem:guitar" : S.playingStems ? null : "recording";
  mixOf("guitar").on = mode !== "recording";
  if (recKey) mixOf(recKey).on = mode !== "part";
  applyMix();
  syncMixer();
  persist();
}
export const partAB = () => {
  if (!S) return "both";
  const recKey = S.playingStems && S.stems && S.stems.stems.some((x) => x.name === "guitar") ? "stem:guitar" : "recording";
  const part = mixOf("guitar").on, rec = !S.set.mix[recKey] || S.set.mix[recKey].on;
  return part && rec ? "both" : part ? "part" : "recording";
};

export const playerOpen = () => !!(S && S.view && S.view.querySelector(".player"));

// ctx: { id, title, artist, chart, prefs, rec, disp(name), modesHtml, sideHtml,
//        lyrics: { lines: [text], timing: [{ index, t }] } | null, onPitch() }
export async function openPlayer(view, ctx) {
  if (!S || S.id !== ctx.id) {
    closePlayer();
    S = newSession(ctx);
  }
  S.ctx = ctx;
  S.view = view;
  prepareBars();
  render();
  if (!S.kind && !S.loading) autoLoad();
}

// For Play in Sheet mode: play the song's recording without opening the Player.
export async function playRecording(ctx) {
  if (!S || S.id !== ctx.id) { closePlayer(); S = newSession(ctx); }
  S.ctx = ctx;
  prepareBars();
  if (S.kind !== "file") {
    // Yours on this device (or its stems), else the one that comes with the app.
    const s = S;
    const meta = await recordingMeta(s.id);
    if (s.stems === undefined) s.stems = await stemsMeta(s.id);
    if (S !== s) return;
    if (!meta && !s.stems && s.ctx.chart && s.ctx.chart.audio) await loadShipped(); else await loadFile();
  }
  if (S && S.kind === "file") await togglePlayer();
}

// The mixer's rows: the recording, or one per stem; then the app guitar and the count-in.
function mixRows() {
  if (S.playingStems) return [...S.stems.stems.map((x) => ["stem:" + x.name, x.label || x.name, "stem"]), MIX[1], MIX[2]];
  return MIX;
}
function mixOf(key) {
  if (!S.set.mix[key]) S.set.mix[key] = { vol: 1, on: true };
  return S.set.mix[key];
}

export function closePlayer() {
  if (!S) return;
  persist(true);
  stopFrames();
  if (S.engine) S.engine.pause();
  if (fileEngine && S.kind === "file") fileEngine.unload();
  if (ytEngine && S.kind === "youtube") ytEngine.unload();
  if (S.guitarLook) S.guitarLook.stop();
  if (S.voices) S.voices.silence(0.05);
  stopKeepalive();
  releaseWakeLock();
  if (S.wave) S.wave.destroyed = true;
  S = null;
  if ("mediaSession" in navigator) { try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; } catch (e) { /* old */ } }
}

// Leaving Player mode for another mode of the same song: YouTube's player
// lives on this screen, so it pauses; a file keeps playing for the sheet.
export function leavePlayerView() {
  if (!S) return;
  if (S.kind === "youtube" && S.engine && S.engine.playing) S.engine.pause();
  S.view = null;
  persist();
}

export async function togglePlayer() {
  if (!S || !S.engine) return;
  await resumeAudio();
  if (S.engine.playing) { S.engine.pause(); return; }
  if (S.enginePromise) await S.enginePromise;
  startKeepalive();
  S.engine.play();
}

export function speedBy(d) { if (S) setSpeed(S.set.speed + d); }
// Loop song time a..b (seconds), e.g. from Practice or a shortcut.
export function loopTo(a, b, id = null) { if (S) setLoop(a, b, true, id); }
export function pitchBy(d) { if (S && S.kind === "file") setPitch(S.set.semis + d); }
export function loopCurrentSection() { if (S) loopSection(); }
export function focusMixer() {
  const el = S && S.view && S.view.querySelector(".mixer");
  if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); const f = el.querySelector("input,button"); if (f) f.focus(); }
}

/* ---- Session ---- */

function newSession(ctx) {
  const saved = (ctx.prefs && ctx.prefs.player) || {};
  const set = { ...structuredClone(PLAYER_DEFAULTS), ...structuredClone(saved) };
  set.mix = { ...structuredClone(PLAYER_DEFAULTS.mix), ...(saved.mix || {}) };
  set.trainer = { ...PLAYER_DEFAULTS.trainer, ...(saved.trainer || {}) };
  const partEvents = partLayers.get(ctx.id) || null;
  return { id: ctx.id, ctx, set, kind: null, engine: null, an: null, duration: 0, loading: null, error: null,
    view: null, wave: null, voices: new StringVoices(TRACK.guitar), scheduled: new Map(), loops: [], raf: 0, note: "",
    partEvents, partTimes: partEvents ? partEvents.map((e) => e.t) : null };
}

// The chart's bars with times (from an analysed recording): bars, beats,
// sections, and the strum times for the app guitar.
function prepareBars() {
  const c = S.ctx.chart;
  S.timed = null;
  if (!c || !Array.isArray(c.bars) || !c.bars.length || typeof c.bars[0].t !== "number") return;
  const beats = (c.beats || []).slice();
  const bars = c.bars.map((b) => ({ t: b.t, n: b.n, chords: b.chords.slice() }));
  const lastBeat = beats.length ? beats[beats.length - 1] : null;
  bars.forEach((b, i) => {
    const next = bars[i + 1];
    b.t1 = next ? next.t : Math.max(b.t + 0.5, lastBeat && lastBeat > b.t ? lastBeat : b.t + 2);
  });
  // The PC helper finds sections by sound as well as chords; otherwise they
  // come from repeated chord blocks.
  const segs = c.analysis && Array.isArray(c.analysis.segments) && c.analysis.segments.length ? c.analysis.segments : null;
  const { form, spans } = segs && segs.every((x) => x.bars[1] < bars.length)
    ? { form: segs.map((x) => x.name), spans: segs.map((x) => Array.from({ length: x.bars[1] - x.bars[0] + 1 }, (_, k) => x.bars[0] + k)) }
    : findSections(bars);
  const names = [...new Set(form)];
  const sections = form.map((name, i) => {
    const span = spans[i];
    return { name, t0: bars[span[0]].t, t1: bars[span[span.length - 1]].t1, bars: span, color: SECTION_COLORS[names.indexOf(name) % SECTION_COLORS.length] };
  });
  // Strums: down on every beat, a light up on the off-beat after beats 2 and 4.
  const strums = [];
  let bi = 0;
  for (let i = 0; i + 1 < beats.length; i++) {
    const t = beats[i];
    while (bi + 1 < bars.length && bars[bi + 1].t <= t + 0.01) bi++;
    const inBar = Math.round((t - bars[bi].t) / Math.max(0.05, (beats[i + 1] - t)));
    strums.push({ t, dir: "D" });
    if (inBar % 2 === 1) strums.push({ t: (t + beats[i + 1]) / 2, dir: "U" });
  }
  // The count-in follows the analysed beats exactly (the chart's tempo is rounded).
  const gaps = beats.slice(1).map((t, i) => t - beats[i]).filter((d) => d > 0.15 && d < 2).sort((x, y) => x - y);
  const tempo = gaps.length >= 4 ? 60 / gaps[Math.floor(gaps.length / 2)] : c.tempo || (c.analysis && c.analysis.bpm) || null;
  const bpb = (c.analysis && c.analysis.bpb) || (c.time === "3/4" ? 3 : 4);
  S.timed = { bars, beats, sections, strums, strumTimes: strums.map((s) => s.t), tempo, bpb, tuning: (c.analysis && c.analysis.tuning) || 0,
    file: c.analysis && c.analysis.file };
}

async function autoLoad() {
  const want = S.set.source;
  const s = S;
  const meta = s.ctx.rec || await recordingMeta(s.id);
  s.stems = await stemsMeta(s.id);
  if (S !== s) return;
  const bundled = S.ctx.chart && S.ctx.chart.audio;
  if (S.stems && want !== "youtube") return loadFile();
  if (meta && (want !== "youtube" || bundled)) return loadFile();
  // A song with its own recording in the app (songs/audio/) opens that, not a YouTube link.
  if (bundled) return loadShipped();
  if (want === "youtube" && S.set.youtube) return loadYouTube(S.set.youtube.id);
  if (meta) return loadFile();
}

async function loadShipped() {
  const s = S, a = s.ctx.chart.audio;
  s.loading = "Getting the recording that comes with the app…";
  if (s.view) render();
  try {
    const r = await fetch(a.file.split("/").map(encodeURIComponent).join("/"));
    if (!r.ok) throw new Error(r.status);
    const blob = await r.blob();
    if (S !== s) return;
    // Played straight from the app: the offline cache keeps a copy, so it
    // isn't stored again with your recordings.
    s.loading = null;
    await loadFile(blob, { name: a.file.split("/").pop(), size: blob.size, source: "app" });
  } catch (e) {
    if (S !== s) return;
    s.loading = null;
    s.error = "Couldn't get the recording that comes with the app" + (navigator.onLine ? "." : ": you're offline, and it isn't saved yet.");
    if (s.view) render();
  }
}

// blob/meta: play this file directly (one that came with the app, or one the
// browser wouldn't store); otherwise the recording kept on this device.
async function loadFile(direct = null, directMeta = null) {
  const s = S;
  if (s.stems === undefined) s.stems = await stemsMeta(s.id);
  const useStems = !direct && !!s.stems && (s.set.stems || !(await recordingMeta(s.id)));
  s.loading = useStems ? "Reading the stems…" : "Reading the recording…";
  s.error = null;
  if (s.view) render();
  try {
    let dec, layout = null;
    if (useStems) {
      s.meta = await recordingMeta(s.id);
      dec = await decodeStems(s.id);
      layout = dec.layout;
    } else {
      const blob = direct || await getRecording(s.id);
      if (!blob) throw new Error("The recording isn't on this device any more.");
      s.meta = direct ? directMeta : await recordingMeta(s.id);
      dec = await decodeSong(blob, audioContext());
    }
    if (S !== s) return;
    if (ytEngine && s.kind === "youtube") ytEngine.unload();
    const engine = getFileEngine();
    // Switching full mix <-> stems keeps the place, and plays on if it was.
    const at = s.kind === "file" && engine.duration ? engine.position : null;
    const was = s.kind === "file" && engine.playing;
    s.playingStems = !!layout;
    s.an = dec.analysis;
    s.duration = dec.duration;
    s.kind = "file";
    s.engine = engine;
    s.set.source = "file";
    s.enginePromise = engine.load(dec.channels, dec.duration, layout).then(() => {
      if (S !== s) return;
      // First time: start where the analysed bars start (after a spoken intro, say).
      const first = s.timed && s.timed.bars[0].t > 15 ? s.timed.bars[0].t : 0;
      engine.pausedAt = clamp(at ?? (s.set.position || first), 0, dec.duration);
      applyAll();
      if (was) engine.play();
    });
    s.loading = null;
    if (s.view) render();
    await s.enginePromise;
    updateMediaSession();
  } catch (e) {
    if (S !== s) return;
    s.loading = null;
    s.error = e.message || String(e);
    if (s.view) render();
  }
}

// The helper's stems -> channels for the engine, a layout saying which
// channels are which stem, and a waveform of them all together.
async function decodeStems(id) {
  const files = await getStems(id);
  if (!files) throw new Error("The stems aren't on this device any more. Analyse on the PC again, or switch the mixer to Full mix.");
  const c = audioContext();
  const stereo = stereoStems();
  const channels = [], layout = [];
  let sum = new Float32Array(0), len = 0;
  for (const f of files) {
    let buf;
    try { buf = await c.decodeAudioData(await f.blob.arrayBuffer()); } catch (e) { throw new Error(`Couldn't decode the ${f.label || f.name} stem.`); }
    const l = buf.getChannelData(0), r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
    if (buf.length > sum.length) { const n = new Float32Array(buf.length); n.set(sum); sum = n; }
    len = Math.max(len, buf.length);
    const at = channels.length;
    if (stereo) {
      channels.push(l, r === l ? l.slice() : r);
      layout.push({ track: "stem-" + f.name, channels: [at, at + 1] });
      for (let i = 0; i < buf.length; i++) sum[i] += 0.5 * (l[i] + r[i]);
    } else {
      const m = new Float32Array(buf.length);
      for (let i = 0; i < m.length; i++) { m[i] = 0.5 * (l[i] + r[i]); sum[i] += m[i]; }
      channels.push(m);
      layout.push({ track: "stem-" + f.name, channels: [at] });
    }
  }
  // The stretcher reads the channels side by side, so they're all one length.
  for (let k = 0; k < channels.length; k++) if (channels[k].length < len) { const n = new Float32Array(len); n.set(channels[k]); channels[k] = n; }
  const analysis = makeAnalysis({ sampleRate: c.sampleRate, length: sum.length, numberOfChannels: 1, getChannelData: () => sum });
  return { channels, layout, duration: len / c.sampleRate, analysis };
}

async function setStems(on) {
  S.set.stems = on;
  persist();
  await loadFile();
}

async function loadYouTube(id) {
  const s = S;
  if (!s.view) return;
  if (fileEngine && s.kind === "file") { fileEngine.pause(); fileEngine.unload(); }
  s.kind = "youtube";
  s.set.source = "youtube";
  if (!s.set.youtube || s.set.youtube.id !== id) s.set.youtube = { id, title: null };
  s.an = null;
  s.loading = "Loading YouTube's player…";
  s.error = null;
  render();
  const host = s.view.querySelector(".yt-host");
  const engine = getYtEngine(host);
  s.engine = engine;
  try {
    await engine.load(id, s.set.position || 0);
    if (S !== s) return;
    s.duration = engine.duration;
    s.loading = null;
    applyAll();
    if (s.set.position) engine.seek(s.set.position);
    if (!s.set.youtube.title) youTubeTitle(id).then((t) => { if (t && S === s) { s.set.youtube.title = t; persist(); syncSource(); } });
  } catch (e) {
    if (S !== s) return;
    s.loading = null;
    s.error = e.message;
  }
  syncAll();
  persist();
}

function applyAll() {
  if (!S.engine) return;
  S.engine.setRate(S.set.speed);
  applyPitch(false);
  applyLoop(false);
  applyCountIn(false);
  applyTrainer(false);
  applyMix();
}

/* ---- Settings -> engine ---- */

let saveTimer = 0;
function persist(now = false) {
  if (!S) return;
  clearTimeout(saveTimer);
  const s = S;
  const run = () => {
    if (s.engine) s.set.position = Math.round((s.engine.position || 0) * 100) / 100;
    if (s.wave && s.wave.duration) s.set.view = { ...s.wave.view };
    s.ctx.prefs.player = s.set;
    savePrefs(s.id, s.ctx.prefs);
  };
  if (now) run(); else saveTimer = setTimeout(run, 600);
}

function setSpeed(r) {
  r = Math.round(clamp(r, SPEED_MIN, S.kind === "youtube" ? 2 : SPEED_MAX) * 100) / 100;
  S.set.speed = r;
  if (S.engine) S.engine.setRate(r);
  syncControls();
  persist();
}

function setPitch(semis) {
  S.set.semis = clamp(Math.round(semis), -12, 12);
  applyPitch();
  if (S.ctx.onPitch) S.ctx.onPitch();
}

function setCents(c) {
  S.set.cents = clamp(Math.round(c), -50, 50);
  applyPitch();
}

function applyPitch(save = true) {
  if (S.engine && S.kind === "file") S.engine.setPitch(S.set.semis + S.set.cents / 100, S.set.formant);
  // The app guitar plays at the recording's pitch: its tuning plus your shift.
  S.voices.cents = (S.timed ? S.timed.tuning : 0) + S.set.semis * 100 + S.set.cents;
  refreshLanes();
  syncControls();
  if (save) persist();
}

function applyLoop(save = true) {
  const s = S.set;
  if (s.a !== null && s.b !== null && s.b <= s.a) s.b = null;
  if (s.a === null || s.b === null) s.loopOn = false;
  if (S.engine) S.engine.setLoop(s.a, s.b, s.loopOn);
  syncLoop();
  if (save) persist();
}

function songTempo() {
  return (S.timed && S.timed.tempo) || S.ctx.prefs.tempo || (S.ctx.chart && S.ctx.chart.tempo) || 100;
}

function applyCountIn(save = true) {
  const bpb = (S.timed && S.timed.bpb) || 4;
  if (S.engine) S.engine.setCountIn(S.set.countIn * bpb, 60 / songTempo());
  syncPractice();
  if (save) persist();
}

function applyTrainer(save = true) {
  if (S.engine) S.engine.setTrainer(S.set.trainerOn ? { ...S.set.trainer } : null);
  if (S.set.trainerOn) S.set.speed = S.set.trainer.start;
  syncControls();
  syncPractice();
  if (save) persist();
}

function applyMix() {
  for (const [key] of mixRows()) {
    const m = mixOf(key);
    const t = track(trackOf(key));
    t.setVolume(m.vol);
    t.setMuted(!m.on);
  }
  if (S.set.mix.guitar.on && S.engine && S.engine.playing) startGuitar();
  else stopGuitar();
}

/* ---- Loops ---- */

// Snap a time to the nearest bar line when one is close (and snapping is on).
function snap(t, reach = 0.35) {
  if (!S.set.snap || !S.timed || t === null) return t;
  let best = t, d = reach;
  for (const b of S.timed.bars) {
    if (Math.abs(b.t - t) < d) { d = Math.abs(b.t - t); best = b.t; }
    if (b.t > t + reach) break;
  }
  const last = S.timed.bars[S.timed.bars.length - 1];
  if (last && Math.abs(last.t1 - t) < d) best = last.t1;
  return Math.round(best * 1000) / 1000;
}

function setLoop(a, b, on = true, loopId = null) {
  Object.assign(S.set, { a, b, loopOn: on, loopId });
  applyLoop();
  if (S.wave) S.wave.fitLoop();
}

function barIndexAt(t) {
  if (!S.timed) return -1;
  const bars = S.timed.bars;
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t <= t + 1e-6) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function sectionAt(t) {
  if (!S.timed) return null;
  return S.timed.sections.find((s) => t >= s.t0 - 1e-6 && t < s.t1) || S.timed.sections[0] || null;
}

function loopSection() {
  const sec = sectionAt(S.engine ? S.engine.position : 0);
  if (!sec) { toast("Analyse the recording first: sections come from its bars."); return; }
  setLoop(sec.t0, sec.t1, true);
  toast(`Looping ${sec.name}.`);
}

function loopBars(n = 4) {
  if (!S.timed) return;
  const i = Math.max(0, barIndexAt(S.engine ? S.engine.position : 0));
  const from = Math.floor(i / n) * n, to = Math.min(S.timed.bars.length - 1, from + n - 1);
  setLoop(S.timed.bars[from].t, S.timed.bars[to].t1, true);
}

function setAHere() {
  const p = snap(S.engine ? S.engine.position : 0);
  S.set.a = p;
  if (S.set.b !== null && S.set.b <= p) S.set.b = null;
  S.set.loopId = null;
  S.set.loopOn = S.set.b !== null;
  applyLoop();
}

function setBHere() {
  const p = snap(S.engine ? S.engine.position : 0);
  if (S.set.a === null || p <= S.set.a) { toast("Set A first, earlier in the song."); return; }
  S.set.b = p;
  S.set.loopId = null;
  S.set.loopOn = true;
  applyLoop();
}

function barLabel(a, b) {
  if (!S.timed) return `${fmtTime(a)}–${fmtTime(b)}`;
  const i = barIndexAt(a + 0.01), j = barIndexAt(b - 0.01);
  return i >= 0 && j >= i ? (i === j ? `bar ${i + 1}` : `bars ${i + 1}–${j + 1}`) : `${fmtTime(a)}–${fmtTime(b)}`;
}

async function loadLoops() {
  const all = await getAll("loops").catch(() => []);
  if (!S) return;
  S.loops = all.filter((l) => l.songId === S.id).sort((x, y) => x.a - y.a);
  // Opened from Practice on a saved loop.
  const want = S.ctx.startLoop;
  if (want && S.startedLoop !== want) {
    const l = S.loops.find((x) => x.id === want);
    S.startedLoop = want;
    if (l) {
      S.set.position = l.a;
      setLoop(l.a, l.b, true, l.id);
      if (S.engine) S.engine.seek(l.a);
    }
  }
  syncLoop();
}

function saveLoopDialog() {
  const s = S.set;
  if (s.a === null || s.b === null) { toast("Set a loop first: A and B, or a section."); return; }
  const sec = S.timed ? S.timed.sections.find((x) => Math.abs(x.t0 - s.a) < 0.05 && Math.abs(x.t1 - s.b) < 0.05) : null;
  const def = sec ? sec.name : barLabel(s.a, s.b).replace(/^b/, "B");
  const p = showPopover(`<div class='popover-head'><span class='popover-name'>Save this loop</span></div>
    <label class='set-label' for='loop-name'>Name</label>
    <input id='loop-name' class='text-input' value='${esc(def)}' maxlength='60' autocomplete='off'>
    <p class='note'>${esc(barLabel(s.a, s.b))} · ${fmtTime(s.a)}–${fmtTime(s.b)}. Saved loops collect under Practice, with your trainer progress.</p>
    <div style='display:flex;gap:8px'><button class='btn outline' data-close style='flex:1'>Cancel</button><button class='btn primary' id='loop-save' style='flex:1'>Save</button></div>`, "Save loop");
  const input = p.querySelector("#loop-name");
  input.focus();
  input.select();
  const save = async () => {
    const rec = { id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), songId: S.id, name: input.value.trim() || def,
      a: s.a, b: s.b, bars: barLabel(s.a, s.b), createdAt: Date.now(), practice: null,
      title: S.ctx.title, artist: S.ctx.artist };
    await put("loops", rec);
    S.set.loopId = rec.id;
    persist();
    closePopover();
    await loadLoops();
    toast(`Saved "${rec.name}". It's under Practice too.`);
  };
  p.querySelector("#loop-save").addEventListener("click", save);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

// Trainer progress for a saved loop: the speed reached and loops played.
async function notePass(rate, passes) {
  const id = S.set.loopId;
  if (!id) return;
  const l = S.loops.find((x) => x.id === id);
  if (!l) return;
  const p = l.practice || { best: 0, passes: 0 };
  l.practice = { best: Math.max(p.best || 0, rate), last: rate, passes: (p.passes || 0) + 1, at: Date.now() };
  put("loops", l).catch(() => {});
}

/* ---- The app guitar: the chart strummed on the recording's beats ---- */

// Shapes for the app guitar, in the song's tuning (sounding chords, no capo).
const shapeCache = new Map();
function framesFor(name) {
  const t = S.ctx.tuning || null;
  const key = name + "|" + (t ? t.notes : "");
  if (!shapeCache.has(key)) { const v = bestVoicing(name, null, t); shapeCache.set(key, v ? v.frets : null); }
  return shapeCache.get(key);
}
const openStrings = () => (S.ctx.tuning && S.ctx.tuning.open) || [null, 64, 59, 55, 50, 45, 40];

function chordAt(t) {
  const i = barIndexAt(t);
  if (i < 0) return null;
  const b = S.timed.bars[i];
  const k = Math.min(b.chords.length - 1, Math.floor((t - b.t) / Math.max(0.01, b.t1 - b.t) * b.chords.length));
  return b.chords[Math.max(0, k)];
}

async function startGuitar() {
  if (!S.timed || S.kind !== "file") return;
  if (!S.guitarLook) S.guitarLook = new Lookahead((h, now) => fillGuitar(h, now));
  if (S.guitarLook.running) return;
  const midis = [];
  if (S.partEvents) midis.push(...new Set(S.partEvents.map((e) => e.midi)));
  else {
    const names = [...new Set(S.timed.bars.flatMap((b) => b.chords))];
    const open = openStrings();
    for (const n of names) { const f = framesFor(n); if (f) f.forEach((x, i) => { if (x !== null) midis.push(open[6 - i] + x); }); }
  }
  await warmNotes(midis);
  if (S && S.engine && S.engine.playing && S.set.mix.guitar.on) S.guitarLook.start();
}

function stopGuitar() {
  if (!S) return;
  if (S.guitarLook) S.guitarLook.stop();
  S.voices.silence(0.05);
  S.scheduled.clear();
}

function fillGuitar(horizon, now) {
  if (!S || S.kind !== "file" || !S.engine.playing || !S.timed) return;
  if (S.partEvents) {
    // Your part, note by note, on the recording's clock (any speed, across loop jumps).
    for (const h of S.engine.timesBetween(S.partTimes, Math.max(now, now + 0.005), horizon)) {
      const key = "p" + h.seg.toFixed(4) + ":" + h.index;
      if (S.scheduled.has(key)) continue;
      S.scheduled.set(key, h.at);
      const e = S.partEvents[h.index];
      S.voices.playNote(e.string, e.midi, h.at, e.level);
      if (e.mute) S.voices.damp(e.string, h.at + 0.03, 0.01);
    }
    if (S.scheduled.size > 256) for (const [k, at] of S.scheduled) if (at < now - 1) S.scheduled.delete(k);
    return;
  }
  const hits = S.engine.timesBetween(S.timed.strumTimes, Math.max(now, now + 0.005), horizon);
  for (const h of hits) {
    const key = h.seg.toFixed(4) + ":" + h.index;
    if (S.scheduled.has(key)) continue;
    S.scheduled.set(key, h.at);
    const name = chordAt(h.song + 0.01);
    const frets = name && framesFor(name);
    if (frets) strum(S.voices, frets, h.at, { dir: S.timed.strums[h.index].dir, level: S.timed.strums[h.index].dir === "U" ? 0.18 : 0.26, open: openStrings() });
  }
  if (S.scheduled.size > 64) for (const [k, at] of S.scheduled) if (at < now - 1) S.scheduled.delete(k);
}

/* ---- Engine events ---- */

function onEngine(type, detail, engine) {
  if (!S || S.engine !== engine) return;
  kick();
  if (type === "state") {
    if (engine.playing) {
      requestWakeLock();
      if (S.kind === "file") startKeepalive();
      if (S.set.mix.guitar.on) startGuitar();
      startFrames();
    } else {
      stopGuitar();
      stopKeepalive();
      releaseWakeLock();
      persist();
    }
    syncTransport();
    updateMediaSession();
  } else if (type === "seek" || type === "rate") {
    S.voices.silence(0.03);
    S.scheduled.clear();
    if (type === "rate") { S.set.speed = engine.currentRate; syncControls(); }
    updatePositionState();
  } else if (type === "wrap") {
    if (detail && detail.epoch !== undefined && detail.epoch !== engine.epoch) return;
    S.passes = detail ? detail.passes : 0;
    notePass(engine.currentRate || S.set.speed, S.passes);
    syncPractice();
  } else if (type === "beat") {
    flashCount(detail);
  } else if (type === "ended") {
    syncTransport();
  } else if (type === "error") {
    S.error = detail && detail.message;
    syncSource();
  } else if (type === "needs-tap") {
    toast("Tap the video once to start it; iPhones need that the first time.", 4000);
  }
}

function flashCount(d) {
  const el = S.view && S.view.querySelector(".countin");
  if (!el || !d) return;
  el.textContent = `${d.beat} / ${d.beats}`;
  el.classList.remove("hidden");
  clearTimeout(flashCount.t);
  flashCount.t = setTimeout(() => el.classList.add("hidden"), (60 / songTempo()) / (S.set.speed || 1) * 1000 + 50);
}

/* ---- Frames: waveform, chord now, time, and the synced sheet ---- */

function startFrames() {
  if (!S || S.raf) return;
  const tick = () => {
    if (!S) return;
    S.raf = requestAnimationFrame(tick);
    frame();
  };
  S.raf = requestAnimationFrame(tick);
}

function stopFrames() {
  if (S && S.raf) cancelAnimationFrame(S.raf);
  if (S) S.raf = 0;
}

let lastMedia = 0;
function frame() {
  const e = S.engine;
  const pos = e ? e.position : 0;
  if (S.view && S.wave && !S.wave.destroyed) {
    S.wave.update({ pos, a: S.set.a, b: S.set.b, on: S.set.loopOn, playing: !!(e && e.playing) });
    S.wave.draw();
  }
  if (S.view) {
    const t = S.view.querySelector(".p-time");
    if (t) t.textContent = `${fmtTime(pos)} / ${fmtTime(S.duration, false)}`;
    syncNow(pos);
  }
  for (const fn of frameListeners) fn({ id: S.id, pos, playing: !!(e && e.playing), kind: S.kind });
  const now = performance.now();
  if (e && e.playing && now - lastMedia > 1000) { lastMedia = now; updatePositionState(); }
  if (!(e && e.playing) && !(S.wave && S.wave.gesture)) {
    // Idle: a few more frames for settling, then stop until something moves.
    S.idle = (S.idle || 0) + 1;
    if (S.idle > 30) stopFrames();
  } else S.idle = 0;
}

function kick() { if (S) { S.idle = 0; startFrames(); } }

// The chord now and next, the bar, and the lyric line (mockup 6).
let lastNowKey = "";
function syncNow(pos) {
  const box = S.view.querySelector(".karaoke");
  if (!box) return;
  let html = "";
  const disp = S.ctx.disp;
  const lyr = S.ctx.lyrics;
  let lineText = "", nextText = "";
  if (lyr && lyr.timing && lyr.timing.length) {
    let li = -1;
    for (const x of lyr.timing) if (x.t <= pos + 0.05) li = x.index;
    const after = lyr.timing.find((x) => x.t > pos + 0.05);
    lineText = li >= 0 ? lyr.lines[li] || "" : "";
    nextText = after ? lyr.lines[after.index] || "" : "";
  }
  if (S.timed && S.kind === "file") {
    const i = barIndexAt(pos);
    const b = S.timed.bars[Math.max(0, i)];
    const now = i >= 0 ? chordAt(pos) : null;
    const sec = sectionAt(pos);
    // The next chord change after now.
    let next = null;
    outer: for (let j = Math.max(0, i); j < S.timed.bars.length; j++) {
      const bj = S.timed.bars[j];
      for (let k = 0; k < bj.chords.length; k++) {
        if (bj.t + (bj.t1 - bj.t) * k / bj.chords.length <= pos) continue;
        if (bj.chords[k] !== now) { next = bj.chords[k]; break outer; }
      }
    }
    const inSec = sec ? sec.bars.indexOf(i) : -1;
    const key = [i, now, S.set.semis, lineText].join("|");
    if (key === lastNowKey) return;
    lastNowKey = key;
    html = `<div class='chordnow'><span class='big'>${now ? esc(prettyChord(disp(now))) : "–"}</span>
      <span class='next meta'>${next ? (i < 0 ? "starts on " : "next ") + esc(prettyChord(disp(next))) : ""}${sec && inSec >= 0 ? ` · ${esc(sec.name)}, bar ${inSec + 1} of ${sec.bars.length}` : i >= 0 && b ? ` · bar ${i + 1}` : ""}</span></div>`;
  } else {
    const key = ["-", lineText].join("|");
    if (key === lastNowKey) return;
    lastNowKey = key;
    html = `<div class='chordnow'><span class='meta'>${S.kind === "youtube" ? "Chords follow along with your own recording; YouTube's audio can't be analysed." : "No bar times yet: analyse the recording to follow its chords."}</span></div>`;
  }
  if (lineText || nextText) html += `<div class='lyr'>${esc(lineText)}</div><div class='lyr2'>${esc(nextText)}</div>`;
  box.innerHTML = html;
}

/* ---- Lanes ---- */

function refreshLanes() {
  if (!S.wave) return;
  if (!S.timed || S.kind !== "file") { S.wave.setLanes({}); return; }
  const disp = S.ctx.disp;
  S.wave.setLanes({
    bars: S.timed.bars.map((b) => ({ t: b.t, label: b.chords.map((c) => prettyChord(disp(c))).join(" ") })),
    sections: S.timed.sections,
  });
  lastNowKey = "";
}

/* ---- Rendering ---- */

function render() {
  const { view, ctx } = S;
  if (!view) return;
  const scroll = view.querySelector("#song-scroll");
  const keep = scroll ? scroll.scrollTop : 0;
  if (S.wave) S.wave.destroyed = true;
  view.innerHTML = `
    <div class='topbar'>
      <a class='back' href='#/songs' aria-label='Back to songs'>${ICONS.back}</a>
      <div class='topbar-title'><div class='t'>${esc(ctx.title)}</div><div class='meta'>${esc(ctx.artist || "")}</div></div>
      ${sourceBadge()}
    </div>
    <div class='song-body'>
      <div class='song-scroll' id='song-scroll'><div class='song-main-col player'>
        ${ctx.modesHtml}
        ${S.error ? `<div class='card empty' role='alert'><b>That didn't work.</b><br>${esc(S.error)}</div>` : ""}
        ${S.loading ? `<div class='card empty' aria-live='polite'>${esc(S.loading)}</div>` : ""}
        ${S.kind === "youtube" ? `<div class='yt-box card'><div class='yt-host'></div></div>` : ""}
        ${S.kind ? stageHtml() : sourceHtml()}
      </div></div>
      <aside class='song-side' aria-label='Chords and transport'>${ctx.sideHtml || ""}
        <div class='transport'>${transportInner()}</div></aside>
    </div>
    <div class='transport mobile'>${transportInner()}</div>`;
  view.querySelector("#song-scroll").scrollTop = keep;
  S.wave = null;
  const cv = view.querySelector(".wave-main");
  if (cv) {
    S.wave = new WaveView(cv, view.querySelector(".wave-over"), {
      seek: (t) => { if (S.engine) S.engine.seek(t); kick(); },
      setA: (t) => { S.set.a = t; S.set.loopId = null; applyLoop(false); kick(); },
      setB: (t) => { S.set.b = t; S.set.loopId = null; applyLoop(false); kick(); },
      loopChanged: () => {
        S.set.a = snap(S.set.a);
        S.set.b = snap(S.set.b);
        if (S.set.a !== null && S.set.b !== null) S.set.loopOn = true;
        applyLoop();
        kick();
      },
    });
    S.wave.setSong(S.an, S.duration, S.set.view);
    refreshLanes();
  }
  lastNowKey = "";
  wire();
  syncAll();
  if (S.kind) loadLoops();
  kick();
}

function sourceBadge() {
  if (S.kind === "file" && S.playingStems) return "<span class='badge mine'>Stems</span>";
  if (S.kind === "file") return `<span class='badge mine'>${S.meta && S.meta.source === "helper" ? "Downloaded" : S.meta && S.meta.source === "app" ? "With the app" : "Your file"}</span>`;
  if (S.kind === "youtube") return "<span class='badge pick'>YouTube</span>";
  return "";
}

function youTubeLinks() {
  const out = [];
  const add = (url, label) => { const id = parseYouTubeId(url); if (id && !out.some((x) => x.id === id)) out.push({ id, url, label }); };
  // A song with its own recording keeps its links (a tutorial, say) in Chords mode, not here.
  if (S.ctx.chart && S.ctx.chart.audio) return out;
  if (S.set.youtube) add("https://www.youtube.com/watch?v=" + S.set.youtube.id, S.set.youtube.title || "Your YouTube link");
  for (const l of (S.ctx.chart && S.ctx.chart.links) || []) add(l.url, l.label);
  return out;
}

const FILE_INPUT = "<input type='file' class='sr-only p-file' accept='audio/*,video/mp4,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.mp4,.mov'>";

// No source yet: your file, a YouTube link, or a download through the helper.
function sourceHtml() {
  const yts = youTubeLinks();
  const helper = helperUrl();
  return `<div class='card set-group'>
    ${S.ctx.chart && S.ctx.chart.audio ? `<div class='set-row'><div><div class='set-label'>The recording with the app</div><div class='meta'>${esc(S.ctx.chart.audio.label || "")}</div></div>
      <button class='btn primary small' data-act='shipped'>Load</button></div>` : ""}
    <div class='set-row'><div><div class='set-label'>Your recording</div><div class='meta'>mp3, m4a, wav or flac from Files. Kept on this device; speed and pitch work on it.</div></div>
      <label class='btn ${S.ctx.chart && S.ctx.chart.audio ? "outline" : "primary"} small file-btn'>Choose file${FILE_INPUT}</label></div>
    ${yts.map((y) => `<div class='set-row'><div style='min-width:0'><div class='set-label ellipsis'>${esc(y.label || "YouTube")}</div>
        <div class='meta'>In YouTube's player: speed and loops. Pitch needs the audio${helper ? ", which the helper can download" : ""}.</div></div>
      <div class='row-btns'><button class='btn outline small' data-yt='${esc(y.id)}'>Play</button>
      ${helper ? `<button class='btn outline small' data-dl='${esc(y.url)}'>Download</button><button class='btn outline small' data-pcl='${esc(y.url)}'>Analyse</button>` : ""}</div></div>`).join("")}
    <form class='set-row link-row' data-act='link'>
      <input class='text-input' name='link' type='url' inputmode='url' placeholder='Paste a YouTube link' aria-label='YouTube link' autocomplete='off'>
      <button class='btn outline small' type='submit'>Add</button></form>
    ${helper ? "" : "<p class='note'>To shift a YouTube video's pitch, set up the PC helper (Settings → PC helper). It downloads the audio at home.</p>"}
    ${S.dl ? `<div class='prog' aria-label='Downloading'><i style='width:${Math.round((S.dl.p || 0) * 100)}%'></i></div><p class='note'>${esc(S.dl.text)}</p>` : ""}
    ${helper ? "<p class='note'>Analyse: your PC downloads it and finds the chords, stems and sections, then the phone keeps it all.</p>" : ""}
    <div class='pc-status'>${pcStatusHtml()}</div>
  </div>`;
}

/* ---- A link analysed on the PC (js/pcjob.js) ---- */

function pcStatusHtml() {
  const st = pcJob(S.id);
  if (!st || st.phase === "done" || st.phase === "cleared") return "";
  if (st.phase === "failed" || st.phase === "cancelled") return `<p class='note' role='alert'>On your PC: ${esc(st.error || "that didn't work.")}</p>`;
  const step = st.job && st.job.steps && st.job.steps.find((x) => x.p < 1);
  const text = !st.id ? "Asking your PC…" : st.phase === "fetching" ? "Bringing the results over…" : st.phase === "importing" ? "Keeping them on this device…"
    : st.offline ? "Can't reach the PC right now; still trying." : (step ? step.label : "Finishing") + "…";
  const p = st.phase === "running" ? (st.job && st.job.progress) || 0 : 1;
  return `<div class='prog' aria-label='Analysing on your PC'><i style='width:${Math.round(p * 100)}%'></i></div>
    <div class='set-row'><p class='note' aria-live='polite' style='margin:0'>On your PC: ${esc(text)}</p><button class='btn outline small' data-pc-cancel>Cancel</button></div>`;
}

function listenPc() {
  if (S.unlistenPc) S.unlistenPc();
  const s = S;
  S.unlistenPc = onPcJob(S.id, (st) => {
    if (S !== s) return;
    if (st.phase === "done") {
      const r = st.result;
      toast(`From your PC: the recording, ${r.chart.bars.length} bars of chords${r.stems ? ` and ${r.stems} stems` : ""}. Check the chords by ear.`, 4500);
      clearPcJob(s.id);
      // Play the recording that came back, not the YouTube video.
      if (r.audio) { s.set.source = "file"; persist(true); }
      if (s.ctx.onImported) s.ctx.onImported();
      return;
    }
    const el = s.view && s.view.querySelector(".pc-status");
    if (el) { el.innerHTML = pcStatusHtml(); wirePcStatus(el); }
  });
}

function wirePcStatus(el) {
  const b = el.querySelector("[data-pc-cancel]");
  if (b) b.addEventListener("click", () => cancelPcJob(S.id));
}

async function analyseLink(link) {
  const lines = S.ctx.lyrics ? S.ctx.lyrics.lines : [];
  await startPcJob(S.id, { link, title: S.ctx.title, artist: S.ctx.artist, lyricCount: lines.length,
    lyrics: lines.map((text, index) => ({ index, text })).filter((x) => x.text) });
  listenPc();
  const el = S.view && S.view.querySelector(".pc-status");
  if (el) { el.innerHTML = pcStatusHtml(); wirePcStatus(el); }
}

function stageHtml() {
  const file = S.kind === "file";
  const s = S.set;
  return `
    <div class='card wave-card ${file ? "" : "timeline-only"}'>
      <canvas class='wave-main' aria-label='Waveform: tap to jump, drag A and B to set the loop'></canvas>
      <canvas class='wave-over' aria-label='Whole song'></canvas>
      <div class='countin hidden' aria-live='assertive'></div>
    </div>
    <div class='wave-tools'>
      <span class='p-time meta'>0:00.0 / ${fmtTime(S.duration, false)}</span>
      <span class='spacer'></span>
      <button class='tool small' data-act='zoom-out' aria-label='Zoom out'>−</button>
      <button class='tool small' data-act='zoom-loop' aria-label='Zoom to the loop'>⟷</button>
      <button class='tool small' data-act='zoom-in' aria-label='Zoom in'>+</button>
    </div>
    <div class='card karaoke' aria-live='off'></div>
    <div class='pills loop-pills' role='group' aria-label='Loops'></div>
    <div class='toolbar ab-row'>
      <button class='tool' data-act='a'>A here</button>
      <button class='tool' data-act='b'>B here</button>
      <button class='tool' data-act='loop' aria-pressed='${s.loopOn}'>⟲ Loop</button>
      <button class='tool' data-act='clear-loop'>Clear</button>
      ${S.timed ? `<button class='tool ${s.snap ? "on" : ""}' data-act='snap' aria-pressed='${s.snap}'>Snap to bars</button>` : ""}
    </div>
    <div class='card ctl-card'>
      <div class='ctl'><span class='k'>Speed</span><button class='btn outline round' data-hold='speed-' aria-label='Slower'>−</button>
        <div class='val'><span class='v-speed'></span><small>${file ? "pitch kept" : "YouTube's own speed"}</small></div>
        <button class='btn outline round' data-hold='speed+' aria-label='Faster'>+</button></div>
      <div class='ctl ${file ? "" : "off"}'><span class='k'>Pitch</span><button class='btn outline round' data-hold='pitch-' aria-label='Pitch down' ${file ? "" : "disabled"}>−</button>
        <div class='val'><span class='v-pitch'></span><small>${file ? "semitones · chords follow" : "needs the audio (the helper)"}</small></div>
        <button class='btn outline round' data-hold='pitch+' aria-label='Pitch up' ${file ? "" : "disabled"}>+</button></div>
      <div class='ctl ${file ? "" : "off"}'><span class='k'>Tune</span><button class='btn outline round' data-hold='cents-' aria-label='Tune down' ${file ? "" : "disabled"}>−</button>
        <div class='val'><span class='v-cents'></span><small class='tune-note'>fine tune</small></div>
        <button class='btn outline round' data-hold='cents+' aria-label='Tune up' ${file ? "" : "disabled"}>+</button></div>
      ${file ? `<div class='ctl-row'><button class='btn outline small' data-act='match'>Match my tuning</button>
        <button class='tool ${s.formant ? "on" : ""}' data-act='formant' aria-pressed='${s.formant}'>Natural voice</button>
        <button class='tool' data-act='reset-pitch'>Reset</button></div>` : ""}
    </div>
    <div class='card set-group practice-card'></div>
    <div class='card mixer' aria-label='Mixer'></div>
    ${sourceDetails()}`;
}

function sourceDetails() {
  const helper = helperUrl();
  const yts = youTubeLinks();
  const id = encodeURIComponent(S.id);
  if (S.kind === "file") {
    const m = S.meta;
    const timedFrom = S.timed && S.timed.file;
    return `<div class='card set-group'>
      <div class='set-row'><div style='min-width:0'><div class='set-label'>Recording</div>
        <div class='meta ellipsis'>${m ? esc(m.name) + " · " + fmtBytes(m.size) : ""} · ${m && m.source === "app" ? "comes with the app" : m && m.source === "unsaved" ? "not kept on this device" : "on this device"}</div></div>
        <label class='btn outline small file-btn'>Change${FILE_INPUT}</label></div>
      ${S.timed ? (timedFrom && m && timedFrom !== m.name ? `<p class='note'>The chords' bar times come from ${esc(timedFrom)}; analyse this file to line them up.</p>` : "")
        : `<div class='set-row'><div><div class='set-label'>Chords</div><div class='meta'>Analyse the recording for chord and section lanes, loops by bar and the app guitar.</div></div>
          <a class='btn outline small' href='#/song/${id}/analyse'>Analyse</a></div>`}
      ${yts.length ? `<div class='set-row'><div class='meta'>Also on YouTube: ${esc(yts[0].label || "link")}</div><button class='btn outline small' data-yt='${esc(yts[0].id)}'>Switch</button></div>` : ""}
    </div>`;
  }
  return `<div class='card set-group'>
    <div class='set-row'><div style='min-width:0'><div class='set-label ellipsis'>${esc((S.set.youtube && S.set.youtube.title) || "YouTube")}</div>
      <div class='meta'>Speed 25–200% and loops. Pitch, the waveform and chords need the audio.</div></div>
      ${helper ? `<div class='row-btns'><button class='btn outline small' data-dl='${esc("https://www.youtube.com/watch?v=" + S.set.youtube.id)}'>Download</button><button class='btn outline small' data-pcl='${esc("https://www.youtube.com/watch?v=" + S.set.youtube.id)}'>Analyse</button></div>` : ""}</div>
    ${helper ? "" : "<p class='note'>Set up the PC helper (Settings → PC helper) to download this audio at home; then pitch works too.</p>"}
    ${S.dl ? `<div class='prog'><i style='width:${Math.round((S.dl.p || 0) * 100)}%'></i></div><p class='note'>${esc(S.dl.text)}</p>` : ""}
    <div class='pc-status'>${pcStatusHtml()}</div>
    <div class='set-row'><div class='meta'>Or use your own file.</div><label class='btn outline small file-btn'>Choose file${FILE_INPUT}</label></div>
  </div>`;
}

function transportInner() {
  const playing = S.engine && S.engine.playing;
  return `<button class='btn outline round' data-act='restart' aria-label='Back to the start of the loop' ${S.engine ? "" : "disabled"}>⏮</button>
    <button class='btn outline' data-act='mixer' style='padding:0 12px'>Mixer</button>
    <button class='btn primary play p-play' data-act='play' style='flex:1' ${S.engine ? "" : "disabled"}>${playing ? "❚❚ Pause" : "▶ Play"}</button>`;
}

/* ---- Partial updates ---- */

function syncAll() {
  syncTransport();
  syncControls();
  syncLoop();
  syncPractice();
  syncMixer();
}

function syncTransport() {
  if (!S || !S.view) return;
  const playing = S.engine && S.engine.playing;
  S.view.querySelectorAll(".p-play").forEach((b) => {
    b.textContent = playing ? "❚❚ Pause" : "▶ Play";
    b.disabled = !S.engine;
    b.classList.toggle("stop", !!playing);
  });
  S.view.querySelectorAll("[data-act=restart]").forEach((b) => { b.disabled = !S.engine; });
}

function syncControls() {
  if (!S || !S.view) return;
  const q = (sel) => S.view.querySelector(sel);
  const speed = S.engine && S.engine.playing ? S.engine.currentRate || S.set.speed : S.set.speed;
  if (q(".v-speed")) q(".v-speed").textContent = Math.round(speed * 100) + "%";
  if (q(".v-pitch")) q(".v-pitch").textContent = S.kind === "file" ? fmtSemis(S.set.semis) : "–";
  if (q(".v-cents")) q(".v-cents").textContent = S.kind === "file" ? fmtCents(S.set.cents) : "–";
  if (q(".tune-note") && S.note) q(".tune-note").textContent = S.note;
  S.view.querySelectorAll("[data-act=formant]").forEach((b) => { b.classList.toggle("on", S.set.formant); b.setAttribute("aria-pressed", S.set.formant); });
}

function syncLoop() {
  if (!S || !S.view) return;
  const box = S.view.querySelector(".loop-pills");
  if (!box) return;
  const s = S.set;
  const pos = S.engine ? S.engine.position : 0;
  const sec = S.timed && S.kind === "file" ? sectionAt(pos) : null;
  const pills = [];
  if (sec) {
    const on = s.loopOn && Math.abs(s.a - sec.t0) < 0.02 && Math.abs(s.b - sec.t1) < 0.02;
    pills.push(`<button class='pill ${on ? "on" : ""}' data-act='loop-sec' aria-pressed='${on}'>Loop ${esc(sec.name)}</button>`);
  }
  if (S.timed && S.kind === "file") {
    const i = Math.max(0, barIndexAt(pos)), from = Math.floor(i / 4) * 4, to = Math.min(S.timed.bars.length - 1, from + 3);
    pills.push(`<button class='pill' data-act='loop-bars'>Bars ${from + 1}–${to + 1}</button>`);
  }
  for (const l of S.loops) {
    const on = s.loopOn && s.loopId === l.id;
    pills.push(`<button class='pill ${on ? "on" : ""}' data-loop='${esc(l.id)}' aria-pressed='${on}'>${esc(l.name)}</button>`);
  }
  pills.push(`<button class='pill' data-act='save-loop'>+ Save loop</button>`);
  box.innerHTML = pills.join("");
  box.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, b)));
  box.querySelectorAll("[data-loop]").forEach((b) => b.addEventListener("click", () => {
    const l = S.loops.find((x) => x.id === b.dataset.loop);
    if (!l) return;
    if (S.set.loopOn && S.set.loopId === l.id) { S.set.loopOn = false; applyLoop(); return; }
    setLoop(l.a, l.b, true, l.id);
    if (S.engine && !S.engine.playing) S.engine.seek(l.a);
  }));
  S.view.querySelectorAll("[data-act=loop]").forEach((b) => { b.setAttribute("aria-pressed", s.loopOn); b.classList.toggle("on", s.loopOn); b.disabled = s.a === null || s.b === null; });
  S.view.querySelectorAll("[data-act=snap]").forEach((b) => { b.setAttribute("aria-pressed", s.snap); b.classList.toggle("on", s.snap); });
  S.view.querySelectorAll("[data-act=a]").forEach((b) => { b.textContent = s.a === null ? "A here" : "A " + fmtTime(s.a); });
  S.view.querySelectorAll("[data-act=b]").forEach((b) => { b.textContent = s.b === null ? "B here" : "B " + fmtTime(s.b); });
}

function syncPractice() {
  if (!S || !S.view) return;
  const box = S.view.querySelector(".practice-card");
  if (!box) return;
  const s = S.set, t = s.trainer;
  const pct = (x) => Math.round(x * 100) + "%";
  const running = s.trainerOn && S.engine && S.engine.trainer;
  const pass = running && S.passes ? ` · loop ${S.passes}, now ${pct(S.engine.currentRate)}` : "";
  box.innerHTML = `
    <div class='set-row'><div><div class='set-label'>Count-in</div><div class='meta'>Clicks at ${Math.round(songTempo())} bpm${S.set.speed !== 1 ? ", scaled to your speed" : ""}, before playing and each loop.</div></div></div>
    <div class='seg small-seg' role='group' aria-label='Count-in' style='margin-bottom:10px'>${[[0, "Off"], [1, "1 bar"], [2, "2 bars"]].map(([v, l]) =>
      `<button data-count='${v}' class='${s.countIn === v ? "on" : ""}' aria-pressed='${s.countIn === v}'>${l}</button>`).join("")}</div>
    <div class='set-row'><div><div class='set-label'>Speed trainer</div><div class='meta'>${pct(t.start)} → ${pct(t.target)}, +${Math.round(t.step * 100)}% every ${t.every} loop${t.every === 1 ? "" : "s"}${pass}</div></div>
      <button class='switch ${s.trainerOn ? "on" : ""}' role='switch' aria-checked='${s.trainerOn}' data-act='trainer' aria-label='Speed trainer'></button></div>
    ${s.trainerOn ? `<div class='trainer-grid'>${[["start", "Start", pct(t.start)], ["step", "Step", "+" + Math.round(t.step * 100) + "%"], ["every", "Loops per step", String(t.every)], ["target", "Up to", pct(t.target)]].map(([k, l, v]) =>
      `<div class='tg'><span class='meta'>${l}</span><div class='tg-row'><button class='btn outline round small-round' data-tr='${k}-' aria-label='${l} down'>−</button><b>${v}</b><button class='btn outline round small-round' data-tr='${k}+' aria-label='${l} up'>+</button></div></div>`).join("")}</div>
      <p class='note'>Needs a loop: the speed goes up as the loop repeats.</p>` : ""}`;
  box.querySelectorAll("[data-count]").forEach((b) => b.addEventListener("click", () => { S.set.countIn = +b.dataset.count; applyCountIn(); }));
  box.querySelector("[data-act=trainer]").addEventListener("click", () => { S.set.trainerOn = !S.set.trainerOn; applyTrainer(); });
  box.querySelectorAll("[data-tr]").forEach((b) => b.addEventListener("click", () => {
    const [k, dir] = [b.dataset.tr.slice(0, -1), b.dataset.tr.slice(-1) === "+" ? 1 : -1];
    const t2 = S.set.trainer;
    if (k === "start") t2.start = clamp(Math.round((t2.start + dir * 0.05) * 100) / 100, SPEED_MIN, 1.5);
    if (k === "step") t2.step = clamp(Math.round((t2.step + dir * 0.01) * 100) / 100, 0.01, 0.25);
    if (k === "every") t2.every = clamp(t2.every + dir, 1, 10);
    if (k === "target") t2.target = clamp(Math.round((t2.target + dir * 0.05) * 100) / 100, SPEED_MIN, 1.5);
    applyTrainer();
  }));
}

function syncMixer() {
  if (!S || !S.view) return;
  const box = S.view.querySelector(".mixer");
  if (!box) return;
  const guitarOk = !!S.timed && S.kind === "file";
  const hasRec = !!(S.meta && S.meta.source !== "unsaved");
  const seg = S.stems && S.kind === "file" ? `<div class='seg small-seg' role='group' aria-label='Play the recording or its stems' style='margin-bottom:8px'>
      <button data-stems='0' class='${S.playingStems ? "" : "on"}' aria-pressed='${!S.playingStems}' ${hasRec ? "" : "disabled"}>Full mix</button>
      <button data-stems='1' class='${S.playingStems ? "on" : ""}' aria-pressed='${!!S.playingStems}'>Stems</button></div>` : "";
  box.innerHTML = `<div class='h2'>Mixer</div>` + seg + mixRows().map(([key, name, sub]) => {
    const m = mixOf(key);
    const off = key === "guitar" && !guitarOk;
    const subText = key === "recording" && S.kind === "youtube" ? "YouTube sets its own volume" : off ? "needs analysed bars" : key === "guitar" && S.partEvents ? "plays your guitar part" : sub;
    return `<div class='track ${m.on && !off ? "" : "off"}'>
      <span class='tn'>${esc(name)}<span class='ts'>${subText}</span></span>
      <input type='range' min='0' max='1' step='0.05' value='${m.vol}' data-vol='${esc(key)}' aria-label='${esc(name)} volume' ${off || (key === "recording" && S.kind === "youtube") ? "disabled" : ""}>
      <button class='mute ${m.on && !off ? "on" : ""}' data-mute='${esc(key)}' aria-pressed='${m.on && !off}' aria-label='${esc(name)} on or off' ${off ? "disabled" : ""}>${m.on && !off ? "On" : "Off"}</button></div>`;
  }).join("") + (S.playingStems ? `<p class='note'>Stems separated on the PC by Demucs from ${esc(S.stems.file || "your recording")}; a little bleed between them is normal.</p>` : "");
  box.querySelectorAll("[data-vol]").forEach((r) => r.addEventListener("input", () => {
    mixOf(r.dataset.vol).vol = +r.value;
    applyMix();
    persist();
  }));
  box.querySelectorAll("[data-mute]").forEach((b) => b.addEventListener("click", () => {
    const m = mixOf(b.dataset.mute);
    m.on = !m.on;
    applyMix();
    syncMixer();
    persist();
  }));
  box.querySelectorAll("[data-stems]").forEach((b) => b.addEventListener("click", () => {
    const on = b.dataset.stems === "1";
    if (on !== !!S.playingStems && !b.disabled) setStems(on);
  }));
}

function syncSource() {
  if (!S || !S.view) return;
  render();
}

/* ---- Wiring ---- */

function wire() {
  const v = S.view;
  v.querySelectorAll("[data-act]").forEach((b) => {
    if (b.closest(".loop-pills")) return;
    if (b.tagName === "FORM") return;
    b.addEventListener("click", () => act(b.dataset.act, b));
  });
  v.querySelectorAll("[data-hold]").forEach((b) => holdable(b, () => hold(b.dataset.hold)));
  v.querySelectorAll(".p-file").forEach((inp) => inp.addEventListener("change", async () => {
    const f = inp.files[0];
    inp.value = "";
    if (!f) return;
    await resumeAudio();
    try {
      S.meta = await saveRecording(S.id, f);
    } catch (e) {
      // Still play it; it just won't be here next time.
      await loadFile(f, { name: f.name, size: f.size, source: "unsaved" });
      toast("Playing it, but this browser wouldn't keep it (private browsing?), so you'll need to choose it again next time.", 5000);
      return;
    }
    await loadFile();
    toast("Kept on this device. Analyse it for chords and sections.");
  }));
  v.querySelectorAll("[data-yt]").forEach((b) => b.addEventListener("click", async () => { await resumeAudio(); loadYouTube(b.dataset.yt); }));
  v.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => download(b.dataset.dl)));
  v.querySelectorAll("[data-pcl]").forEach((b) => b.addEventListener("click", () => analyseLink(b.dataset.pcl)));
  v.querySelectorAll(".pc-status").forEach(wirePcStatus);
  if (pcJob(S.id)) listenPc();
  const form = v.querySelector("form[data-act=link]");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    const link = form.link.value.trim();
    const id = parseYouTubeId(link);
    if (!id) { toast("That doesn't look like a YouTube link."); return; }
    S.set.youtube = { id, title: null };
    persist();
    loadYouTube(id);
  });
  v.querySelectorAll(".seg button[data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (!b.disabled) location.hash = `#/song/${encodeURIComponent(S.id)}/${b.dataset.mode}`;
  }));
  if (S.ctx.wireSide) S.ctx.wireSide(v);
}

function hold(what) {
  kick();
  if (what === "speed-") setSpeed(S.set.speed - 0.05);
  else if (what === "speed+") setSpeed(S.set.speed + 0.05);
  else if (what === "pitch-") setPitch(S.set.semis - 1);
  else if (what === "pitch+") setPitch(S.set.semis + 1);
  else if (what === "cents-") setCents(S.set.cents - 1);
  else if (what === "cents+") setCents(S.set.cents + 1);
}

function act(a, el) {
  if (a === "play") togglePlayer();
  else if (a === "restart") { if (S.engine) S.engine.seek(S.set.loopOn && S.set.a !== null ? S.set.a : 0); kick(); }
  else if (a === "mixer") focusMixer();
  else if (a === "zoom-in") { S.wave && S.wave.zoom(2); kick(); }
  else if (a === "zoom-out") { S.wave && S.wave.zoom(0.5); kick(); }
  else if (a === "zoom-loop") { if (S.wave) { if (S.set.a !== null && S.set.b !== null) S.wave.fitLoop(); else S.wave.showAll(); } kick(); }
  else if (a === "a") setAHere();
  else if (a === "b") setBHere();
  else if (a === "loop") { S.set.loopOn = !S.set.loopOn; applyLoop(); }
  else if (a === "clear-loop") { Object.assign(S.set, { a: null, b: null, loopOn: false, loopId: null }); applyLoop(); kick(); }
  else if (a === "snap") { S.set.snap = !S.set.snap; syncLoop(); persist(); }
  else if (a === "loop-sec") loopSection();
  else if (a === "loop-bars") loopBars(4);
  else if (a === "save-loop") saveLoopDialog();
  else if (a === "match") matchTuning();
  else if (a === "shipped") loadShipped();
  else if (a === "formant") { S.set.formant = !S.set.formant; applyPitch(); }
  else if (a === "reset-pitch") { S.set.semis = 0; S.set.cents = 0; S.note = ""; applyPitch(); if (S.ctx.onPitch) S.ctx.onPitch(); }
  kick();
}

function matchTuning() {
  if (!S.an || !S.engine) return;
  const s = S.set, dur = S.duration;
  let t0, t1;
  if (s.a !== null && s.b !== null && s.b - s.a >= 3) { t0 = s.a; t1 = s.b; }
  else { const p = S.engine.position; t0 = Math.max(0, p - 15); t1 = Math.min(dur, t0 + 30); t0 = Math.max(0, t1 - 30); }
  const est = estimateTuning(S.an, t0, t1);
  if (!est) { S.note = "no clear notes there"; syncControls(); toast("Couldn't hear clear notes there. Try a part with sustained notes."); return; }
  const c = Math.round(est.cents);
  setCents(-c);
  S.note = c === 0 ? "recording at A440" : `recording ${Math.abs(c)}¢ ${c > 0 ? "sharp" : "flat"}${est.confidence < 0.25 ? " (unsure)" : ""}`;
  syncControls();
  toast(c === 0 ? "The recording is right at A440." : `The recording is ${Math.abs(c)}¢ ${c > 0 ? "sharp" : "flat"}; fine tune set to ${fmtCents(-c)}, so it matches a guitar at A440.`, 4000);
}

async function download(link) {
  if (S.dl) return;
  const s = S;
  s.dl = { p: 0, text: "Downloading on your PC… (a few seconds to a minute)" };
  syncSource();
  try {
    const r = await downloadAudio(link, (p) => { if (S === s && s.dl) { s.dl.p = p || 0; const bar = s.view && s.view.querySelector(".prog i"); if (bar) bar.style.width = Math.round((p || 0) * 100) + "%"; } });
    if (S !== s) return;
    const t = r.blob.type || "";
    const ext = /wav/.test(t) ? ".wav" : /mpeg/.test(t) ? ".mp3" : /webm/.test(t) ? ".webm" : /ogg/.test(t) ? ".ogg" : ".m4a";
    const file = new File([r.blob], (r.title || "Download") + ext, { type: r.blob.type || "audio/mp4" });
    s.meta = await saveRecording(s.id, file, { source: "helper", link });
    s.dl = null;
    await loadFile();
    toast("Downloaded and kept on this device. Pitch works now; analyse it for chords.", 4000);
  } catch (e) {
    if (S !== s) return;
    s.dl = null;
    s.error = e.message;
    syncSource();
  }
}

// Buttons that repeat while held (Pimapeggio's holdable).
function holdable(el, fire) {
  let t1 = null, t2 = null;
  const stop = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = null; };
  el.addEventListener("pointerdown", (e) => {
    if (el.disabled) return;
    e.preventDefault();
    fire();
    t1 = setTimeout(() => { t2 = setInterval(fire, 90); }, 420);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => el.addEventListener(t, stop));
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); } });
}

/* ---- Lock screen (Media Session) ---- */

// iOS only shows lock-screen controls for a playing media element, so a
// silent looping <audio> plays alongside the Web Audio output (speedy-pitcher).
let keepalive = null;
function silentWavUrl() {
  const sr = 8000, n = sr, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
function startKeepalive() {
  if (!keepalive) {
    keepalive = document.createElement("audio");
    keepalive.loop = true;
    keepalive.setAttribute("playsinline", "");
    keepalive.src = silentWavUrl();
  }
  keepalive.play().catch(() => {});
}
function stopKeepalive() { if (keepalive && !keepalive.paused) keepalive.pause(); }

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !S || S.kind !== "file") return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: S.ctx.title, artist: S.ctx.artist || "", album: "The Songbook",
      artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    navigator.mediaSession.playbackState = S.engine && S.engine.playing ? "playing" : "paused";
  } catch (e) { /* older browsers */ }
  updatePositionState();
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState || !S || !S.engine || !S.duration) return;
  try {
    navigator.mediaSession.setPositionState({ duration: S.duration, playbackRate: S.engine.currentRate || 1, position: clamp(S.engine.position, 0, S.duration) });
  } catch (e) { /* invalid state mid-load */ }
}

if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (e) { /* unsupported */ } };
  set("play", () => { if (S && S.engine && !S.engine.playing) togglePlayer(); });
  set("pause", () => { if (S && S.engine && S.engine.playing) S.engine.pause(); });
  set("stop", () => { if (S && S.engine) S.engine.pause(); });
  set("previoustrack", () => { if (S && S.engine) S.engine.seek(S.set.loopOn && S.set.a !== null ? S.set.a : 0); });
  set("seekbackward", (d) => { if (S && S.engine) S.engine.seek(S.engine.position - ((d && d.seekOffset) || 5)); });
  set("seekforward", (d) => { if (S && S.engine) S.engine.seek(S.engine.position + ((d && d.seekOffset) || 5)); });
  set("seekto", (d) => { if (S && S.engine && d && typeof d.seekTime === "number") S.engine.seek(d.seekTime); });
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") persist(true); });
  window.addEventListener("pagehide", () => persist(true));
}

// For the browser tests.
export const playerState = () => S && {
  id: S.id, kind: S.kind, set: S.set, duration: S.duration, timed: !!S.timed, loops: S.loops.map((l) => l.id), stems: !!S.playingStems,
  layout: S.engine && S.engine.layout ? S.engine.layout.map((l) => ({ track: l.track, channels: l.channels.length })) : null,
  engine: S.engine, voicesCents: S.voices.cents, scheduled: S.scheduled.size, passes: S.passes || 0,
  strums: [...S.scheduled].filter(([key]) => key[0] !== "p").map(([key, at]) => ({ key, at, song: S.timed ? S.timed.strumTimes[+key.split(":")[1]] : null })),
  partNotes: [...S.scheduled].filter(([key]) => key[0] === "p").map(([key, at]) => ({ at, song: S.partTimes[+key.split(":")[1]], midi: S.partEvents[+key.split(":")[1]].midi })),
  partLayer: !!S.partEvents,
};
