// Lyric timing: when each sheet line starts in the recording, so the sheet can
// follow playback at any speed. Timing comes from tap-to-sync, or from a
// synced-lyrics lookup on LRCLIB (lrclib.net; it gets the song's title, artist
// and length). LRCLIB's lines can be matched to your pasted sheet, or, with no
// sheet, turned into one with your detected chords placed by time.
// Lyrics stay on this device, like pasted sheets. Pure functions apart from
// the fetch and storage helpers; node tests them with invented lyrics.

import { get, put, del } from "./library.js";
import { chordName, parseChord } from "./chords.js";

/* ---- Sheet lines ---- */

// The sheet's lyric lines in reading order: [{ s, l, text }] (s, l: section
// and line index, as the sheet renders them in data-s / data-l).
export function lyricLines(doc) {
  const out = [];
  if (!doc) return out;
  doc.sections.forEach((sec, s) => {
    if (sec.ref) return;
    sec.lines.forEach((line, l) => {
      if (line.type !== "lyric") return;
      const text = (line.segs || []).map((g) => g.text || "").join("").trim();
      out.push({ s, l, text });
    });
  });
  return out;
}

/* ---- Storage: lyricTiming { id, lines: [{ index, t }], source, savedAt } ---- */

export const getTiming = (id) => get("lyricTiming", id).catch(() => null);
export async function saveTiming(id, lines, source) {
  const clean = lines.filter((x) => x && isFinite(x.t)).map((x) => ({ index: x.index, t: Math.round(x.t * 100) / 100 }))
    .sort((a, b) => a.index - b.index);
  await put("lyricTiming", { id, lines: clean, source, savedAt: Date.now() });
  return clean;
}
export const deleteTiming = (id) => del("lyricTiming", id);

// Which timed line is playing at song time t: the index into lyricLines, or -1.
export function lineAt(timing, t) {
  let cur = -1, best = -Infinity;
  for (const x of timing || []) if (x.t <= t + 0.05 && x.t > best) { best = x.t; cur = x.index; }
  return cur;
}

/* ---- LRC ---- */

// "[01:02.34] text" (several stamps on one line allowed) -> [{ t, text }], sorted.
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(":", ".")), text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Word-overlap similarity of two lines (0..1).
function similar(a, b) {
  const x = norm(a).split(" ").filter(Boolean), y = norm(b).split(" ").filter(Boolean);
  if (!x.length || !y.length) return 0;
  const bag = new Map();
  for (const w of y) bag.set(w, (bag.get(w) || 0) + 1);
  let hit = 0;
  for (const w of x) if (bag.get(w)) { hit++; bag.set(w, bag.get(w) - 1); }
  return (2 * hit) / (x.length + y.length);
}

// Match timed lines to the sheet's lines, in order (a sheet line can't come
// before an earlier match). Returns timing [{ index, t }] for matched lines.
export function alignToSheet(timed, sheetLines, minScore = 0.5) {
  const lines = timed.filter((x) => x.text);
  const n = sheetLines.length, m = lines.length;
  // Dynamic programming: best total similarity of an in-order matching.
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const sim = (i, j) => { const v = similar(sheetLines[i].text, lines[j].text); return v >= minScore ? v : 0; };
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const s = sim(i, j);
    score[i][j] = Math.max(score[i + 1][j], score[i][j + 1], s ? s + score[i + 1][j + 1] : 0);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    const s = sim(i, j);
    if (s && Math.abs(score[i][j] - (s + score[i + 1][j + 1])) < 1e-9) { out.push({ index: i, t: lines[j].t }); i++; j++; }
    else if (score[i + 1][j] >= score[i][j + 1]) i++;
    else j++;
  }
  return out;
}

// Whether saved times were made for these lines: almost all of them land on
// a line with words (times kept from a sheet since deleted or replaced don't).
export function timingFits(timed, sheetLines) {
  if (!timed || !timed.length) return false;
  const hits = timed.filter((x) => sheetLines[x.index] && sheetLines[x.index].text).length;
  return hits >= Math.max(1, timed.length * 0.8);
}

// The bar a line is sung in (bars: [{ t }], sorted): a line that starts well
// into a bar is a pickup into the next one, so it goes under that one, where
// its downbeat is. -1 before the song.
export function sungBar(bars, t) {
  let bi = -1;
  for (let i = 0; i < bars.length && bars[i].t <= t; i++) bi = i;
  if (bi < 0) return bars.length && t > bars[0].t - 1 ? 0 : -1;
  const next = bars[bi + 1];
  return next && (t - bars[bi].t) / (next.t - bars[bi].t) >= PICKUP ? bi + 1 : bi;
}
const PICKUP = 0.4;   // of a bar

