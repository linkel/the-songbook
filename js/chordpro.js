// Sheets: the owner's pasted chords-over-lyrics or ChordPro text, stored on the
// device as ChordPro. importText() turns either kind of paste into ChordPro;
// parseChordPro() turns ChordPro into a document the sheet view renders.
// No DOM, so node can test it (with made-up lyrics only).

import { parseChord } from "./chords.js";

/* ---- Recognising lines ---- */

const SECTION_WORDS = "intro|verse|pre-?chorus|chorus|bridge|outro|solo|interlude|instrumental|refrain|coda|hook|break|tag|ending|riff|middle 8|post-?chorus";
const HEADING_RE = new RegExp(`^\\s*(?:\\[\\s*)?((?:${SECTION_WORDS})(?:\\s*\\d+)?(?:\\s*[:(\\-].*?)?)(?:\\s*\\])?\\s*:?\\s*$`, "i");
const BRACKET_HEADING_RE = /^\s*\[([^\]]+)\]\s*$/;
const TAB_RE = /^\s*[eBGDAEbgda]?\s*\|[-0-9hpbr/\\x~|.\s()]{6,}$/;

// A token that can sit on a chord line without being lyrics.
function chordish(tok) {
  const t = tok.replace(/^\((.*)\)$/, "$1");
  if (parseChord(t)) return "chord";
  if (/^[|/%:.\-*]+$/.test(tok) || /^\(?[x×]\d+\)?$/i.test(tok) || /^\d+x$/i.test(tok) || /^N\.?C\.?$/i.test(tok)) return "mark";
  return null;
}

export function isChordLine(line) {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  let chords = 0;
  for (const t of toks) {
    const k = chordish(t);
    if (!k) return false;
    if (k === "chord") chords++;
  }
  return chords > 0;
}

// "[Verse 1]", "Chorus:", "Pre-Chorus" -> the heading text, else null.
export function headingOf(line) {
  const b = line.match(BRACKET_HEADING_RE);
  if (b && !parseChord(b[1].trim())) return b[1].trim();
  const m = line.match(HEADING_RE);
  return m ? m[1].replace(/\s*:$/, "").trim() : null;
}

/* ---- Paste import ---- */

export function looksLikeChordPro(text) {
  if (/^\s*\{[a-z_]+(:[^}]*)?\}\s*$/im.test(text)) return true;
  // Inline chords inside lyric text: "some [Am]words".
  let inline = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/\S\s*\[[A-G][^\]\s]{0,8}\]|\[[A-G][^\]\s]{0,8}\]\s*\w/.test(line) && !isChordLine(line.replace(/[[\]]/g, " "))) inline++;
  }
  return inline >= 2;
}

function expandTabs(s) {
  let out = "";
  for (const ch of s) out += ch === "\t" ? " ".repeat(4 - (out.length % 4)) : ch;
  return out;
}

// Chord tokens of a chord line with their columns.
function chordColumns(line) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    const kind = chordish(m[0]);
    out.push({ col: m.index, tok: kind === "chord" ? m[0].replace(/^\((.*)\)$/, "$1") : m[0], kind });
  }
  return out;
}

// Put [chords] into a lyric line at their columns.
export function mergeChordLine(chordLine, lyric) {
  let text = lyric.replace(/\s+$/, "");
  const cols = chordColumns(chordLine).filter((c) => c.kind === "chord").sort((a, b) => b.col - a.col);
  let tail = "";
  // Chords past the end of the lyric go after it, one space apart.
  const past = cols.filter((c) => c.col >= text.length).reverse();
  if (past.length) tail = (text ? " " : "") + past.map((c) => "[" + c.tok + "]").join(" ");
  for (const c of cols) {
    if (c.col >= text.length) continue;
    // A chord over the space just before a word belongs to that word.
    const at = text[c.col] === " " && /\S/.test(text[c.col + 1] || "") ? c.col + 1 : c.col;
    text = text.slice(0, at) + "[" + c.tok + "]" + text.slice(at);
  }
  return text + tail;
}

function chordOnlyLine(line) {
  return chordColumns(line).map((c) => (c.kind === "chord" ? "[" + c.tok + "]" : c.tok)).join(" ");
}

