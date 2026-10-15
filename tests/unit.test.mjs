// Unit checks: chord engine, patterns, strum parsing. node unit.test.mjs
import fs from "fs";
import { check, eq, report } from "./lib.mjs";
import * as C from "../js/chords.js";
import * as P from "../js/patterns.js";
import { parseStrum, plainStrum, strumNotes } from "../js/audio.js";
import { meter } from "../js/chartplay.js";
import * as Pk from "../js/picking.js";

C.setChordDb(JSON.parse(fs.readFileSync(new URL("../vendor/chords-db/guitar.json", import.meta.url), "utf8")));

/* ---- parsing ---- */
const parsed = (n) => { const c = C.parseChord(n); return c && (c.nc ? "NC" : [c.root, c.q, c.bass]); };
eq("parse C", parsed("C"), [0, "", null]);
eq("parse F#m7/C#", parsed("F#m7/C#"), [6, "m7", 1]);
eq("parse Bbmaj7", parsed("Bbmaj7"), [10, "maj7", null]);
eq("parse unicode B♭m", parsed("B♭m"), [10, "m", null]);
eq("parse aliases: CM7, Cmin, Csus, C°, C+, Cø", ["CM7", "Cmin", "Csus", "C°", "C+", "Cø"].map((n) => C.parseChord(n).q), ["maj7", "m", "sus4", "dim", "aug", "m7b5"]);
eq("parse C6/9 is a 69 chord, not a slash", parsed("C6/9"), [0, "69", null]);
eq("parse N.C.", parsed("N.C."), "NC");
check("reject non-chords", ["H7", "Cxyz", "hello", "", "C/X"].every((n) => C.parseChord(n) === null));
eq("slash to its own root is dropped", parsed("C/C"), [0, "", null]);

/* ---- transpose and spelling ---- */
eq("transpose G +3 in Bb", C.transposeChord("G", 3, "Bb"), "Bb");
eq("transpose A/C# -2 in G", C.transposeChord("A/C#", -2, "G"), "G/B");
eq("transpose C#m +1 in D", C.transposeChord("C#m", 1, "D"), "Dm");
eq("transpose sharps in E", C.transposeChord("D", 2, "E"), "E");
eq("transpose to F# in sharp key", C.transposeChord("E", 2, "A"), "F#");
eq("not transposed: spelled as written (Bb in D stays Bb)", [C.transposeChord("Bb5", 0, "D"), C.transposeChord("A#m", 0, "F"), C.transposeChord("Bb/D", 2, "D")], ["Bb5", "A#m", "C/E"]);
eq("transpose to Gb in flat key", C.transposeChord("E", 2, "Db"), "Gb");
eq("common spelling with no key", ["C", "C#", "D", "D#", "E"].map((n) => C.transposeChord(n, 1)), ["C#", "D", "Eb", "E", "F"]);
eq("transpose round trip", ["Am7", "F#m7b5", "Bb/D", "Esus4"].map((n) => C.transposeChord(C.transposeChord(n, 5), -5)), ["Am7", "F#m7b5", "Bb/D", "Esus4"]);
eq("transposeKey", [C.transposeKey("C", 3), C.transposeKey("Am", 2), C.transposeKey("Eb", -3), C.transposeKey("Em", 4)], ["Eb", "Bm", "C", "G#m"]);
eq("pretty", C.prettyChord("Bbmaj7/F#"), "B♭maj7/F♯");

/* ---- simplify ---- */
eq("simplify", ["Cmaj7/B", "F#m7b5", "Asus4", "G7", "Am7", "Cadd9", "Bdim7", "E5"].map((n) => C.simplifyChord(n)), ["C", "F#dim", "A", "G", "Am", "C", "Bdim", "E"]);

/* ---- key estimate ---- */
eq("key of the Rising Sun verse", C.guessKey("Am C D F Am C E E".split(" ")).key, "Am");
eq("key of C G/B Am7 G/B", C.guessKey("C G/B Am7 G/B".split(" ")).key, "C");
eq("key of G D Em C", C.guessKey("G D Em C".split(" ")).key, "G");

