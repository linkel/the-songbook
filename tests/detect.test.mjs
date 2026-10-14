// Analysis post-processing and tag reading, on made-up arrays and bytes.
import fs from "fs";
import { check, eq, report } from "./lib.mjs";
import * as D from "../js/detect.js";
import * as T from "../js/tags.js";
import * as C from "../js/chords.js";

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
