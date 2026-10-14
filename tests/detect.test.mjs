// Analysis post-processing and tag reading, on made-up arrays and bytes.
import fs from "fs";
import { check, eq, report } from "./lib.mjs";
import * as D from "../js/detect.js";
import * as T from "../js/tags.js";
import * as C from "../js/chords.js";
import * as R from "../js/chordrec.js";
await import("../js/chroma.js");
const SC = globalThis.SongbookChroma;

C.setChordDb(JSON.parse(fs.readFileSync(new URL("../vendor/chords-db/guitar.json", import.meta.url), "utf8")));

// A raw result: beats every 0.5 s, chords per beat (sharps, as essentia gives them).
function raw(chords, strength = 0.8) {
  const ticks = chords.map((_, i) => 0.5 + i * 0.5).concat(0.5 + chords.length * 0.5);
  return { ticks, chords, strength: chords.map(() => strength) };
}
const per = (names, beats = 4) => names.flatMap((n) => Array(beats).fill(n));

/* ---- cleaning ---- */
eq("cleanChord: sharps to common names, N to null", ["A#", "A#m", "C#", "N", "", "G"].map(D.cleanChord), ["Bb", "Bbm", "C#", null, null, "G"]);
const filled = D.beatChords(raw(["N", "G", "N", "N", "C"]));
eq("N is filled from neighbours", filled.map((b) => b.chord), ["G", "G", "G", "G", "C"]);
check("filled beats are marked", filled[0].filled && filled[2].filled && !filled[1].filled);

/* ---- bars ---- */
const song = D.beatChords(raw(per(["G", "D", "Em", "C", "G", "D", "Em", "C"])));
eq("beat 1 found when it's the first beat", D.findDownbeat(song, 4), 0);
const pickup = D.beatChords(raw(["C"].concat(per(["G", "D", "Em", "C", "G", "D", "Em", "C"]))));
eq("beat 1 after a one-beat pickup", D.findDownbeat(pickup, 4), 1);
const bars = D.makeBars(pickup, { bpb: 4, phase: 1 });
eq("pickup becomes a short first bar", [bars[0].n, bars[0].chords, bars[1].chords], [1, ["C"], ["G"]]);
eq("one chord per bar", bars.slice(1, 5).map((b) => b.chords.join(" ")), ["G", "D", "Em", "C"]);
const halves = D.makeBars(D.beatChords(raw(per(["C", "G", "Am", "F"], 2))), { bpb: 4, phase: 0 });
eq("two chords in a bar: halves", halves.map((b) => b.chords.join(" ")), ["C G", "Am F"]);
const noisy = D.beatChords(raw(["G", "G", "Em", "G", "D", "D", "D", "D"]));
eq("a stray beat doesn't split the bar", D.makeBars(noisy, { bpb: 4, phase: 0 }).map((b) => b.chords.join(" ")), ["G", "D"]);
const weak = D.makeBars(D.beatChords(raw(per(["G", "D"]), 0.2)), { bpb: 4, phase: 0 });
check("weak bars are unsure", weak.every((b) => !b.sure));
check("strong bars are sure", D.makeBars(song, { bpb: 4, phase: 0 }).every((b) => b.sure));
const waltz = D.beatChords(raw(per(["C", "F", "G", "C", "C", "F", "G", "C"], 3)));
eq("3/4 detected", [D.findMeter(waltz).bpb, D.findMeter(waltz).phase], [3, 0]);
eq("4/4 stays 4/4", D.findMeter(song).bpb, 4);
eq("4/4 with half-bar changes stays 4/4", D.findMeter(D.beatChords(raw(per(["C", "G", "Am", "F", "C", "G", "Am", "F"], 2)))).bpb, 4);

/* ---- tempo ×2 / ÷2 ---- */
eq("scaleBeats ×2", D.scaleBeats([0, 1, 2], 2), [0, 0.5, 1, 1.5, 2]);
eq("scaleBeats ÷2", D.scaleBeats([0, 1, 2, 3, 4], 0.5), [0, 2, 4]);
const twice = D.rescaleBeats(song, 2);
eq("rescale ×2 keeps the chords", [twice.length, twice[0].chord, twice[8].chord], [song.length * 2, "G", "D"]);
const half = D.rescaleBeats(song, 0.5);
eq("rescale ÷2 merges beats", [half.length, half[0].t0, half[0].t1], [16, song[0].t0, song[1].t1]);

