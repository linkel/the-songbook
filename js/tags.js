// Title and artist from an audio file's own tags: ID3v2 (mp3), MP4 ilst
// atoms (m4a/AAC, from iTunes or Apple Music downloads) and FLAC Vorbis
// comments, else from the file name ("Artist - Title.mp3"). Pure byte
// parsing, so node can test it.

const dec = (bytes, enc) => {
  try { return new TextDecoder(enc).decode(bytes); } catch (e) { return ""; }
};
const clean = (s) => String(s || "").replace(/\0+$/g, "").replace(/\0/g, " ").trim();

function syncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }
function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

export function id3(b) {
  if (b.length < 10 || str4(b, 0).slice(0, 3) !== "ID3") return null;
  const ver = b[3];
  const size = syncsafe(b, 6);
  const end = Math.min(b.length, 10 + size);
  let o = 10;
  if (b[5] & 0x40) o += ver === 4 ? syncsafe(b, o) : u32(b, o) + 4;   // extended header
  const out = {};
  const want = { TIT2: "title", TPE1: "artist", TALB: "album", TT2: "title", TP1: "artist", TAL: "album" };
  while (o + 10 <= end) {
    const v2 = ver === 2;
    const id = v2 ? String.fromCharCode(b[o], b[o + 1], b[o + 2]) : str4(b, o);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const fsize = v2 ? (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5] : ver === 4 ? syncsafe(b, o + 4) : u32(b, o + 4);
    const head = v2 ? 6 : 10;
    const data = b.subarray(o + head, o + head + fsize);
    if (want[id] && data.length > 1) {
      const enc = data[0];
      const body = data.subarray(1);
      out[want[id]] = clean(enc === 0 ? dec(body, "latin1") : enc === 1 ? dec(body, body[0] === 0xfe ? "utf-16be" : "utf-16le").replace(/^﻿/, "") : enc === 2 ? dec(body, "utf-16be") : dec(body, "utf-8"));
    }
    o += head + fsize;
  }
  return out.title || out.artist ? out : null;
}

export function mp4(b) {
  if (b.length < 12 || str4(b, 4) !== "ftyp") return null;
  const out = {};
  const want = { "©nam": "title", "©ART": "artist", "aART": "albumArtist", "©alb": "album" };
  const walk = (start, end, depth) => {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (size === 1) size = Number(BigInt(u32(b, o + 8)) * 4294967296n + BigInt(u32(b, o + 12)));
      if (size === 0) size = end - o;
      if (size < 8 || o + size > end) break;
      if (["moov", "udta", "ilst"].includes(type)) walk(o + 8, o + size, depth + 1);
      else if (type === "meta") walk(o + 12, o + size, depth + 1);
      else if (want[type]) {
        // A "data" atom inside: size, "data", 4 bytes type, 4 bytes locale, text.
        if (str4(b, o + 12) === "data") out[want[type]] = clean(dec(b.subarray(o + 24, o + size), "utf-8"));
      }
      o += size;
    }
  };
  walk(0, b.length, 0);
  if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
  return out.title || out.artist ? out : null;
}

export function flac(b) {
  if (b.length < 8 || str4(b, 0) !== "fLaC") return null;
  let o = 4;
  while (o + 4 <= b.length) {
    const last = b[o] & 0x80, type = b[o] & 0x7f;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    if (type === 4) {
      const le = (p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
      let p = o + 4;
      p += 4 + le(p);
      const n = le(p);
      p += 4;
      const out = {};
      for (let i = 0; i < n && p < o + 4 + len; i++) {
        const l = le(p);
        const kv = dec(b.subarray(p + 4, p + 4 + l), "utf-8");
        const eq = kv.indexOf("=");
        const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1);
        if (k === "TITLE") out.title = clean(v);
        if (k === "ARTIST" && !out.artist) out.artist = clean(v);
        if (k === "ALBUM") out.album = clean(v);
        p += 4 + l;
      }
      return out.title || out.artist ? out : null;
    }
    if (last) break;
    o += 4 + len;
  }
  return null;
}

// "Fleetwood Mac - Landslide.mp3", "03 Landslide.m4a" -> { title, artist }.
export function fromFileName(name) {
  const base = String(name || "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/_/g, " ").trim();
  const m = base.match(/^(?:\d{1,3}[ .-]+)?(.+?)\s+[-–]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].replace(/^\d{1,3}[ .-]+/, "").trim() };
  return { title: base.replace(/^\d{1,3}[ .-]+/, "").trim(), artist: "" };
}

// File -> { title, artist, album, from: "tags" | "file name" }.
export async function readTags(file) {
  // ID3 and FLAC tags sit at the start; an MP4's moov box can be at the end.
  const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  let t = id3(head) || flac(head);
  if (!t && str4(head, 4) === "ftyp") t = mp4(new Uint8Array(await file.arrayBuffer()));
  if (t && t.title) return { ...t, from: "tags" };
  return { ...fromFileName(file.name), from: "file name" };
}
