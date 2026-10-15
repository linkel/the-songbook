// Validates the shipped charts in songs/: every chord parses and has a shape
// (in the chart's tuning), pattern ids exist, every chart says where it came
// from (web charts cite sources), nothing in them looks like lyrics, and a
// shipped guitar part is valid, and the stems and recordings a chart names are
// there. node data.test.mjs
import fs from "fs";
import { check, eq, report } from "./lib.mjs";
import * as C from "../js/chords.js";
import { PATTERN_BY_ID } from "../js/patterns.js";
import { tuningFrom, parseTuning } from "../js/tuning.js";
import { checkPart } from "../js/part.js";
import { buildIndex } from "../tools/build-song-index.mjs";

C.setChordDb(JSON.parse(fs.readFileSync(new URL("../vendor/chords-db/guitar.json", import.meta.url), "utf8")));

const dir = new URL("../songs/", import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");

const CHART_KEYS = new Set(["id", "type", "title", "artist", "spotify", "key", "capo", "time", "tempo", "style", "strum",
  "voicings", "sections", "form", "source", "detector", "confidence", "sources", "notes", "picking", "beats",
  "tuning", "links", "bars", "analysis", "checkedFrom", "audio", "stems"]);
const SECTION_KEYS = new Set(["name", "chords", "repeat", "picking", "strength", "part"]);
const PICKING_KEYS = new Set(["patterns", "also", "match", "source", "confidence", "part", "sources", "description", "from", "pattern"]);
const SOURCES = new Set(["detected", "web", "mine", "verified"]);
const PICK_SOURCES = new Set(["mine", "web", "suggested"]);
// Free text lives only in these fields, and stays short.
const TEXT_FIELDS = new Set(["notes", "description", "label", "title", "artist", "name", "from", "about", "detector", "checkedFrom"]);
const LYRIC_KEYS = /^(lyrics?|words|text|sheet|lines?|chordpro|verse_text)$/i;

function walk(obj, path, fn) {
  if (Array.isArray(obj)) obj.forEach((v, i) => walk(v, path + "[" + i + "]", fn));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) { fn(k, v, path + "." + k); walk(v, path + "." + k, fn); }
}

function checkSources(where, list) {
  check(`${where}: sources cited`, Array.isArray(list) && list.length > 0);
  for (const s of list || []) check(`${where}: source has a label and an https link`, s.label && /^https:\/\/\S+$/.test(s.url), JSON.stringify(s));
}

check("there are shipped charts", files.length >= 13, String(files.length));