const META = [
  [/^\s*capo\b[^0-9\n]{0,16}(\d{1,2})/i, "capo"],
  [/^\s*key\s*(?:of)?\s*[:=-]?\s*([A-G][#b♯♭]?m?)\s*$/i, "key"],
  [/^\s*(?:tempo|bpm)\s*[:=-]?\s*(\d{2,3})/i, "tempo"],
  [/^\s*time(?:\s*signature)?\s*[:=-]?\s*(\d{1,2}\/\d{1,2})/i, "time"],
];

const KINDS = ["verse", "chorus", "bridge", "intro", "outro", "solo", "interlude", "instrumental", "refrain", "coda",
  "hook", "break", "tag", "ending", "riff", "prechorus", "postchorus", "middle"];

// "Pre-Chorus 2" -> "prechorus": the ChordPro section environment for a heading.
function sectionDirective(label) {
  const k = label.toLowerCase().replace(/[^a-z]/g, "");
  return KINDS.find((x) => k.startsWith(x)) || "part";
}

// Chords over lyrics (Ultimate Guitar style) -> ChordPro.
export function chordsOverLyricsToChordPro(text, meta = {}) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
  const out = [];
  const head = { ...meta };
  let open = null;   // the section environment that's open
  let inTab = false;
  const closeSection = () => { if (open) { out.push(`{end_of_${open}}`); open = null; } };
  const openSection = (label) => {
    closeSection();
    open = sectionDirective(label);
    out.push(`{start_of_${open}: ${label}}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (TAB_RE.test(line)) {
      if (!inTab) { out.push("{start_of_tab}"); inTab = true; }
      out.push(line);
      continue;
    }
    if (inTab) { out.push("{end_of_tab}"); inTab = false; }
    if (!line.trim()) { out.push(""); continue; }

    const metaHit = META.find(([re]) => re.test(line));
    if (metaHit && !isChordLine(line)) {
      const v = line.match(metaHit[0])[1];
      if (!(metaHit[1] in head)) head[metaHit[1]] = v;
      continue;
    }

    // "Intro: Am C G" -> a heading and a chord line.
    const labelled = line.match(/^\s*\[?([A-Za-z][A-Za-z -]*?\d*)\]?\s*:\s*(\S.*)$/);
    if (labelled && headingOf(labelled[1]) && isChordLine(labelled[2])) {
      openSection(headingOf(labelled[1]));
      out.push(chordOnlyLine(labelled[2]));
      continue;
    }

    const heading = !isChordLine(line) ? headingOf(line) : null;
    if (heading) { openSection(heading); continue; }

    if (isChordLine(line)) {
      const next = lines[i + 1] !== undefined ? expandTabs(lines[i + 1]).replace(/\s+$/, "") : "";
      const nextIsLyric = next.trim() && !isChordLine(next) && !headingOf(next) && !TAB_RE.test(next) && !META.some(([re]) => re.test(next));
      if (nextIsLyric) {
        out.push(mergeChordLine(line, next));
        i++;
      } else {
        out.push(chordOnlyLine(line));
      }
      continue;
    }
    out.push(line);
  }
  if (inTab) out.push("{end_of_tab}");
  closeSection();

  // Trim blank runs.
  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  const directives = [];
  for (const k of ["title", "artist", "key", "capo", "tempo", "time"]) if (head[k] !== undefined && head[k] !== null && head[k] !== "") directives.push(`{${k}: ${head[k]}}`);
  return (directives.length ? directives.join("\n") + "\n\n" : "") + body + "\n";
}

// Either kind of paste -> ChordPro. meta (title, artist...) fills in what the
// paste doesn't say.
export function importText(text, meta = {}) {
  if (looksLikeChordPro(text)) {
    let cp = text.replace(/\r\n?/g, "\n").trim() + "\n";
    const has = (k) => new RegExp(`^\\{\\s*${k}\\s*:`, "im").test(cp);
    const add = [];
    if (meta.title && !has("title|t")) add.push(`{title: ${meta.title}}`);
    if (meta.artist && !has("artist|subtitle|st")) add.push(`{artist: ${meta.artist}}`);
    return (add.length ? add.join("\n") + "\n" : "") + cp;
  }
  return chordsOverLyricsToChordPro(text, meta);
}

/* ---- ChordPro -> document ----
   { meta: { title, artist, key, capo, tempo, time },
     sections: [{ name, kind, lines: [line] }] }
   line: { type: "lyric", segs: [{ chord, text }] } | { type: "tab", text }
         | { type: "comment", text } | { type: "blank" } */

const SHORT = { soc: "start_of_chorus", eoc: "end_of_chorus", sov: "start_of_verse", eov: "end_of_verse",
  sob: "start_of_bridge", eob: "end_of_bridge", sot: "start_of_tab", eot: "end_of_tab", t: "title", st: "subtitle",
  c: "comment", ci: "comment_italic", cb: "comment_box" };

function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export function parseLyricLine(line) {
  const segs = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0, chord = null, m;
  while ((m = re.exec(line))) {
    const before = line.slice(last, m.index);
    if (before || chord !== null) segs.push({ chord, text: before });
    chord = m[1].trim();
    last = re.lastIndex;
  }
  const rest = line.slice(last);
  if (rest || chord !== null) segs.push({ chord, text: rest });
  return segs;
}

export function parseChordPro(text) {
  const meta = { title: null, artist: null, key: null, capo: 0, tempo: null, time: null };
  const sections = [];
  let sec = null;
  let tab = false;
  const startSection = (name, kind) => { sec = { name, kind, lines: [] }; sections.push(sec); };
  const ensure = () => { if (!sec) startSection(null, null); return sec; };

  for (const raw of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const d = line.match(/^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i);
    if (d) {
      let key = d[1].toLowerCase();
      key = SHORT[key] || key;
      const val = (d[2] || "").trim();
      if (key === "title") meta.title = val;
      else if (key === "subtitle" || key === "artist") meta.artist = meta.artist || val;
      else if (key === "key") meta.key = val || null;
      else if (key === "capo") meta.capo = parseInt(val, 10) || 0;
      else if (key === "tempo") meta.tempo = parseInt(val, 10) || null;
      else if (key === "time") meta.time = val || null;
      else if (key === "chorus") { startSection(val || "Chorus", "chorus"); sec.ref = true; sec = null; }
      else if (key.startsWith("start_of_")) {
        const kind = key.slice(9);
        if (kind === "tab") { tab = true; ensure(); continue; }
        startSection(val || titleCase(kind.replace(/_/g, " ")), kind);
      } else if (key.startsWith("end_of_")) {
        if (key === "end_of_tab") tab = false;
        else sec = null;
      } else if (key.startsWith("comment")) {
        ensure().lines.push({ type: "comment", text: val });
      }
      continue;
    }
    if (tab) { ensure().lines.push({ type: "tab", text: line }); continue; }
    if (!line.trim()) { if (sec && sec.lines.length) sec.lines.push({ type: "blank" }); continue; }
    // A bracketed heading that isn't a chord: "[Verse 2]".
    const h = line.match(BRACKET_HEADING_RE);
    if (h && !parseChord(h[1].trim())) { startSection(h[1].trim(), sectionDirective(h[1])); continue; }
    ensure().lines.push({ type: "lyric", segs: parseLyricLine(line) });
  }
  for (const s of sections) while (s.lines.length && s.lines[s.lines.length - 1].type === "blank") s.lines.pop();
  return { meta, sections: sections.filter((s) => s.lines.length || s.ref || s.name) };
}

// Every chord in reading order: [{ name, section, line, seg }].
export function docChords(doc) {
  const out = [];
  doc.sections.forEach((s, si) => s.lines.forEach((l, li) => {
    if (l.type !== "lyric") return;
    l.segs.forEach((g, gi) => { if (g.chord && parseChord(g.chord) && !parseChord(g.chord).nc) out.push({ name: g.chord, section: si, line: li, seg: gi }); });
  }));
  return out;
}

// A chart from a sheet, for the Chords view: each section's chords as bars,
// one chord per bar (a sheet doesn't say how long chords last).
export function sheetChart(doc, record = {}) {
  const sections = [];
  const seen = new Map();
  doc.sections.forEach((s, si) => {
    const names = [];
    for (const l of s.lines) if (l.type === "lyric") for (const g of l.segs) {
      const c = g.chord && parseChord(g.chord);
      if (c && !c.nc) names.push(g.chord);
    }
    if (!names.length) return;
    let name = s.name || (si === 0 ? "Start" : "Part " + (si + 1));
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name += " (" + n + ")";
    sections.push({ name, chords: names.join(" | ") });
  });
  return {
    title: doc.meta.title, artist: doc.meta.artist,
    key: doc.meta.key, capo: doc.meta.capo || 0, tempo: doc.meta.tempo, time: doc.meta.time,
    style: null, strum: null, voicings: {},
    sections, form: sections.map((s) => s.name),
    source: record.source || "mine", sources: record.sources || [], confidence: null, detector: null,
    notes: "From your sheet, one chord per bar: a sheet doesn't say how long each chord lasts.",
    fromSheet: true,
  };
}