/* ---- sections ---- */
const ab = (names) => names.map((n) => ({ chords: n.split(" ") }));
const form1 = D.findSections(ab([..."D Bm G A D Bm G A G A D D".split(" "), ..."D Bm G A D Bm G A G A D D".split(" ")]));
eq("A/B sections from repeats", form1.form, ["Part A", "Part B", "Part A", "Part B"]);
eq("section chords", form1.sections.map((s) => s.chords), ["D | Bm | G | A | D | Bm | G | A", "G | A | D | D"]);
const form2 = D.findSections(ab(["E", "E", ..."G D Em C G D Em C".split(" "), ..."G D Em C G D Em C".split(" "), "C"]));
eq("start and end around the repeats", form2.form, ["Start", "Part A", "Part A", "End"]);
eq("spans cover every bar", form2.spans.flat().length, 19);

/* ---- the chart ---- */
const chart = D.detectedChart(D.makeBars(song, { bpb: 4, phase: 0 }), song.map((b) => b.t0), { bpm: 120, keys: { edma: { key: "G", scale: "major", strength: 0.8 } }, version: "x", bpb: 4 });
eq("detected chart", [chart.source, chart.key, chart.tempo, chart.time, chart.form], ["detected", "G", 120, "4/4", ["Part A", "Part A"]]);
check("detector named, with version", /essentia/.test(chart.detector) && /x/.test(chart.detector));
check("bars and beats kept", chart.bars.length === 8 && chart.beats.length === song.length);
eq("minor key name", D.keyName({ key: "A#", scale: "minor" }), "Bbm");

/* ---- agreement with a cited chart ---- */
const cited = { sections: [{ name: "V", chords: "Eb | Bb/D | Cm7 | Bb/D" }], form: ["V"] };
const det = ab(["Bb", "Eb", "Bb", "Cm", "Bb", "Eb", "Bb", "Cm"]);
const cmp = D.compareWithChart(det, cited, 0, C.transposeChord);
eq("agreement at the best alignment (as triads)", [cmp.agree, cmp.total, cmp.offset], [8, 8, 3]);
const det2 = ab(["Eb", "Bb", "F", "Bb"]);
eq("disagreeing bars are marked", D.compareWithChart(det2, cited, 0, C.transposeChord).bars, [true, true, false, true]);
const capoChart = { sections: [{ name: "V", chords: "C | G/B | Am7 | G/B" }], form: ["V"], capo: 3 };
eq("cited shapes with a capo compare at sounding pitch", D.compareWithChart(det2.slice(0, 2), capoChart, 3, C.transposeChord).agree, 2);