for (const f of files) {
  const c = JSON.parse(fs.readFileSync(new URL(f, dir), "utf8"));
  const w = c.id || f;
  check(`${w}: id matches the file name`, c.id + ".json" === f);
  check(`${w}: id is a slug`, /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id));
  check(`${w}: title and artist`, c.title && c.artist);
  const extra = Object.keys(c).filter((k) => !CHART_KEYS.has(k));
  check(`${w}: only known fields`, !extra.length, extra.join(", "));

  // No lyrics: no lyric-like fields, and free text only in short notes.
  walk(c, w, (k, v, p) => {
    if (LYRIC_KEYS.test(k)) check(`${p}: no lyric-like fields`, false);
    if (typeof v === "string" && v.length > 40 && !TEXT_FIELDS.has(k) && !["chords", "url", "file", "steps"].includes(k)) check(`${p}: long text only in notes`, false, v.slice(0, 40));
    if (typeof v === "string" && TEXT_FIELDS.has(k)) check(`${p}: text is short`, v.length <= 600, String(v.length));
  });

  const sections = c.sections || [];
  const hasChords = sections.some((s) => s.chords && s.chords.trim());
  if (hasChords) {
    check(`${w}: chords are labelled detected, web, mine or verified`, SOURCES.has(c.source), String(c.source));
    if (c.source === "web") checkSources(w, c.sources);
    if (c.source === "detected") check(`${w}: detector named`, !!c.detector);
    check(`${w}: confidence given`, !!c.confidence);
  } else {
    check(`${w}: no chords means no chord source`, c.source === null);
  }
  check(`${w}: capo 0-12`, Number.isInteger(c.capo) && c.capo >= 0 && c.capo <= 12);
  if (c.time !== null && c.time !== undefined) check(`${w}: time signature`, /^\d{1,2}\/(2|4|8)$/.test(c.time), c.time);
  if (c.key) check(`${w}: key parses`, C.parseChord(c.key.replace(/m$/, "")) !== null, c.key);

  const tun = tuningFrom(c.tuning || null);
  for (const [name, spec] of Object.entries(c.voicings || {})) {
    const frets = C.specFrets(spec);
    check(`${w}: voicing ${name} ${spec} is six strings`, !!frets);
    if (frets) {
      const pcs = C.chordPcs(name);
      check(`${w}: voicing ${name} ${spec} plays chord tones (in its tuning)`, C.voicingMidi(frets, 0, tun).every((m) => pcs.includes(m % 12)));
    }
  }

  for (const s of sections) {
    const extraS = Object.keys(s).filter((k) => !SECTION_KEYS.has(k));
    check(`${w}/${s.name}: only known section fields`, !extraS.length, extraS.join(", "));
    const bars = C.splitBars(s.chords);
    check(`${w}/${s.name}: has bars`, bars.length > 0);
    check(`${w}/${s.name}: bar syntax`, !/\|\s*\|/.test(s.chords) && bars.every((b) => b.length <= 4));
    for (const name of bars.flat()) {
      check(`${w}/${s.name}: "${name}" parses`, C.parseChord(name) !== null);
      // N.C. (no chord: a break) has no shape.
      if (!(C.parseChord(name) || {}).nc) check(`${w}/${s.name}: "${name}" has a shape`, !!C.bestVoicing(name, c.voicings, tun));
    }
    if (s.repeat !== undefined) check(`${w}/${s.name}: repeat`, Number.isInteger(s.repeat) && s.repeat >= 1);
    if (s.part) {
      const errs = checkPart(s.part);
      check(`${w}/${s.name}: part is valid`, !errs.length, errs.join("; "));
      check(`${w}/${s.name}: part bars line up with the chord bars`, (s.part.bars || []).length <= bars.length);
    }
  }
  for (const name of c.form || []) check(`${w}: form section "${name}" exists`, sections.some((s) => s.name === name));

  if (c.tuning) {
    check(`${w}: tuning has six notes`, (() => { try { return parseTuning(c.tuning.notes).length === 6; } catch (e) { return false; } })(), c.tuning.notes);
    check(`${w}: tuning says where it's from`, ["mine", "web", "verified"].includes(c.tuning.source), String(c.tuning.source));
  }
  // A shipped recording and stems are in the repo.
  if (c.audio) check(`${w}: its recording is in the repo`, fs.existsSync(new URL("../" + c.audio.file, import.meta.url)), c.audio.file);
  for (const f of (c.stems && c.stems.files) || []) check(`${w}: stem ${f.name} is in the repo`, fs.existsSync(new URL("../" + f.file, import.meta.url)), f.file);
  for (const l of c.links || []) check(`${w}: link has a label and an https url`, l.label && /^https:\/\/\S+$/.test(l.url) && l.kind, JSON.stringify(l));
  const pickings = [c.picking, ...sections.map((s) => s.picking)].filter(Boolean);
  for (const p of pickings) {
    const extraP = Object.keys(p).filter((k) => !PICKING_KEYS.has(k));
    check(`${w}: only known picking fields`, !extraP.length, extraP.join(", "));
    const ids = [...(p.patterns || []), ...(p.also || []), ...(p.pattern ? [p.pattern] : [])];
    for (const id of ids) check(`${w}: pattern "${id}" exists`, PATTERN_BY_ID.has(id));
    check(`${w}: picking is sourced, yours or a suggestion`, PICK_SOURCES.has(p.source), String(p.source));
    check(`${w}: picking match`, ["exact", "partial", "family"].includes(p.match), String(p.match));
    if (p.source === "web") checkSources(w + " picking", p.sources);
  }
}

eq("songs/index.json is up to date (node tools/build-song-index.mjs)",
  JSON.parse(fs.readFileSync(new URL("index.json", dir), "utf8")), buildIndex());

// The service worker precaches every app file and shipped chart.
const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const assets = new Set([...sw.matchAll(/^\s+"([^"]+)",$/gm)].map((m) => m[1]));
const need = [
  "index.html", "style.css", "manifest.json", "icon-180.png", "icon-512.png", "vendor/chords-db/guitar.json", "songs/index.json",
  ...fs.readdirSync(new URL("../js/", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => "js/" + f),
  ...files.map((f) => "songs/" + f),
];
const missing = need.filter((f) => !assets.has(f));
check("sw.js precaches every app file and chart", missing.length === 0, missing.join(", "));
for (const f of assets) if (f !== ".") check(`sw.js asset exists: ${f}`, fs.existsSync(new URL("../" + f, import.meta.url)));

// The vendored libraries carry their licences.
check("chords-db licence vendored", fs.existsSync(new URL("../vendor/chords-db/LICENSE", import.meta.url)));

report("data");
