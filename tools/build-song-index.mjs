// Rebuilds songs/index.json from songs/<id>.json (run after adding or editing
// a shipped chart; tests/data.test.mjs fails if the index is out of date).
// node tools/build-song-index.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "songs");

export function buildIndex() {
  const songs = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json").sort().map((f) => {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    return {
      id: c.id, type: c.type || "song", title: c.title, artist: c.artist,
      style: c.style || null, source: c.source || null, confidence: c.confidence || null,
      hasChords: (c.sections || []).some((s) => s.chords && s.chords.trim()),
      capo: c.capo || 0, key: c.key || null,
      patterns: c.picking ? c.picking.patterns : [], pickingSource: c.picking ? c.picking.source : null,
    };
  });
  return { about: "Shipped chords-only charts. Built by tools/build-song-index.mjs; edit the song files, not this.", songs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(buildIndex(), null, 1) + "\n");
  console.log("wrote songs/index.json");
}
