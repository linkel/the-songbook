// Ships a song analysed on the PC with the app, so it's ready on any device
// without importing anything: the PC helper's bundle (private/songs/<slug>/)
// becomes songs/<id>.json (the chart, with each section's guitar part),
// songs/stems/<id>/*.m4a (the stems), and songs/audio/ (your recording, when
// it's in private/). The library finds it by title and artist.
//   node tools/ship-bundle.mjs private/songs/<slug> [--audio <file>] [--id <id>]
//   node tools/ship-bundle.mjs --all        every bundle in private/songs/
// songs/index.json is rebuilt and sw.js precaches the chart. Then
// run the tests (cd tests && npm run quick) and commit songs/ and sw.js.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { shippableChart } from "../js/chartfile.js";
import { checkPart } from "../js/part.js";
import { songKey } from "../js/library.js";
import { buildIndex } from "./build-song-index.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const songsDir = path.join(root, "songs");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dirs = args.includes("--all")
  ? fs.readdirSync(path.join(root, "private", "songs")).map((d) => path.join(root, "private", "songs", d)).filter((d) => fs.existsSync(path.join(d, "bundle.json")))
  : args.filter((a, i) => !a.startsWith("--") && !["--audio", "--id"].includes(args[i - 1]));
if (!dirs.length) {
  console.log("Usage: node tools/ship-bundle.mjs private/songs/<slug> [--audio <file>] [--id <id>] | --all");
  process.exit(1);
}

const slug = (s) => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const shipped = fs.readdirSync(songsDir).filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => readJson(path.join(songsDir, f)));

const added = [];
for (const dir of dirs) {
  const m = readJson(path.join(dir, "bundle.json"));
  if (m.app !== "songbook" || m.kind !== "bundle" || m.partsOnly) { console.warn(`skipped ${dir}: not a full analysis bundle`); continue; }
  const raw = readJson(path.join(dir, "chart.json"));
  // The song's id: a chart already shipped for it, else one from its title.
  const old = shipped.find((c) => songKey(c.title, c.artist) === songKey(m.title, m.artist)) || null;
  const id = (dirs.length === 1 && opt("--id")) || (old && old.id) || slug(m.title || raw.title);
  const chart = shippableChart({ ...raw, id, title: m.title || raw.title, artist: m.artist || raw.artist });
  if (!chart) { console.warn(`skipped ${dir}: no chords in the chart`); continue; }
  // A cited chart isn't replaced by a detected one (a tab lined up by helper/import_gp.py is cited too).
  if (old && old.source === "web" && chart.source !== "web") { console.warn(`kept songs/${id}.json: it's a cited chart`); continue; }
  // What the shipped chart already knew (tuning, links, picking, its recording) stays.
  for (const k of ["tuning", "links", "picking", "type", "style", "audio"]) if (old && old[k] && !chart[k]) chart[k] = old[k];
  if (old && old.notes && chart.source === "detected" && !chart.notes.includes(old.notes)) chart.notes = old.notes;

  // Each section's guitar part (detected: a draft).
  const pf = path.join(dir, "part.json");
  if (fs.existsSync(pf)) {
    const doc = readJson(pf);
    for (const s of chart.sections) {
      const part = doc.sections && doc.sections[s.name];
      if (!part || checkPart(part).length) continue;
      const { source, detector, from, url, fingers, patterns, bars } = part;
      s.part = { source, ...(source === "web" ? { from, ...(url ? { url } : {}) } : { detector }), fingers, ...(patterns && Object.keys(patterns).length ? { patterns } : {}), bars };
    }
  }

  // The stems, next to the chart.
  const stemDir = path.join(songsDir, "stems", id);
  fs.mkdirSync(stemDir, { recursive: true });
  chart.stems = { detector: m.detector, from: (m.source && m.source.name) || null, files: [] };
  for (const s of m.stems || []) {
    fs.copyFileSync(path.join(dir, s.file), path.join(stemDir, s.name + ".m4a"));
    chart.stems.files.push({ name: s.name, label: s.label, file: `songs/stems/${id}/${s.name}.m4a` });
  }

  // Your recording, when it's in private/ (or named with --audio).
  const audioSrc = (dirs.length === 1 && opt("--audio")) || (m.source && m.source.name && path.join(root, "private", m.source.name)) || null;
  if (!chart.audio && audioSrc && fs.existsSync(audioSrc)) {
    const name = path.basename(audioSrc);
    fs.mkdirSync(path.join(songsDir, "audio"), { recursive: true });
    fs.copyFileSync(audioSrc, path.join(songsDir, "audio", name));
    chart.audio = { file: `songs/audio/${name}`, label: "Your recording. The chords' bar times fit it." };
  }

  fs.writeFileSync(path.join(songsDir, id + ".json"), JSON.stringify(chart, null, 2) + "\n");
  added.push(id);
  const parts = chart.sections.filter((s) => s.part).length;
  console.log(`wrote songs/${id}.json  ${chart.title} · ${chart.artist}: ${chart.bars.length} bars, ${chart.stems.files.length} stems, parts for ${parts} section${parts === 1 ? "" : "s"}${chart.audio ? ", " + chart.audio.file : ""}`);
}
if (!added.length) process.exit(0);

fs.writeFileSync(path.join(songsDir, "index.json"), JSON.stringify(buildIndex(), null, 1) + "\n");
console.log("rebuilt songs/index.json");
const swPath = path.join(root, "sw.js");
let sw = fs.readFileSync(swPath, "utf8");
for (const id of added) {
  const entry = `  "songs/${id}.json",`;
  if (!sw.includes(entry)) sw = sw.replace(/( {2}"songs\/index\.json",)(\r?\n)/, (_, line, nl) => `${line}${nl}${entry}${nl}`);
}
fs.writeFileSync(swPath, sw);
console.log("updated sw.js");