/* ---- voicings ---- */
const best = (n, v) => (C.bestVoicing(n, v) || {}).spec;
eq("open shapes first", ["C", "G", "Am", "Em", "D", "E", "A", "Dm"].map((n) => best(n)), ["x32010", "320003", "x02210", "022000", "xx0232", "022100", "x02220", "xx0231"]);
eq("Pimapeggio extra voicings", ["G/B", "Am7", "Cmaj7", "Asus2", "F"].map((n) => best(n)), ["x20033", "x02010", "x32000", "x02200", "133211"]);
eq("a chart's own voicing wins", best("G/B", { "G/B": "x20003" }), "x20003");
eq("Bm is the A-shape barre", best("Bm"), "x24432");
for (const n of ["Bb", "F#m", "C#", "Eb", "Ab", "Gm", "Cm7", "D/F#", "Am7/G", "G#dim7", "E5", "Dbmaj7", "C9", "Fmaj7", "Bm7"]) {
  const v = C.bestVoicing(n);
  check(`a shape for ${n}`, v && v.difficulty < 30, v ? v.spec : "none");
  if (v) {
    // Every note of the shape is a chord tone and the bass is right.
    const pcs = C.chordPcs(n);
    const midis = C.voicingMidi(v.frets);
    const c = C.parseChord(n);
    check(`${n} ${v.spec}: chord tones only`, midis.every((m) => pcs.includes(m % 12)));
    if (!["dim7", "aug"].includes(c.q)) check(`${n} ${v.spec}: bass note`, midis[0] % 12 === (c.bass ?? c.root));
  }
}
check("easy shapes score lower than barres", C.difficulty([null, 3, 2, 0, 1, 0]) < C.difficulty([1, 3, 3, 2, 1, 1]));
check("impossible stretches score high", C.difficulty([1, 7, null, null, null, null]) >= 30);
eq("voicing midi", C.voicingMidi([null, 3, 2, 0, 1, 0]), [48, 52, 55, 60, 64]);
eq("voicing midi with capo", C.voicingMidi([null, 3, 2, 0, 1, 0], 3), [51, 55, 58, 63, 67]);
eq("fret spec round trip", C.fretsSpec(C.specFrets("x-10-12-12-12-10")), "x-10-12-12-12-10");

/* ---- Pimapeggio-compatible chords ---- */
const pc = C.pimaChord("C");
eq("pimaChord C is Pimapeggio's C", [pc.frets, pc.bass, pc.alt], [[3, 3, 2, 0, 1, 0], 5, 4]);
const fm = C.pimaChord("F#m");
check("pimaChord for any chord works with chordMidi", [1, 2, 3, 4, 5, 6].every((s) => Number.isFinite(P.chordMidi(fm, s))));
const travis = P.PATTERN_BY_ID.get("travis");
check("patterns play over a generated chord", travis.steps.every((st) => st.every((n) => {
  const s = P.noteString(n, fm, { i: 3, m: 2, a: 1 });
  return s >= 1 && s <= 6 && C.chordPcs("F#m").includes(P.chordMidi(fm, s) % 12);
})));

/* ---- capo ---- */
eq("capo for Bb Eb F Gm is 3 (G C D Em)", C.suggestCapo("Bb Eb F Bb Gm Eb F Bb".split(" ")).capo, 3);
eq("capo for Landslide's sounding chords is 3", C.suggestCapo("Eb Bb/D Cm7 Bb/D".split(" "), { key: "Eb" }).shapes, { "Eb": "C", "Bb/D": "G/B", "Cm7": "Am7" });
eq("no capo for open chords", C.suggestCapo("G C D Em".split(" ")).capo, 0);