// A ChordPro sheet from timed lines and timed bars: each line gets the chords
// that change during it, placed at the word nearest their time across the
// line. bars: [{ t, t1, chords }] (sounding names). Returns ChordPro text.
export function sheetFromTiming(timed, bars, { title = "", artist = "" } = {}) {
  const lines = timed.filter((x) => x.text);
  const changes = [];
  let prev = null;
  for (const b of bars) {
    const n = b.chords.length;
    b.chords.forEach((c, k) => {
      const t = b.t + ((b.t1 ?? b.t + 2) - b.t) * k / n;
      if (c !== prev) changes.push({ t, chord: c });
      prev = c;
    });
  }
  const out = [];
  if (title) out.push(`{title: ${title}}`);
  if (artist) out.push(`{artist: ${artist}}`);
  // Chords before the first line: an intro line of chords only.
  const firstT = lines.length ? lines[0].t : Infinity;
  const intro = changes.filter((c) => c.t < firstT - 0.3);
  if (intro.length) out.push(intro.map((c) => `[${c.chord}]`).join(" "));
  let ci = intro.length;
  // A line ends where the next timed line starts (an empty one marks a gap).
  const all = timed.slice().sort((a, b) => a.t - b.t);
  lines.forEach((line) => {
    const after = all.find((x) => x.t > line.t + 0.01);
    const end = after ? after.t : line.t + 6;
    const here = [];
    // The chord playing as the line starts, if it began earlier.
    const before = [...changes].reverse().find((c) => c.t <= line.t + 0.05);
    while (ci < changes.length && changes[ci].t < end - 0.05) { if (changes[ci].t > line.t + 0.05) here.push(changes[ci]); ci++; }
    const text = line.text;
    // Word starts, by character position.
    const starts = [0];
    for (let k = 1; k < text.length; k++) if (text[k - 1] === " " && text[k] !== " ") starts.push(k);
    const at = new Map();
    if (before && (!here.length || here[0].t - line.t > 0.3)) at.set(0, before.chord);
    for (const c of here) {
      const pos = Math.round((c.t - line.t) / Math.max(0.5, end - line.t) * text.length);
      let best = starts[0];
      for (const s of starts) if (Math.abs(s - pos) < Math.abs(best - pos)) best = s;
      while (at.has(best) && best < text.length) best = starts.find((s) => s > best) ?? text.length;
      at.set(best, c.chord);
    }
    let s = "";
    for (let k = 0; k <= text.length; k++) {
      if (at.has(k)) s += `[${at.get(k)}]`;
      if (k < text.length) s += text[k];
    }
    out.push(s);
  });
  return out.join("\n");
}

/* ---- LRCLIB ---- */

export const LRCLIB = "https://lrclib.net/api";

// -> { synced: [{ t, text }], plain, duration, source } or null when nothing's found.
// id: that LRCLIB record (the one a song's shipped lyric times were made from).
export async function findSyncedLyrics({ title, artist, duration, id = null }) {
  const q = new URLSearchParams({ track_name: title, artist_name: artist || "" });
  if (duration) q.set("duration", String(Math.round(duration)));
  let rec = null;
  try {
    const r = await fetch(id ? `${LRCLIB}/get/${encodeURIComponent(id)}` : `${LRCLIB}/get?${q}`);
    if (r.ok) rec = await r.json();
  } catch (e) {
    throw new Error("Couldn't reach LRCLIB. Are you online?");
  }
  if (!rec || !rec.syncedLyrics) {
    const s = new URLSearchParams({ track_name: title, artist_name: artist || "" });
    const r = await fetch(`${LRCLIB}/search?${s}`).catch(() => null);
    const list = r && r.ok ? await r.json() : [];
    const synced = (list || []).filter((x) => x.syncedLyrics);
    synced.sort((a, b) => Math.abs((a.duration || 0) - (duration || 0)) - Math.abs((b.duration || 0) - (duration || 0)));
    rec = synced[0] || null;
  }
  if (!rec || !rec.syncedLyrics) return null;
  return { id: rec.id || null, synced: parseLrc(rec.syncedLyrics), plain: rec.plainLyrics || "", duration: rec.duration || null,
    source: { label: `LRCLIB: ${rec.trackName || title} · ${rec.artistName || artist}`, url: "https://lrclib.net/" } };
}

// LRCLIB's lines retimed to your recording: `aligned` is [{ j, t }], j
// counting LRCLIB's lines with words (no text: the times alone ship with a
// song). A line it doesn't time (often one this take doesn't sing) sits
// between the timed lines around it, spaced as LRCLIB spaced them; before the
// first or after the last, it keeps LRCLIB's spacing from there.
export function retime(synced, aligned) {
  const at = new Map((aligned || []).map((x) => [x.j, x.t]));
  if (!at.size) return synced;
  let j = 0;
  const rows = synced.map((x) => ({ ...x, j: x.text ? j++ : null }));
  const known = rows.map((x, k) => (x.j !== null && at.has(x.j) ? k : -1)).filter((k) => k >= 0);
  const out = rows.map((x, k) => {
    if (x.j !== null && at.has(x.j)) return { t: at.get(x.j), text: x.text };
    const prev = [...known].reverse().find((q) => q < k), next = known.find((q) => q > k);
    const tp = prev !== undefined ? at.get(rows[prev].j) : null, tn = next !== undefined ? at.get(rows[next].j) : null;
    let t;
    if (tp !== null && tn !== null) {
      const a = rows[prev].t, b = rows[next].t;
      t = b > a ? tp + (tn - tp) * (x.t - a) / (b - a) : tp;
    } else if (tp !== null) t = tp + (x.t - rows[prev].t);
    else t = tn - (rows[next].t - x.t);
    return { t: Math.max(0, t), text: x.text };
  });
  for (let k = 1; k < out.length; k++) if (out[k].t < out[k - 1].t) out[k] = { ...out[k], t: out[k - 1].t };
  return out;
}

// For tests: a chord name check, so sheets only ever contain chords we parse.
export const isChord = (name) => { const c = parseChord(name); return !!c && !c.nc && chordName(c) !== ""; };
