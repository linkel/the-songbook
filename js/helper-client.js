// The PC helper (helper/songbook_helper.py): it downloads a link's audio with
// yt-dlp over the home connection, and analyses recordings on the PC's GPU
// (stems, beats, chords, sections, lyric timing); the phone reaches it over
// Tailscale. Same download endpoints as speedy-pitcher's yt_helper.py (GET
// /ping and GET /audio?url=<link>), plus POST /analyze, GET /jobs/<id> and
// GET /bundle/<id>.zip. Its address is kept on this device.

const KEY = "songbook-helper-url";

export function helperUrl() {
  try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; }
}

export function setHelperUrl(url) {
  try { localStorage.setItem(KEY, String(url || "").trim()); } catch (e) { /* blocked */ }
}

const base = (url) => String(url || helperUrl()).trim().replace(/\/+$/, "");

// -> { ok, yt_dlp } or throws with a readable message.
export async function pingHelper(url) {
  const b = base(url);
  if (!b) throw new Error("Enter the helper's address first.");
  let r;
  try {
    r = await fetch(b + "/ping", { cache: "no-store" });
  } catch (e) {
    throw new Error("Couldn't reach the helper. Is it running, and is the address right? (On the phone it needs the https://…ts.net address from tailscale serve.)");
  }
  if (!r.ok) throw new Error("The helper answered with error " + r.status + ".");
  return r.json();
}

// What the helper can do, from /ping: { ok, analysis: { available, gpu, reason } }.
// Remembered for a minute, so screens can ask freely.
let info = { url: null, at: 0, value: null };
export async function helperInfo(force = false) {
  const b = base();
  if (!b) return null;
  if (!force && info.url === b && Date.now() - info.at < 60000) return info.value;
  let value = null;
  try { value = await pingHelper(b); } catch (e) { value = { ok: false, error: e.message }; }
  info = { url: b, at: Date.now(), value };
  return value;
}

async function call(path, init) {
  const b = base();
  if (!b) throw new Error("Set up the PC helper in Settings first.");
  let r;
  try {
    r = await fetch(b + path, init);
  } catch (e) {
    throw new Error("Couldn't reach the helper. Is it running, and is the address in Settings right?");
  }
  if (!r.ok) {
    let msg = "Helper error " + r.status;
    try { msg = (await r.json()).error || msg; } catch (e) { /* not JSON */ }
    throw new Error(msg);
  }
  return r;
}

// Queue an analysis on the PC: send the recording (file), or a link for the PC
// to download. lyrics: [{ index, text }] to line up with the vocals. parts:
// "guitar" for the guitar part too, in your tuning (notes, low first) and capo;
// with job (an earlier analysis's id), just the part, on that analysis. -> the job.
export async function startAnalysis({ file = null, link = null, song, title, artist, lyrics = null, parts = null, tuning = null, capo = null, job = null }) {
  const fd = new FormData();
  if (file) fd.append("file", file, file.name || "recording");
  for (const [k, v] of Object.entries({ song, title, artist, parts, tuning, job, name: file ? file.name : null })) if (v) fd.append(k, v);
  if (capo !== null && capo !== undefined) fd.append("capo", String(capo));
  if (lyrics && lyrics.length) fd.append("lyrics", JSON.stringify(lyrics));
  const r = await call("/analyze" + (link ? "?url=" + encodeURIComponent(link) : ""), { method: "POST", body: fd });
  return r.json();
}

export async function getJob(id) { return (await call("/jobs/" + encodeURIComponent(id), { cache: "no-store" })).json(); }
export async function cancelJob(id) { return (await call("/jobs/" + encodeURIComponent(id) + "/cancel", { method: "POST" })).json(); }

// The finished bundle (a zip). onProgress(fraction or null).
export async function fetchBundle(id, onProgress) {
  return readBody(await call("/bundle/" + encodeURIComponent(id) + ".zip"), onProgress, "application/zip");
}

async function readBody(r, onProgress, type) {
  const total = +r.headers.get("Content-Length") || 0;
  if (!(r.body && r.body.getReader && onProgress)) return r.blob();
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(total ? got / total : null);
  }
  return new Blob(parts, { type: r.headers.get("Content-Type") || type });
}

// Download a link's audio. onProgress(fraction or null). -> { blob, title, duration, sourceId }.
export async function downloadAudio(link, onProgress) {
  const r = await call("/audio?url=" + encodeURIComponent(link));
  const blob = await readBody(r, onProgress, "audio/mp4");
  const dec = (h) => { try { return decodeURIComponent(r.headers.get(h) || ""); } catch (e) { return r.headers.get(h) || ""; } };
  return { blob, title: dec("X-Title"), duration: +r.headers.get("X-Duration") || null, sourceId: dec("X-Source-Id") };
}
