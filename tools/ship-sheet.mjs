// Ships your own lyrics for a song as its default sheet: your transcription
// (a text or markdown file, one line per sung line, a blank line between
// verses), with the chart's chords placed on it by time and the times that
// make the sheet follow the recording. The times come from the PC helper
// lining your lines up with the song's vocal stem (align=lyrics; saved as
// JSON { lines: [{ index, t }] }). Lines it couldn't place sit between their
// neighbours for the chords, and don't follow the recording.
//   node tools/ship-sheet.mjs <song id> <lyrics file> <timing.json>
// Writes songs/sheets/<id>.json and points songs/<id>.json at it. The repo
// is public: this publishes the words. Your edits in the app stay on the
// device and replace it there.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sheetFromTiming, lyricLines } from "../js/lyrics.js";
import { parseChordPro } from "../js/chordpro.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [id, lyricsFile, timingFile] = process.argv.slice(2);
if (!id || !lyricsFile || !timingFile) {
  console.log("Usage: node tools/ship-sheet.mjs <song id> <lyrics file> <timing.json>");
  process.exit(1);
}
const chartPath = path.join(root, "songs", id + ".json");
const chart = JSON.parse(fs.readFileSync(chartPath, "utf8"));
const raw = fs.readFileSync(lyricsFile, "utf8").split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim());
const lines = raw.filter(Boolean);
const stanzaStart = new Set();
raw.forEach((l, k) => { if (l && k > 0 && !raw[k - 1]) stanzaStart.add(raw.slice(0, k).filter(Boolean).length); });
const timing = JSON.parse(fs.readFileSync(timingFile, "utf8"));
const at = new Map(timing.lines.map((x) => [x.index, x.t]));

// Every line a time, for placing chords: placed lines as aligned; the others
// after the line before, at the song's usual spacing, never past the next.
const placed = [...at.values()].sort((a, b) => a - b);
const gaps = placed.slice(1).map((t, k) => t - placed[k]).filter((g) => g > 0.5 && g < 8).sort((a, b) => a - b);
const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 4;
const times = [];
lines.forEach((_, i) => {
  if (at.has(i)) { times.push(at.get(i)); return; }
  const prev = i ? times[i - 1] : null;
  const nextI = [...at.keys()].filter((k) => k > i).sort((a, b) => a - b)[0];
  const next = nextI !== undefined ? at.get(nextI) : Infinity;
  let t = prev !== null ? prev + step : next - step * (nextI - i);
  if (t >= next) t = (prev ?? next - step) + (next - (prev ?? next - step)) * 0.5;
  times.push(Math.max(0, t));
});
const timed = [];
lines.forEach((text, i) => {
  // A blank between verses ends the line before it.
  if (stanzaStart.has(i) && i) timed.push({ t: Math.min(times[i] - 0.05, times[i - 1] + step * 1.1), text: "" });
  timed.push({ t: times[i], text });
});

const bars = chart.bars.map((b, i) => ({ t: b.t, t1: chart.bars[i + 1] ? chart.bars[i + 1].t : b.t + 2, chords: b.chords.filter((c) => !/^N\.?C\.?$/.test(c)) })).filter((b) => b.chords.length);
const built = sheetFromTiming(timed, bars, { title: chart.title, artist: chart.artist }).split("\n");
// Put the verses' blank lines back.
const head = built.filter((l) => l.startsWith("{"));
const body = built.filter((l) => !l.startsWith("{"));
const intro = body.length > lines.length ? body.slice(0, body.length - lines.length) : [];
const sung = body.slice(intro.length);
const out = [...head, ...intro, ...(intro.length ? [""] : [])];
sung.forEach((l, i) => { if (stanzaStart.has(i) && i) out.push(""); out.push(l); });
const chordpro = out.join("\n");

// The sheet's lyric line for each of your lines, for the timing.
const sheetLines = lyricLines(parseChordPro(chordpro));
const index = [];
sheetLines.forEach((l, i) => { if (l.text) index.push(i); });
const doc = {
  id, title: chart.title, artist: chart.artist, source: "mine", label: "Your transcription, from your recording",
  chordsFrom: chart.source, chordpro,
  timing: { source: "aligned", aligner: timing.aligner || null, lines: [...at.entries()].filter(([i]) => i < index.length).map(([i, t]) => ({ index: index[i], t })) },
};
fs.mkdirSync(path.join(root, "songs", "sheets"), { recursive: true });
fs.writeFileSync(path.join(root, "songs", "sheets", id + ".json"), JSON.stringify(doc, null, 1) + "\n");
chart.sheetFile = `songs/sheets/${id}.json`;
fs.writeFileSync(chartPath, JSON.stringify(chart, null, 2) + "\n");
console.log(`wrote songs/sheets/${id}.json: ${lines.length} lines, ${doc.timing.lines.length} following the recording; songs/${id}.json points at it`);
