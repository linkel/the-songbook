// Builds vendor/chords-db/guitar.json, a compact subset of chords-db
// (github.com/tombatossals/chords-db, MIT, by David Rubert).
// node tools/build-chords-db.mjs <path to the npm package's lib/guitar.json>
// Get it with: npm pack @tombatossals/chords-db && tar xzf tombatossals-chords-db-*.tgz
//
// Output: { "C": { "major": ["x32010", "x-3-5-5-5-3", ...], "m7": [...] }, "C#": ... }
// Frets are absolute, low E to high E, "x" for unplayed; dash-separated when a
// fret is 10 or higher. Keys use chords-db's spelling (C C# D Eb E F F# G Ab A Bb B).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const src = process.argv[2];
if (!src) { console.error("usage: node tools/build-chords-db.mjs <guitar.json>"); process.exit(1); }
const db = JSON.parse(fs.readFileSync(src, "utf8"));

const out = {};
let n = 0;
for (const list of Object.values(db.chords)) {
  for (const ch of list) {
    const shapes = ch.positions.map((p) => {
      const frets = p.frets.map((f) => (f < 0 ? null : f === 0 ? 0 : f + p.baseFret - 1));
      const wide = frets.some((f) => f !== null && f >= 10);
      return frets.map((f) => (f === null ? "x" : String(f))).join(wide ? "-" : "");
    });
    (out[ch.key] = out[ch.key] || {})[ch.suffix] = [...new Set(shapes)];
    n += shapes.length;
  }
}

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "chords-db", "guitar.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out));
console.log("wrote", dest, n, "shapes,", fs.statSync(dest).size, "bytes");