/* ---- naming chords from chroma ---- */
// Chroma is indexed from A; a made-up chroma with given notes loud.
const NOTE = { A: 0, Bb: 1, B: 2, C: 3, Db: 4, D: 5, Eb: 6, E: 7, F: 8, Gb: 9, G: 10, Ab: 11 };
const chroma = (notes, rest = 0.05) => { const v = new Array(12).fill(rest); for (const [n, x] of Object.entries(notes)) v[NOTE[n]] = x; return v; };
const bassOn = (n) => chroma({ [n]: 1 }, 0.02);
eq("a triad is a triad", R.nameChroma(chroma({ G: 1, Bb: 0.8, D: 0.9 }), bassOn("G")).chord, "Gm");
eq("a weak extra note doesn't make a 7th", R.nameChroma(chroma({ C: 1, E: 0.8, G: 0.9, B: 0.2 }), bassOn("C")).chord, "C");
eq("maj7 when the 7th is there", R.nameChroma(chroma({ Eb: 1, G: 0.8, Bb: 0.7, D: 0.9 }), bassOn("Eb")).chord, "Ebmaj7");
eq("dominant 7th", R.nameChroma(chroma({ G: 1, B: 0.8, D: 0.8, F: 0.8 }), bassOn("G")).chord, "G7");
eq("m7", R.nameChroma(chroma({ A: 1, C: 0.8, E: 0.8, G: 0.8 }), bassOn("A")).chord, "Am7");
eq("sus4 with no third", R.nameChroma(chroma({ D: 1, G: 0.9, A: 0.9 }), bassOn("D")).chord, "Dsus4");
eq("the bass picks the root: Ebmaj7 vs Gm", R.nameChroma(chroma({ G: 1, Bb: 0.8, D: 0.9, Eb: 0.7 }), bassOn("Eb")).chord, "Ebmaj7");
eq("bass on the third makes a slash chord", R.nameChroma(chroma({ D: 1, Gb: 0.8, A: 0.9 }), bassOn("Gb")).chord, "D/F#");
// D and A with both F and F# half there: D in D major, Dm in F major.
const amb = chroma({ D: 1, A: 0.9, F: 0.5, Gb: 0.5 });
eq("the key tips a close call toward its chords", [R.nameChroma(amb, bassOn("D"), "D").chord, R.nameChroma(amb, bassOn("D"), "F").chord], ["D", "Dm"]);
eq("keyScale of G minor includes F# (for D7)", [...R.keyScale("Gm")].sort((a, b) => a - b), [0, 2, 3, 5, 6, 7, 9, 10]);
const named = R.nameChroma(chroma({ G: 1, Bb: 0.8, D: 0.9 }), bassOn("G"));
check("strength and margin reported", named.strength > 0.6 && named.margin > 0.04, JSON.stringify(named));
eq("median of beats ignores a passing note", R.combineRows([chroma({ C: 1, E: 1 }, 0), chroma({ C: 1, E: 1, A: 1 }, 0), chroma({ C: 1, E: 1 }, 0)])[NOTE.A], 0);
// Viterbi: a single odd beat inside a run of one chord doesn't flip it.
const run = [...Array(6)].map((_, i) => (i === 3 ? chroma({ E: 1, G: 0.7, B: 0.6, C: 0.6 }) : chroma({ C: 1, E: 0.8, G: 0.9 })));
eq("one odd beat is smoothed over", R.labelBeats(run, run.map(() => bassOn("C"))).map((l) => l.chord), Array(6).fill("C"));
eq("quiet beats are no chord", R.labelBeats([chroma({ C: 1, E: 1, G: 1 }), chroma({ C: 1, E: 1, G: 1 })], null, [1, 0.01])[1].chord, null);
// beatChords with chroma: families for bar lines, named bars.
const rawC = { ticks: [...Array(17)].map((_, i) => i * 0.5), keys: { edma: { key: "A#", scale: "major" } },
  chroma: { tuning: 0, treble: [], bass: [], energy: [] } };
for (const [notes, b] of [[{ G: 1, Bb: 0.8, D: 0.9 }, "G"], [{ F: 1, A: 0.8, C: 0.9 }, "F"], [{ Eb: 1, G: 0.8, Bb: 0.7, D: 0.9 }, "Eb"], [{ Eb: 1, G: 0.8, Bb: 0.8 }, "Eb"]]) {
  for (let k = 0; k < 4; k++) { rawC.chroma.treble.push(chroma(notes)); rawC.chroma.bass.push(bassOn(b)); rawC.chroma.energy.push(1); }
}
const cb = D.beatChords(rawC);
eq("beat families", [cb[0].chord, cb[8].chord, cb[12].chord], ["Gm", "Eb", "Eb"]);
const cbars = D.makeBars(cb, { bpb: 4, phase: 0 });
eq("bars named from chroma", cbars.map((b) => b.chords.join(" ")), ["Gm", "F", "Ebmaj7", "Eb"]);
check("chroma bars are sure", cbars.every((b) => b.sure), JSON.stringify(cbars.map((b) => [b.strength, b.sure])));
eq("÷2 keeps chroma", !!D.rescaleBeats(cb, 0.5)[0].treble, true);
eq("a detected chart names the new detector", /chord profiles/.test(D.detectedChart(cbars, rawC.ticks, { bpm: 120, keys: rawC.keys, version: "x", tuning: -3 }).detector), true);
eq("the tuning is kept", D.detectedChart(cbars, rawC.ticks, { bpm: 120, keys: rawC.keys, tuning: -3 }).analysis.tuning, -3);

