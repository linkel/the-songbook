// Sheet parser checks. Every lyric here is made up for the tests.
import { check, eq, report } from "./lib.mjs";
import * as S from "../js/chordpro.js";

/* ---- line kinds ---- */
check("chord line", S.isChordLine("G      Em7        C    D"));
check("chord line with marks", S.isChordLine("| Am  C | G  (x2)"));
check("chord line with parenthesised chord", S.isChordLine("Am   (G)   F"));
check("lyric is not a chord line", !S.isChordLine("Morning light on the kitchen floor"));
check("a lyric starting with A is not a chord line", !S.isChordLine("A paper boat"));
eq("headings", ["[Verse 1]", "Chorus:", "[Pre-Chorus]", "Bridge", "Intro (x2)", "[Am]", "Hold on, hold on"].map(S.headingOf),
  ["Verse 1", "Chorus", "Pre-Chorus", "Bridge", "Intro (x2)", null, null]);

/* ---- merging by column ---- */
eq("merge chords into the lyric by column",
  S.mergeChordLine("G              Em7          C", "Morning light on the kitchen floor"),
  "[G]Morning light o[Em7]n the kitchen [C]floor");
eq("chords past the end of the lyric follow it",
  S.mergeChordLine("C          D         G", "Hold on"),
  "[C]Hold on [D] [G]");
eq("mid-word chords stay mid-word",
  S.mergeChordLine("            C", "paper boat away"),
  "paper boat a[C]way");

/* ---- a chords-over-lyrics paste ---- */
const paste = [
  "Capo: 3rd fret",
  "Key: G",
  "",
  "[Intro]",
  "G  Em7  C  D",
  "",
  "[Verse 1]",
  "G              Em7          C",
  "Morning light on the kitchen floor,",
  "G              Em7          C     D",
  "coffee cooling by the open door",
  "",
  "Chorus:",
  "C        D        Em7",
  "Hold on, hold on, it's alright",
].join("\n");
const cp = S.importText(paste, { title: "Example song", artist: "Nobody" });
check("paste: title and artist added", cp.includes("{title: Example song}") && cp.includes("{artist: Nobody}"));
check("paste: capo and key read", cp.includes("{capo: 3}") && cp.includes("{key: G}"));
check("paste: sections", cp.includes("{start_of_intro: Intro}") && cp.includes("{start_of_verse: Verse 1}") && cp.includes("{start_of_chorus: Chorus}"));
check("paste: merged lyric line", cp.includes("[G]Morning light o[Em7]n the kitchen [C]floor,"));
check("paste: chord-only intro line", cp.includes("[G] [Em7] [C] [D]"));
check("paste: meta lines removed from the body", !/Capo: 3rd/.test(cp));

const doc = S.parseChordPro(cp);
eq("parse: meta", [doc.meta.title, doc.meta.artist, doc.meta.capo, doc.meta.key], ["Example song", "Nobody", 3, "G"]);
eq("parse: section names", doc.sections.map((s) => s.name), ["Intro", "Verse 1", "Chorus"]);
const v1 = doc.sections[1].lines.filter((l) => l.type === "lyric");
eq("parse: segments", v1[0].segs, [
  { chord: "G", text: "Morning light o" }, { chord: "Em7", text: "n the kitchen " }, { chord: "C", text: "floor," }]);
eq("parse: trailing chord has empty text", v1[1].segs[v1[1].segs.length - 1], { chord: "D", text: "" });
eq("chords in reading order", S.docChords(doc).map((c) => c.name).join(" "), "G Em7 C D G Em7 C G Em7 C D C D Em7");

/* ---- ChordPro paste is kept as ChordPro ---- */
const cpPaste = "{title: Example}\n{soc}\n[C]Hum it slow and [D]sing it through the [G]night\n{eoc}\n{c: repeat twice}";
check("ChordPro is recognised", S.looksLikeChordPro(cpPaste));
check("chords over lyrics are not ChordPro", !S.looksLikeChordPro(paste));
const d2 = S.parseChordPro(S.importText(cpPaste));
eq("ChordPro chorus", [d2.sections[0].name, d2.sections[0].kind], ["Chorus", "chorus"]);
eq("ChordPro comment", d2.sections[0].lines.length, 1);
check("comment outside the chorus", d2.sections[1].lines[0].type === "comment");
eq("lyric with leading text", S.parseLyricLine("so [Am]far"), [{ chord: null, text: "so " }, { chord: "Am", text: "far" }]);
const inline = "Some [Am]words and [C]more of them\nOther [G]words go [D]here";
check("inline chords without directives are ChordPro", S.looksLikeChordPro(inline));

/* ---- tabs stay as text blocks ---- */
const withTab = "[Riff]\ne|-----0-----|\nB|---1---1---|\nG|-0-------0-|\nAm\nwords after";
const d3 = S.parseChordPro(S.importText(withTab));
check("tab lines kept as a tab block", d3.sections[0].lines.filter((l) => l.type === "tab").length === 3);

/* ---- sheet to chart ---- */
const chart = S.sheetChart(doc, { source: "mine" });
eq("sheet chart sections", chart.sections.map((s) => [s.name, s.chords]), [
  ["Intro", "G | Em7 | C | D"], ["Verse 1", "G | Em7 | C | G | Em7 | C | D"], ["Chorus", "C | D | Em7"]]);
eq("sheet chart keeps capo and source", [chart.capo, chart.source], [3, "mine"]);

report("sheet");
