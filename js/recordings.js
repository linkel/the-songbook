// Your recordings, kept on this device: the files go in the Origin Private
// File System (OPFS, a private folder only this site can see), with an
// IndexedDB fallback where OPFS can't write. Their details (name, size...)
// are in IndexedDB "songbook" -> recordings. A recording's stems (from the PC
// helper's analysis) are kept the same way, one file per stem. Nothing is
// uploaded, except when you ask the PC helper to analyse a recording.

import { get, getAll, put, del, requestPersist } from "./library.js";

const DIR = "songbook-recordings";
const STEMS_DIR = "songbook-stems";

async function dir(name = DIR) {
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(name, { create: true });
  } catch (e) {
    return null;
  }
}

// Writable OPFS files (Safari 17+ has createWritable; older Safari only has
// sync handles in workers, so those fall back to IndexedDB).
async function writeOpfs(name, blob, folder = DIR) {
  const d = await dir(folder);
  if (!d) return false;
  try {
    const fh = await d.getFileHandle(name, { create: true });
    if (!fh.createWritable) { await d.removeEntry(name).catch(() => {}); return false; }
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  } catch (e) {
    return false;
  }
}

const fileName = (songId) => songId.replace(/[^a-z0-9-]/gi, "_");

// Keep `file` as the recording of `songId` (replacing any earlier one).
export async function saveRecording(songId, file, extra = {}) {
  const name = fileName(songId);
  let backend = "opfs";
  if (!(await writeOpfs(name, file))) {
    backend = "idb";
    await put("recordings", { id: "blob:" + songId, blob: file });
  } else {
    await del("recordings", "blob:" + songId).catch(() => {});
  }
  const meta = {
    id: songId, kind: "meta", name: file.name || "recording", type: file.type || "", size: file.size,
    savedAt: Date.now(), backend, ...extra,
  };
  await put("recordings", meta);
  requestPersist();
  return meta;
}

export async function recordingMeta(songId) {
  const m = await get("recordings", songId).catch(() => null);
  return m && m.kind === "meta" ? m : null;
}

export async function updateRecordingMeta(songId, patch) {
  const m = await recordingMeta(songId);
  if (m) await put("recordings", { ...m, ...patch });
}

// The recording as a File/Blob, or null.
export async function getRecording(songId) {
  const m = await recordingMeta(songId);
  if (!m) return null;
  if (m.backend === "opfs") {
    try {
      const d = await dir();
      const f = await (await d.getFileHandle(fileName(songId))).getFile();
      return new File([f], m.name, { type: m.type });
    } catch (e) {
      return null;
    }
  }
  const rec = await get("recordings", "blob:" + songId).catch(() => null);
  return rec ? rec.blob : null;
}

export async function deleteRecording(songId) {
  const d = await dir();
  if (d) await d.removeEntry(fileName(songId)).catch(() => {});
  await del("recordings", "blob:" + songId).catch(() => {});
  await del("recordings", songId).catch(() => {});
}

export async function listRecordings() {
  return (await getAll("recordings").catch(() => [])).filter((r) => r.kind === "meta").sort((a, b) => b.savedAt - a.savedAt);
}

/* ---- Stems: { id: "stems:<song>", kind: "stems", stems: [{ name, label, size, type, backend }], detector, from } ---- */

const stemFile = (songId, name) => fileName(songId) + "__" + name.replace(/[^a-z0-9]/gi, "_") + ".m4a";

// stems: [{ name, label, blob }]. Replaces the song's earlier stems.
export async function saveStems(songId, stems, extra = {}) {
  await deleteStems(songId);
  const list = [];
  for (const s of stems) {
    let backend = "opfs";
    if (!(await writeOpfs(stemFile(songId, s.name), s.blob, STEMS_DIR))) {
      backend = "idb";
      await put("recordings", { id: "stem:" + songId + ":" + s.name, blob: s.blob });
    }
    list.push({ name: s.name, label: s.label || s.name, size: s.blob.size, type: s.blob.type || "audio/mp4", backend });
  }
  const meta = { id: "stems:" + songId, kind: "stems", songId, stems: list, savedAt: Date.now(), ...extra };
  await put("recordings", meta);
  requestPersist();
  return meta;
}

export async function stemsMeta(songId) {
  const m = await get("recordings", "stems:" + songId).catch(() => null);
  return m && m.kind === "stems" ? m : null;
}

// The stem files: [{ name, label, blob }], or null when any is missing.
export async function getStems(songId) {
  const m = await stemsMeta(songId);
  if (!m) return null;
  const d = await dir(STEMS_DIR);
  const out = [];
  for (const s of m.stems) {
    let blob = null;
    if (s.backend === "opfs" && d) {
      try { blob = await (await d.getFileHandle(stemFile(songId, s.name))).getFile(); } catch (e) { blob = null; }
    } else {
      const rec = await get("recordings", "stem:" + songId + ":" + s.name).catch(() => null);
      blob = rec ? rec.blob : null;
    }
    if (!blob) return null;
    out.push({ name: s.name, label: s.label, blob });
  }
  return out;
}

export async function deleteStems(songId) {
  const m = await stemsMeta(songId);
  if (!m) return;
  const d = await dir(STEMS_DIR);
  for (const s of m.stems) {
    if (d) await d.removeEntry(stemFile(songId, s.name)).catch(() => {});
    await del("recordings", "stem:" + songId + ":" + s.name).catch(() => {});
  }
  await del("recordings", "stems:" + songId).catch(() => {});
}

export async function listStems() {
  return (await getAll("recordings").catch(() => [])).filter((r) => r.kind === "stems");
}

export const stemsSize = (m) => (m ? m.stems.reduce((s, x) => s + (x.size || 0), 0) : 0);

// { usage, quota, persisted, recordings: total bytes of recordings and stems }.
export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null, recordings: 0 };
  if (navigator.storage && navigator.storage.estimate) {
    try { Object.assign(out, await navigator.storage.estimate()); } catch (e) { /* ignore */ }
  }
  if (navigator.storage && navigator.storage.persisted) {
    try { out.persisted = await navigator.storage.persisted(); } catch (e) { /* ignore */ }
  }
  out.recordings = (await listRecordings()).reduce((s, r) => s + (r.size || 0), 0) + (await listStems()).reduce((s, m) => s + stemsSize(m), 0);
  return out;
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return "?";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  return (n / 1024 ** 3).toFixed(1) + " GB";
}