/* ---- chroma DSP ---- */
// A pure tone at 220 Hz (A3), tuned 20 cents sharp, through the whole front end.
{
  const sr = 44100, secs = 3, f = 220 * Math.pow(2, 20 / 1200);
  const x = new Float32Array(sr * secs);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr) + 0.25 * Math.sin(2 * Math.PI * 2 * f * i / sr) + 0.12 * Math.sin(2 * Math.PI * 3 * f * i / sr);
  const res = SC.beatChroma(x, [0.5, 1.5, 2.5]);
  check(`tuning of a tone 20 cents sharp: ${res.tuning}`, Math.abs(res.tuning - 20) <= 5);
  const top = res.treble[0].indexOf(Math.max(...res.treble[0]));
  eq("its note is A in the chroma, harmonics folded back", top, NOTE.A);
  check("the fifth from its 3rd harmonic stays small", res.treble[0][NOTE.E] < 0.35 * res.treble[0][NOTE.A], JSON.stringify(res.treble[0]));
}
{
  const fft = SC.makeFFT(8);
  const re = Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0]), im = new Float64Array(8);
  fft(re, im);
  eq("FFT of an impulse is flat", [...re].map((v) => Math.round(v * 1e6) / 1e6), [1, 1, 1, 1, 1, 1, 1, 1]);
}

/* ---- tags ---- */
const enc = (s) => [...new TextEncoder().encode(s)];
const ss = (n) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const be = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
function id3v(ver, frames) {
  const body = frames.flatMap(([id, text, encByte = 3]) => {
    const t = encByte === 1 ? [0xff, 0xfe, ...[...text].flatMap((ch) => [ch.charCodeAt(0), 0])] : enc(text);
    const data = [encByte, ...t];
    return [...enc(id), ...(ver === 4 ? ss(data.length) : be(data.length)), 0, 0, ...data];
  });
  return new Uint8Array([...enc("ID3"), ver, 0, 0, ...ss(body.length), ...body, 0xff, 0xfb]);
}
eq("ID3v2.4 UTF-8", T.id3(id3v(4, [["TIT2", "Test Song"], ["TPE1", "Test Artist"]])), { title: "Test Song", artist: "Test Artist" });
eq("ID3v2.3 UTF-16", T.id3(id3v(3, [["TIT2", "Café", 1], ["TPE1", "Nobody", 1], ["TALB", "Album"]])), { title: "Café", artist: "Nobody", album: "Album" });
check("not ID3", T.id3(new Uint8Array(enc("RIFF....WAVE"))) === null);
// MP4 atom names are bytes ("©" is 0xA9).
function m4aFile() {
  const name = (s) => [...s].map((ch) => ch.charCodeAt(0) & 255);
  const at = (type, payload) => [...be(8 + payload.length), ...name(type), ...payload];
  const item = (type, text) => at(type, at("data", [0, 0, 0, 1, 0, 0, 0, 0, ...enc(text)]));
  return new Uint8Array([...at("ftyp", name("M4A \0\0\0\0")),
    ...at("moov", at("udta", at("meta", [0, 0, 0, 0, ...at("hdlr", Array(25).fill(0)),
      ...at("ilst", [...item("©nam", "Test Song"), ...item("©ART", "Test Artist")])])))]);
}
eq("MP4 tags", T.mp4(m4aFile()), { title: "Test Song", artist: "Test Artist" });
function flacFile() {
  const le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const vendor = enc("test");
  const comments = ["TITLE=Test Song", "ARTIST=Test Artist"].map(enc);
  const block = [...le(vendor.length), ...vendor, ...le(comments.length), ...comments.flatMap((c) => [...le(c.length), ...c])];
  return new Uint8Array([...enc("fLaC"), 0x84, (block.length >> 16) & 255, (block.length >> 8) & 255, block.length & 255, ...block]);
}
eq("FLAC tags", T.flac(flacFile()), { title: "Test Song", artist: "Test Artist" });
eq("file name: Artist - Title", T.fromFileName("Fleetwood Mac - Landslide.mp3"), { artist: "Fleetwood Mac", title: "Landslide" });
eq("file name: track number", T.fromFileName("03 Some Song.m4a"), { title: "Some Song", artist: "" });

report("detect");
