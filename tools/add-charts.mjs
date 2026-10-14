// Adds your charts to the repo, so the deployed app (your phone) has them.
// In the app: Settings → Export your charts (a songbook-charts-….json file).
// Then, from the repo root:
//   node tools/add-charts.mjs <export.json> [id ...]
// Each chart becomes songs/<id>.json (chords and timing only; see
// js/chartfile.js), songs/index.json is rebuilt, and sw.js gets the new files
// and a new CACHE version. Name ids to add only those; list them with --list.
// A cited (web) chart already in songs/ is never replaced; for a shipped song
// without chords (like Late July) the chords are added and its tuning, links
// and notes are kept. Run the tests afterwards (cd tests && npm test).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { shippableChart } from "../js/chartfile.js";
import { buildIndex } from "./build-song-index.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.log("Usage: node tools/add-charts.mjs <songbook-charts.json> [id ...] [--list]");
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.app !== "songbook" || data.kind !== "charts" || !Array.isArray(data.charts)) {
  console.error("That isn't a Songbook charts export (Settings → Export your charts).");
  process.exit(1);
}
const list = rest.includes("--list");
const only = rest.filter((x) => !x.startsWith("--"));

const CHORD_FIELDS = ["key", "capo", "time", "tempo", "style", "strum", "voicings", "sections", "form", "source", "detector",
  "confidence", "sources", "beats", "bars", "analysis", "checkedFrom"];

const added = [];
for (const raw of data.charts) {
  const c = shippableChart(raw);
  if (!c) continue;
  if (list) { console.log(`${c.id}  ${c.title} · ${c.artist}  (${c.source})`); continue; }
  if (only.length && !only.includes(c.id)) continue;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) { console.warn(`skipped ${c.id}: not a usable file name`); continue; }
  const dest = path.join(root, "songs", c.id + ".json");
  let chart = c;
  if (fs.existsSync(dest)) {
    const old = JSON.parse(fs.readFileSync(dest, "utf8"));
    if (old.source === "web") { console.warn(`kept songs/${c.id}.json: it's a cited chart`); continue; }
    chart = { ...old };
    for (const k of CHORD_FIELDS) if (c[k] !== undefined) chart[k] = c[k];
    // Notes about the song (tuning, how to play along) stay; add the chart's own.
    if (c.notes && old.notes && !old.notes.includes(c.notes)) chart.notes = (old.notes.replace(/ ?No chords yet:[^.]*\.?/, "") + " " + c.notes).trim().slice(0, 600);
  }
  fs.writeFileSync(dest, JSON.stringify(chart, null, 2) + "\n");
  added.push(c.id);
  console.log(`wrote songs/${c.id}.json  ${c.title} · ${c.artist}  (${c.source})`);
}
if (list) process.exit(0);
if (!added.length) { console.log("Nothing to add."); process.exit(0); }

fs.writeFileSync(path.join(root, "songs", "index.json"), JSON.stringify(buildIndex(), null, 1) + "\n");
console.log("rebuilt songs/index.json");

// sw.js: precache the new charts, and bump CACHE so installed copies update.
const swPath = path.join(root, "sw.js");
let sw = fs.readFileSync(swPath, "utf8");
for (const id of added) {
  const entry = `  "songs/${id}.json",`;
  if (!sw.includes(entry)) sw = sw.replace(`  "songs/index.json",\n`, `  "songs/index.json",\n${entry}\n`);
}
sw = sw.replace(/const CACHE = "songbook-v(\d+)";/, (_, n) => `const CACHE = "songbook-v${+n + 1}";`);
fs.writeFileSync(swPath, sw);
console.log("updated sw.js (" + sw.match(/const CACHE = "([^"]+)"/)[1] + ")");
console.log("Next: cd tests && npm test, then commit songs/ and sw.js.");
