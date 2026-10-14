// Analysis jobs on the PC helper, started from this device: send the
// recording (or a link for the PC to download), follow the job's steps, then
// fetch its bundle and import it (js/bundle.js). A job survives leaving the
// screen or reloading the app: its id is kept in localStorage per song, and
// whoever opens that song again picks it up.

import { startAnalysis, getJob, cancelJob, fetchBundle } from "./helper-client.js";
import { importBundle } from "./bundle.js";
import { shippedChart, loadChart } from "./library.js";

const KEY = (id) => "songbook-job-" + id;
const POLL_MS = 1500;
const jobs = new Map();   // songId -> state

// state: { songId, id, phase: "running" | "fetching" | "importing" | "done" | "failed" | "cancelled",
//          job (the helper's view), fetched (0..1), error, result, listeners }

function save(st) {
  try {
    if (st.phase === "running" || st.phase === "fetching") localStorage.setItem(KEY(st.songId), JSON.stringify({ id: st.id, ctx: st.ctx }));
    else localStorage.removeItem(KEY(st.songId));
  } catch (e) { /* storage blocked: the job just won't resume after a reload */ }
}

function emit(st) {
  save(st);
  for (const fn of st.listeners) { try { fn(st); } catch (e) { console.error(e); } }
}

function restore(songId) {
  try {
    const raw = localStorage.getItem(KEY(songId));
    if (!raw) return null;
    const { id, ctx } = JSON.parse(raw);
    const st = { songId, id, ctx, phase: "running", job: null, fetched: 0, error: null, result: null, listeners: new Set() };
    jobs.set(songId, st);
    poll(st);
    return st;
  } catch (e) {
    return null;
  }
}

// The job for this song (resuming one from before a reload), or null.
export function pcJob(songId) {
  return jobs.get(songId) || restore(songId);
}

export function onPcJob(songId, fn) {
  const st = pcJob(songId);
  if (!st) return () => {};
  st.listeners.add(fn);
  return () => st.listeners.delete(fn);
}

// Start: { file } or { link } (or { job }: just the guitar part, on an earlier
// analysis), plus title, artist, lyrics ([{ index, text }]), parts ("guitar"),
// tuning, capo. ctx is kept for the import: { title, artist, lyricCount }.
export async function startPcJob(songId, { file = null, link = null, job = null, title, artist, lyrics = null, lyricCount = null, parts = null, tuning = null, capo = null }) {
  const old = jobs.get(songId);
  if (old && (old.phase === "running" || old.phase === "fetching" || old.phase === "importing")) return old;
  const st = { songId, id: null, ctx: { title, artist, lyricCount }, phase: "running", job: null, fetched: 0, error: null, result: null,
    listeners: old ? old.listeners : new Set() };
  jobs.set(songId, st);
  emit(st);
  try {
    st.job = await startAnalysis({ file, link, job, song: songId, title, artist, lyrics, parts, tuning, capo });
    st.id = st.job.id;
    emit(st);
    poll(st);
  } catch (e) {
    st.phase = "failed";
    st.error = e.message;
    emit(st);
  }
  return st;
}

export async function cancelPcJob(songId) {
  const st = jobs.get(songId);
  if (!st || !st.id) return;
  try { await cancelJob(st.id); } catch (e) { /* the helper may be gone */ }
  st.phase = "cancelled";
  emit(st);
}

export function clearPcJob(songId) {
  const st = jobs.get(songId);
  if (st && (st.phase === "running" || st.phase === "fetching" || st.phase === "importing")) return;
  if (st) { st.phase = "cleared"; save(st); }
  jobs.delete(songId);
}

async function poll(st) {
  let misses = 0;
  while (jobs.get(st.songId) === st && st.phase === "running") {
    try {
      st.job = await getJob(st.id);
      misses = 0;
    } catch (e) {
      // The phone may lose the connection for a while (screen off, Tailscale reconnecting).
      if (++misses >= 20) { st.phase = "failed"; st.error = e.message; emit(st); return; }
      st.offline = true;
      emit(st);
      await sleep(POLL_MS * 2);
      continue;
    }
    st.offline = false;
    const s = st.job.state;
    if (s === "done") return finish(st);
    if (s === "failed" || s === "cancelled") {
      st.phase = s;
      st.error = st.job.error || (s === "cancelled" ? "Cancelled." : "The analysis failed.");
      emit(st);
      return;
    }
    emit(st);
    await sleep(POLL_MS);
  }
}

async function finish(st) {
  st.phase = "fetching";
  emit(st);
  try {
    const blob = await fetchBundle(st.id, (p) => { st.fetched = p || 0; emit(st); });
    st.phase = "importing";
    emit(st);
    const shipped = await shippedChart(st.songId).catch(() => null);
    const chart = await loadChart(st.songId).catch(() => null);
    st.result = await importBundle(blob, st.songId, { ...st.ctx, shipped, chart });
    st.phase = "done";
  } catch (e) {
    st.phase = "failed";
    st.error = e.message;
  }
  emit(st);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// For the browser tests.
export const pcJobs = () => [...jobs.values()].map((s) => ({ songId: s.songId, id: s.id, phase: s.phase, error: s.error }));
