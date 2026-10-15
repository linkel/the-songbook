// Lyric timing, LRC parsing, matching synced lines to a sheet, sheets built
// from timing and chords, and the zip format used for speedy-pitcher exports.
// Invented lyrics only. node lyrics.test.mjs
import { check, eq, report, EXAMPLE_SHEET } from "./lib.mjs";
import * as Ly from "../js/lyrics.js";
import { parseChordPro, importText } from "../js/chordpro.js";
import { makeZip, readZip, crc32 } from "../js/zip.js";

/* ---- LRC ---- */
const lrc = `[ar: Nobody]
[00:01.50] Morning light on the kitchen floor,
[00:05.00]coffee cooling by the open door
[00:09.25][00:30.00] Every little thing I meant to say
[00:13.10]
[1:02.5] drifting like a paper boat away`;
const parsed = Ly.parseLrc(lrc);
eq("LRC: times in seconds, sorted, repeated stamps kept", parsed.map((x) => x.t), [1.5, 5, 9.25, 13.1, 30, 62.5]);
eq("LRC: text without stamps", parsed[0].text, "Morning light on the kitchen floor,");
eq("LRC: empty instrumental lines kept as empty", parsed[3].text, "");
eq("LRC: tags that aren't times are ignored", Ly.parseLrc("[ar: x]\n[ti: y]").length, 0);

/* ---- sheet lines and alignment ---- */
const doc = parseChordPro(importText(EXAMPLE_SHEET, { title: "Example song", artist: "Nobody" }));
const lines = Ly.lyricLines(doc);
check("lyric lines in reading order", lines.length >= 8 && lines.some((l) => /Morning light/.test(l.text)), JSON.stringify(lines.slice(0, 3)));
const firstLyric = lines.findIndex((l) => /Morning light/.test(l.text));
// Synced lines with small differences in punctuation and case, one line
// missing from the sheet, and one extra line the sheet doesn't have.
const synced = [
  { t: 10.2, text: "morning light on the kitchen floor" },
  { t: 14.0, text: "Coffee cooling by the open door!" },
  { t: 16.5, text: "A line that isn't in the sheet at all" },
  { t: 18.4, text: "every little thing I meant to say" },
  { t: 22.9, text: "Drifting like a paper boat away" },
];
const timing = Ly.alignToSheet(synced, lines);
eq("aligned: lines matched in order", timing.map((x) => lines[x.index].text.slice(0, 12)), ["Morning ligh", "coffee cooli", "Every little", "drifting lik"]);
eq("aligned: times from the synced lines", timing.map((x) => x.t), [10.2, 14, 18.4, 22.9]);
eq("aligned: the first matched line is the first lyric", timing[0].index, firstLyric);
eq("nothing matches: no timing", Ly.alignToSheet([{ t: 1, text: "completely different words here" }], lines).length, 0);
eq("lineAt: the line playing", [Ly.lineAt(timing, 5), Ly.lineAt(timing, 10.2), Ly.lineAt(timing, 15), Ly.lineAt(timing, 99)], [-1, timing[0].index, timing[1].index, timing[3].index]);

/* ---- a sheet from timed lines and bars ---- */
const bars = [
  { t: 0, t1: 2, chords: ["C"] }, { t: 2, t1: 4, chords: ["G"] },
  { t: 4, t1: 6, chords: ["Am"] }, { t: 6, t1: 8, chords: ["F"] },
  { t: 8, t1: 10, chords: ["C", "G"] },
];
const tl = [{ t: 2, text: "one two three four five six" }, { t: 6, text: "seven eight nine ten" }, { t: 9.5, text: "" }];
const cp = Ly.sheetFromTiming(tl, bars, { title: "Made Up", artist: "Nobody" });
const cpLines = cp.split("\n");
eq("sheet: title and artist", cpLines.slice(0, 2), ["{title: Made Up}", "{artist: Nobody}"]);
eq("sheet: chords before the first line become an intro line", cpLines[2], "[C]");
eq("sheet: chord changes placed at words by time", cpLines[3], "[G]one two three [Am]four five six");
eq("sheet: the next line, with a half-bar change", cpLines[4], "[F]seven eight [C]nine [G]ten");
const back = parseChordPro(cp);
eq("sheet: parses back with the same lyrics", Ly.lyricLines(back).filter((l) => l.text).map((l) => l.text), ["one two three four five six", "seven eight nine ten"]);
check("sheet: only real chord names", [...cp.matchAll(/\[([^\]]+)\]/g)].every((m) => Ly.isChord(m[1])));

/* ---- zip ---- */
eq("crc32 of 'The quick brown fox jumps over the lazy dog'", crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")).toString(16), "414fa339");
const audio = new Uint8Array(70000).map((_, i) => (i * 13) & 255);
const zip = await makeZip([{ name: "library.json", data: JSON.stringify({ app: "speedy-pitcher", songs: [] }) }, { name: "audio/a1.mp3", data: new Blob([audio]) }, { name: "dir/ünïcode.txt", data: "hi" }]);
const entries = await readZip(zip);
eq("zip: names", [...entries.keys()], ["library.json", "audio/a1.mp3", "dir/ünïcode.txt"]);
const got = new Uint8Array(await entries.get("audio/a1.mp3").blob.arrayBuffer());
check("zip: a file reads back byte for byte", got.length === audio.length && got.every((b, i) => b === audio[i]));
eq("zip: text", await entries.get("dir/ünïcode.txt").blob.text(), "hi");
let bad = null;
try { await readZip(new Blob([new Uint8Array(100)])); } catch (e) { bad = e.message; }
check("zip: not a zip is a readable error", /isn't a zip/.test(bad || ""), bad);

/* ---- LRCLIB's lines retimed to your recording (times only, keyed by line) ---- */
{
  const synced = [{ t: 10, text: "First made-up line" }, { t: 14, text: "" }, { t: 15, text: "Second made-up line" }, { t: 20, text: "Third made-up line" }, { t: 30, text: "Fourth made-up line" }];
  const r = Ly.retime(synced, [{ j: 0, t: 70 }, { j: 2, t: 90 }]);
  eq("retime: aligned lines take their times", [r[0].t, r[3].t], [70, 90]);
  eq("retime: a line between two aligned ones sits between them, spaced as LRCLIB had it", r[2].t, 70 + 20 * (5 / 10));
  eq("retime: after the last, LRCLIB's spacing from there", r[4].t, 100);
  eq("retime: nothing aligned leaves it as it was", Ly.retime(synced, []), synced);
  check("retime: never goes backwards", r.every((x, k) => !k || x.t >= r[k - 1].t));
}

report("lyrics");