/* ---- chart display ---- */
const chart = { capo: 3, key: null, sections: [{ name: "A", chords: "C | G/B | Am7 G/B" }] };
eq("splitBars", C.splitBars(chart.sections[0].chords), [["C"], ["G/B"], ["Am7", "G/B"]]);
const show = (view) => C.chartChordNames(chart).map((n) => C.displayChord(n, chart, view));
eq("display as written", show({ transpose: 0, capo: 3 }), ["C", "G/B", "Am7", "G/B"]);
eq("capo 0 shows sounding chords", show({ transpose: 0, capo: 0, shapeKey: "Eb" }), ["Eb", "Bb/D", "Cm7", "Bb/D"]);
eq("transpose +2 at capo 3", show({ transpose: 2, capo: 3, shapeKey: "D" }), ["D", "A/C#", "Bm7", "A/C#"]);
eq("simple", show({ transpose: 0, capo: 3, simple: true }), ["C", "G", "Am", "G"]);
eq("-2 renames the chords", show({ transpose: -2, capo: 3, shapeKey: "Bb" }), ["Bb", "F/A", "Gm7", "F/A"]);

/* ---- patterns (copied from Pimapeggio) ---- */
eq("58 patterns", P.PATTERNS.length, 58);
check("pattern ids unique", new Set(P.PATTERNS.map((p) => p.id)).size === P.PATTERNS.length);
eq("parseProgression", P.parseProgression("C | G/B | Am7 G/B").map((b) => b.map((c) => c.id)), [["C"], ["G/B"], ["Am7", "G/B"]]);

/* ---- strums ---- */
eq("parseStrum", parseStrum("D - D U - U d x").map((s) => [s.dir, !!s.accent, !!s.mute]),
  [["D", true, false], [null, false, false], ["D", true, false], ["U", true, false], [null, false, false], ["U", true, false], ["D", false, false], ["D", false, true]]);
let threw = false; try { parseStrum("D Q"); } catch (e) { threw = true; }
check("parseStrum rejects junk", threw);
eq("plain strums", [plainStrum("4/4"), plainStrum("3/4"), plainStrum("6/8")], ["D D D D", "D D D", "D - - D - -"]);
const down = strumNotes([null, 3, 2, 0, 1, 0], { dir: "D" });
const up = strumNotes([null, 3, 2, 0, 1, 0], { dir: "U" });
eq("downstroke low to high", down.map((n) => n.string), [5, 4, 3, 2, 1]);
eq("upstroke high to low, top strings", up.map((n) => n.string), [1, 2, 3, 4]);
check("strum is staggered", down.every((n, i) => i === 0 || n.at > down[i - 1].at));
eq("meter", [meter("4/4"), meter("3/4"), meter("6/8"), meter("12/8")].map((m) => m.beats), [4, 3, 2, 4]);

eq("diatonic chords in G", C.diatonicChords("G"), ["G", "Am", "Bm", "C", "D", "Em", "D7"]);
eq("diatonic chords in Gm", C.diatonicChords("Gm"), ["Gm", "Bb", "Cm", "Dm", "D", "Eb", "F", "D7"]);
eq("diatonic chords in F#", C.diatonicChords("F#").slice(0, 3), ["F#", "G#m", "A#m"]);

/* ---- song identity (library.js) ---- */
const L = await import("../js/library.js");
eq("normTitle drops versions and features", ["Landslide - 2004 Remaster", "Song (feat. Someone)", "The Song [Live]", "Café del Mar", "Hey - You"].map(L.normTitle),
  ["landslide", "song", "song", "cafe del mar", "hey you"]);
eq("normArtist takes the first artist", ["The Animals", "A, B", "Simon & Garfunkel"].map(L.normArtist), ["animals", "a", "simon garfunkel"]);
check("same song, same id", L.songIdFor("House Of The Rising Sun", "The Animals") === L.songIdFor("The House of the Rising Sun", "Animals"));
check("different songs, different ids", L.songIdFor("Song A", "X") !== L.songIdFor("Song B", "X"));
check("non-Latin titles get ids", /^s[0-9a-z]+$/.test(L.songIdFor("노래", "가수")) && L.songIdFor("노래", "가수") !== L.songIdFor("다른 노래", "가수"));
let bad = null; try { L.validateExport({ liked: [{ title: 1 }] }); } catch (e) { bad = e.message; }
check("validateExport rejects broken files", !!bad, String(bad));
check("validateExport accepts the import tool's format", L.validateExport({ fetched: "x", liked: [{ title: "a", artist: "b" }], playlists: [] }).liked.length === 1);


/* ---- Picking mode ---- */
{
  const chart = { picking: { patterns: ["travis"], also: ["alt-thumb"], source: "mine", match: "family" },
    sections: [{ name: "Intro", chords: "C | G/B | Am7 G/B" }, { name: "Bridge", chords: "F | G", picking: { patterns: ["pima"], source: "web", sources: [{ label: "x", url: "https://example.com" }] } }] };
  eq("picking: the chart's pattern", Pk.patternFor(chart, chart.sections[0], {}).pattern.id, "travis");
  eq("picking: a section's own pattern wins", Pk.patternFor(chart, chart.sections[1], {}).pattern.id, "pima");
  const mine = Pk.patternFor(chart, chart.sections[0], { pickPattern: "pimami" });
  eq("picking: your pick wins, and says so", [mine.pattern.id, mine.mine, mine.options], ["pimami", true, ["travis", "alt-thumb"]]);
  check("picking: badges say where a pattern is from", /your description/.test(Pk.patternBadge(Pk.patternFor(chart, chart.sections[0], {}))) && /your pick/.test(Pk.patternBadge(mine)) && /sourced/.test(Pk.patternBadge(Pk.patternFor(chart, chart.sections[1], {}))));
  eq("picking: nothing is guessed", Pk.patternFor({ sections: [] }, null, {}).pattern, null);
  const bars = Pk.sectionBars(chart, 0, (n) => n, {});
  eq("picking: a section's bars, with shapes for the stage", bars.map((b) => b.chords.map((c) => c.name + ":" + c.spec)), [["C:x32010"], ["G/B:x20033"], ["Am7:x02010", "G/B:x20033"]]);
  check("picking: each chord has a Pimapeggio voicing", bars.every((b) => b.chords.every((c) => c.pima && c.pima.bass)));
  const p = P.PATTERN_BY_ID.get("travis");
  check("picking: finger letters, one cell per step", (Pk.fingersHtml(p).match(/class='fcell'/g) || []).length === 4);
  check("picking: diagram has a column per step and a dot per note", (Pk.diagramSvg(p, bars[0].chords[0].pima).match(/dg-col/g) || []).length === 4 && (Pk.diagramSvg(p, bars[0].chords[0].pima).match(/<circle/g) || []).length === 4);
  const link = new URL(Pk.pimapeggioLink({ pattern: p, bars, capo: 3, bpm: 80.4, name: "Song · Intro" }, "https://example.com/pimapeggio/"));
  eq("picking: Pimapeggio link", [link.origin + link.pathname, link.searchParams.get("pattern"), link.searchParams.get("chords"), link.searchParams.get("voicings"), link.searchParams.get("capo"), link.searchParams.get("bpm"), link.searchParams.get("name")],
    ["https://example.com/pimapeggio/", "travis", "C | G/B | Am7 G/B", "C:x32010,G/B:x20033,Am7:x02010", "3", "80", "Song · Intro"]);
  eq("picking: Pimapeggio next to the deployed app", Pk.pimapeggioBase({ hostname: "kellyhuntlin.com", href: "https://kellyhuntlin.com/the-songbook/#/song/x/picking" }), "https://kellyhuntlin.com/pimapeggio/");
  eq("picking: and its local copy", Pk.pimapeggioBase({ hostname: "localhost", href: "http://localhost:8320/" }), "http://localhost:8318/");
}

report("unit");
