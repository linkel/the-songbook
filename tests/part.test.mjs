// Phase 5b: tunings, your own fingerings, guitar parts.
// Node: the step notation (rests, frets, techniques, mutes, and every library
// pattern parsing as before), tuning notes with and without octaves, shape
// search in open D and DADGAD, expanding a part (patterns filling a bar, {}
// repeating), part checks, the Pimapeggio link with written-out steps.
// Browser: Late July shows and plays open-D shapes; the tuning picker; your
// own shape, typed or tapped, used and labelled; the part editor (bar strip,
// pattern per bar, the step grid with a fret, repeat), Play picking the part
// with its frets; a detected part's "?" bars and Mark as checked; the part
// played along with the recording on its clock; parts from a bundle, which
// never replace yours; Late July's tab as the whole song, played and edited. Layout at 375×752, 375×630 and 1440×900, both flavours.
// node part.test.mjs [shotsDir]
import fs from "fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { BASE, check, eq, report, fixtureLibrary, layout } from "./lib.mjs";
import * as C from "../js/chords.js";
import * as P from "../js/patterns.js";
import * as T from "../js/tuning.js";
import * as Pt from "../js/part.js";
import * as Pk from "../js/picking.js";

C.setChordDb(JSON.parse(fs.readFileSync(new URL("../vendor/chords-db/guitar.json", import.meta.url), "utf8")));
const out = process.argv[2] || fileURLToPath(new URL("shots/part", import.meta.url));
fs.mkdirSync(out, { recursive: true });

/* ---- The step notation ---- */
{
  // The library parses exactly as Pimapeggio's old parser did: { f, s } only.
  const OLD = (str) => str.trim().split(/\s+/).map((step) => step.split("+").map((tok) => {
    const m = tok.match(/^([pima])([1-6]|B|A)?$/);
    return { f: m[1], s: m[2] ? (/\d/.test(m[2]) ? +m[2] : m[2]) : null };
  }));
  const same = P.PATTERN_DEFS.every((d) => JSON.stringify(P.parseSteps(d.steps)) === JSON.stringify(OLD(d.steps)));
  check(`notation: all ${P.PATTERN_DEFS.length} library patterns parse as before`, same);
  eq("notation: a rest is an empty step", P.parseSteps("p - i"), [[{ f: "p", s: null }], [], [{ f: "i", s: null }]]);
  eq("notation: a fret", P.parseNote("m2@3"), { f: "m", s: 2, fret: 3 });
  eq("notation: hammer-on after the fret", P.parseNote("i3@2h4"), { f: "i", s: 3, fret: 2, tech: { type: "h", to: 4 } });
  eq("notation: pull-off, slides", ["io3", "m2/7", "a1\\5"].map((t) => P.parseNote(t).tech), [{ type: "o", to: 3 }, { type: "/", to: 7 }, { type: "\\", to: 5 }]);
  eq("notation: a muted thumb slap", P.parseNote("px"), { f: "p", s: null, mute: true });
  const text = "pB - pA+i - px m2@3 pA i3@2h4";
  eq("notation: text round-trips", P.stepsText(P.parseSteps(text)), text);
  check("notation: rejects junk", ["q", "p7", "i@", "mh", "a1@3z"].every((t) => { try { P.parseNote(t); return false; } catch (e) { return true; } }));
  check("notation: frets and techniques mark a transcription", ["m2@3", "i3h5", "ao2", "p/7", "i\\3"].every(P.isTranscribed) && !P.PATTERN_DEFS.some((d) => P.isTranscribed(d.steps)) && !P.isTranscribed("pB - px pA+i"));
  // A note's sound: its own fret, the technique's second note.
  const D = P.parseVoicing("D", "xx0232");
  eq("notation: i3@4 on D is string 3, fret 4 (B3)", (({ string, fret, midi }) => [string, fret, midi])(P.noteSound(P.parseNote("i3@4"), D, { i: 3, m: 2, a: 1 })), [3, 4, 59]);
  eq("notation: and its hammer-on", P.noteSound(P.parseNote("i3@2h4"), D, { i: 3, m: 2, a: 1 }).to, { type: "h", fret: 4, midi: 59 });
}

/* ---- Tunings ---- */
{
  eq("tuning: open D without octaves", T.parseTuning("D A D F# A D"), [38, 45, 50, 54, 57, 62]);
  eq("tuning: with octaves", T.parseTuning("D2 A2 D3 F#3 A3 D4"), [38, 45, 50, 54, 57, 62]);
  eq("tuning: open C reaches down to C2", T.parseTuning("C G C G C E"), [36, 43, 48, 55, 60, 64]);
  eq("tuning: half step down, flats", T.parseTuning("Eb Ab Db Gb Bb Eb"), [39, 44, 49, 54, 58, 63]);
  eq("tuning: open strings by string number", T.tuningFrom({ notes: "DADGAD" === "x" ? "" : "D A D G A D" }).open, [null, 62, 57, 55, 50, 45, 38]);
  check("tuning: wrong count or note refused", ["D A D", "D A D F# A H"].every((n) => { try { T.parseTuning(n); return false; } catch (e) { return true; } }));
  eq("tuning: names from presets", [T.tuningFrom({ notes: "D A D F# A D" }).name, T.tuningFrom({ notes: "D G D G B D" }).name, T.tuningFrom(null).name], ["Open D", "Open G", "Standard"]);
  check("tuning: standard is standard", T.tuningFrom({ notes: "E A D G B E" }).standard && !T.tuningFrom({ notes: "D A D G B E" }).standard);
  eq("tuning: chordMidi in open D", P.chordMidi(P.parseVoicing("D", "000000"), 6, 0, T.tuningFrom({ notes: "D A D F# A D" }).open), 38);
}

/* ---- Shapes in open D and DADGAD ---- */
{
  const od = T.tuningFrom({ notes: "D A D F# A D" }), dg = T.tuningFrom({ notes: "D A D G A D" });
  eq("shapes: D in open D is all open strings", C.bestVoicing("D", null, od).spec, "000000");
  const plays = (name, t) => C.voicingsFor(name, null, t).every((v) => C.voicingMidi(v.frets, 0, t).every((m) => C.chordPcs(name).includes(m % 12)));
  check("shapes: every open-D shape plays only chord tones", ["D", "G", "A", "Bm", "Em", "F#m", "A7", "D/F#"].every((n) => plays(n, od)));
  check("shapes: every DADGAD shape plays only chord tones", ["D", "G", "A", "Bm", "Em", "Dsus4"].every((n) => plays(n, dg)));
  const has = (name, t) => { const v = C.bestVoicing(name, null, t); const pcs = new Set(C.voicingMidi(v.frets, 0, t).map((m) => m % 12)); return C.chordPcs(name).every((p) => pcs.has(p)); };
  check("shapes: and all of its notes (open D, DADGAD)", ["G", "A", "Bm"].every((n) => has(n, od) && has(n, dg)));
  eq("shapes: D/F# in open D has F# in the bass", C.voicingMidi(C.bestVoicing("D/F#", null, od).frets, 0, od)[0] % 12, 6);
  eq("shapes: your shape comes first in any tuning", C.bestVoicing("G", { G: "x5x55x" }, od).spec, "x5x55x");
  eq("shapes: standard tuning unchanged", C.bestVoicing("G").spec, C.bestVoicing("G", null, T.STANDARD).spec);
  const cap = C.suggestCapo(["D", "G", "A", "D"], { tuning: od });
  eq("shapes: capo in open D for D G A is 0", cap.capo, 0);
}

/* ---- Parts ---- */
{
  const ex = Pt.expandPart({ source: "mine", bars: [{ pattern: "travis" }, {}, { pattern: "pim" }, { steps: "pB - pA - pB - pA -", shape: "x00232" }, {}] }, 6, 4);
  eq("part: a library pattern fills the bar (travis: 8 eighths)", P.stepsText(ex[0].steps), "pB i pA m pB i pA m");
  eq("part: {} repeats the bar before", [ex[1].kind, P.stepsText(ex[1].steps)], ["repeat", "pB i pA m pB i pA m"]);
  eq("part: a triplet pattern fills 12 steps", ex[2].steps.length, 12);
  eq("part: written-out steps and a shape", [P.stepsText(ex[3].steps), ex[3].shape], ["pB - pA - pB - pA -", [[null, 0, 0, 2, 3, 2]]]);
  eq("part: the shape carries into a repeat", ex[4].shape, [[null, 0, 0, 2, 3, 2]]);
  eq("part: bars past the end repeat the last", [ex[5].kind, ex[5].steps.length], ["repeat", 8]);
  const own = Pt.expandPart({ source: "mine", patterns: { a: "pB i pA m" }, bars: [{ pattern: "a" }] }, 1, 3);
  eq("part: the song's own pattern, in eighths, fills a 3/4 bar", P.stepsText(own[0].steps), "pB i pA m pB i");
  eq("part: a waltz pattern in 3/4", Pt.expandPart({ source: "mine", bars: [{ pattern: "waltz" }] }, 1, 3)[0].steps.length, 3);
  eq("part: a broken bar says why", Pt.expandPart({ source: "mine", bars: [{ pattern: "nope" }] }, 1)[0].error, 'No pattern "nope".');
  eq("part: checks", Pt.checkPart({ source: "detected", bars: [{ pattern: "x" }, { steps: "q" }, { shape: "abc" }] }).length, 4);
  check("part: a transcription stays on the device", Pt.isTranscription({ bars: [{ steps: "pB i3@2 pA m" }] }) && !Pt.isTranscription({ bars: [{ pattern: "travis", shape: "x00232" }], patterns: { a: "pB - pA+i" } }));
  eq("part: where the pattern changes", Pt.patternRuns(Pt.expandPart({ source: "mine", bars: [{ pattern: "travis" }, {}, { pattern: "pima" }, { steps: "p i m a" }] }, 4)).map((r) => [r.from, r.to, r.label]), [[0, 1, "travis"], [2, 2, "pima"], [3, 3, "written"]]);
  const checked = Pt.checkedPart({ source: "detected", detector: "x", bars: [{ pattern: "travis", confidence: 0.4, match: { pattern: "travis", hits: 7, of: 8 } }] });
  eq("part: Mark as checked makes it yours, and drops the guesses", [checked.source, checked.checkedFrom, checked.bars[0]], ["mine", "x", { pattern: "travis" }]);
  eq("part: editing a detected part keeps it detected until checked", Pt.editedPart({ source: "detected", bars: [] }).source, "detected");
  eq("part: one from a tab says where it's from", [Pt.checkPart({ source: "web", bars: [] }).length, Pt.checkPart({ source: "web", from: "Songsterr", url: "https://example.com/t", bars: [{ steps: "p6@0+m@9 p4@0 i@1o0 -" }] }).length], [1, 0]);
  const ed = Pt.editedPart({ source: "web", from: "Songsterr", url: "https://example.com/t", bars: [] });
  eq("part: editing a tab's part makes it yours, saying which tab", [ed.source, ed.editedFrom, ed.from, ed.url], ["mine", "Songsterr", undefined, undefined]);
  const bars = [{ chords: [{ name: "D", spec: "000000" }] }];
  const link = new URL(Pk.pimapeggioLink({ steps: P.parseSteps("pB i3@2h4 pA m - pB i pA"), beats: 4, bars, capo: 0, bpm: 90, name: "Late July · Part A, bar 2",
    tuning: T.tuningFrom({ notes: "D A D F# A D" }) }, "https://example.com/pimapeggio/"));
  eq("part: Pimapeggio gets written-out steps and the tuning", [link.searchParams.get("steps"), link.searchParams.get("pattern"), link.searchParams.get("tuning")], ["pB i3@2h4 pA m - pB i pA", null, "D A D F# A D"]);
}

/* ---- In the browser ---- */
const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });

async function newPage(w = 375, h = 752, scheme = "dark") {
  const phone = w < 860;
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: scheme });
  const lib = fixtureLibrary();
  await context.route("**/private/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(lib) }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector("html[data-ready]", { timeout: 90000 });
  return { context, page, errors };
}
async function section(name, fn) {
  if (process.env.DEBUG) console.log("section:", name, new Date().toISOString().slice(11, 19));
  try { await fn(); } catch (e) { check(`${name}: ran to the end`, false, e.message.split("\n").slice(0, 3).join(" | ")); }
}
async function show(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(400);
}
async function until(page, fn, arg, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting: " + fn.toString().slice(0, 120));
    await page.waitForTimeout(200);
  }
}
// Layout once animations have settled (views and popovers fade and scale in).
const settled = async (page, label) => { await page.waitForTimeout(450); await layout(page, label); };
const playLog = (page) => page.evaluate(() => window.songbook.getPlayer().log.map((e) => ({ type: e.type, bar: e.bar, chord: e.chord, midis: e.midis, part: !!e.part })));

// A made-up song with a chart of two sections, in standard tuning.
async function seed(page, { timed = false } = {}) {
  return page.evaluate(async (timed) => {
    const L = await import("/js/library.js");
    const { invalidateSongs } = await import("/js/songs.js");
    const id = await L.addManualSong("Part Song", "Nobody");
    const chart = { id, title: "Part Song", artist: "Nobody", type: "song", key: "G", capo: 0, time: "4/4", tempo: 100, style: "fingerpicked", strum: null, voicings: {},
      sections: [{ name: "Verse", chords: "G | C | D | G" }, { name: "Chorus", chords: "Em | C | D | D" }], form: ["Verse", "Chorus"],
      source: "mine", detector: null, confidence: "high", sources: [], notes: "Made up for the tests." };
    if (timed) {
      chart.source = "detected"; chart.detector = "tests";
      chart.beats = []; chart.bars = [];
      for (let b = 0; b < 8; b++) { chart.bars.push({ t: 1 + b * 2.4, n: 4, chords: [["G", "C", "D", "G", "Em", "C", "D", "D"][b]] }); for (let k = 0; k < 4; k++) chart.beats.push(1 + b * 2.4 + k * 0.6); }
      chart.analysis = { segments: [{ name: "Verse", bars: [0, 3] }, { name: "Chorus", bars: [4, 7] }], bpb: 4, phase: 0, bpm: 100, tuning: 0 };
    }
    await L.saveChart(chart);
    if (timed) {
      const gen = await import("/tests/gen-song.js");
      const Rec = await import("/js/recordings.js");
      const { signal } = await gen.renderSong({ bpm: 100, bars: ["G", "C", "D", "G", "Em", "C", "D", "D"], repeat: 1, lead: 1 });
      await Rec.saveRecording(id, new File([gen.wavBytes(signal)], "part-song.wav", { type: "audio/wav" }));
    }
    invalidateSongs();
    return id;
  }, timed);
}

/* ---- Late July: open-D shapes, shown and played ---- */
await section("late july", async () => {
  const { context, page, errors } = await newPage();
  await context.route("**/songs/audio/**", (r) => r.fulfill({ status: 404, body: "" }));
  await show(page, "#/song/late-july/chords");
  await page.waitForSelector(".tuning-chip");
  check("late july: the tuning shows: Open D", (await page.textContent(".tuning-chip")).includes("Open D"));
  const shapes = await page.evaluate(async () => {
    const C = await import("/js/chords.js"), T = await import("/js/tuning.js");
    const t = T.tuningFrom({ notes: "D A D F# A D" });
    return [...document.querySelectorAll(".boxes .box[data-chord]")].map((b) => [b.dataset.chord, (C.bestVoicing(b.dataset.chord, null, t) || {}).spec, b.querySelector("svg") && b.querySelector("svg").getAttribute("aria-label")]);
  });
  const d = shapes.find((x) => x[0] === "D");
  check("late july: D is drawn as the open-D shape (000000)", d && d[2].includes("000000"), JSON.stringify(d));
  check("late july: every box uses its open-D shape", shapes.every(([name, spec, label]) => !spec || (label || "").includes(spec)), JSON.stringify(shapes.slice(0, 5)));
  await page.locator("[data-act=play]:visible").first().click();
  // The song starts with two bars of no chord (N.C.): wait for the first strum.
  await until(page, () => window.songbook.getPlayer().log.some((e) => e.type === "strum"), null, 15000);
  const pl = await page.evaluate(async () => {
    const C = await import("/js/chords.js");
    const s = window.songbook.getPlayer().session;
    const d = s.bars.flatMap((b) => b.chords).find((c) => c.name === "D");
    const first = window.songbook.getPlayer().log.find((e) => e.type === "strum");
    const ch = s.bars.flatMap((b) => b.chords).find((c) => c.name === first.chord);
    return { open: s.open, d: d && d.frets, first: first.midis, want: C.voicingMidi(ch.frets, 0, s.open) };
  });
  eq("late july: Play plays in open D's strings", pl.open, [null, 62, 57, 54, 50, 45, 38]);
  eq("late july: D is the open-D shape", pl.d, [0, 0, 0, 0, 0, 0]);
  eq("late july: the first strum sounds its open-D shape", pl.first, pl.want);
  await page.locator("[data-act=play]:visible").first().click();
  await page.screenshot({ path: `${out}/late-july-chords-375.png` });
  check("late july: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Late July's tab, the whole song at once ---- */
for (const [w, h, scheme] of [[375, 752, "dark"], [1440, 900, "light"]]) {
  await section(`whole song ${w}`, async () => {
    const { context, page, errors } = await newPage(w, h, scheme);
    await context.route("**/songs/audio/**", (r) => r.fulfill({ status: 404, body: "" }));
    await show(page, "#/song/late-july/picking");
    await page.waitForSelector("[data-pick-sec='all']");
    await page.click("[data-pick-sec='all']");
    await page.waitForSelector(".pick-card.whole");
    const st = await page.evaluate(async () => {
      const c = await fetch("songs/late-july.json").then((r) => r.json());
      const nums = [...document.querySelectorAll(".pick-card.whole .tab-bar .tnum")].map((t) => +t.textContent);
      return { bars: c.bars.length, form: c.form.length, tabs: document.querySelectorAll(".pick-card.whole .tab-bar svg.tab-svg").length,
        heads: [...document.querySelectorAll(".whole-sec .sec-name")].map((e) => e.textContent), nums: [nums[0], nums[nums.length - 1]] };
    });
    eq(`whole ${w}: every bar of the song, numbered through, a heading per section played`, [st.tabs, st.nums, st.heads.length], [st.bars, [1, st.bars], st.form]);
    await settled(page, `whole song ${w}x${h} ${scheme}`);
    await page.screenshot({ path: `${out}/whole-${w}-${scheme}.png` });
    if (w < 860) {
      await page.click("[data-pview=notation]");
      await page.waitForSelector(".pick-card.whole svg.notation");
      check("whole: notation too", (await page.$$(".pick-card.whole svg.notation")).length > 100);
      await page.click("[data-pview=tab]");
      await page.waitForSelector(".pick-card.whole svg.tab-svg");
      // Play goes through the song, lighting the bar that plays.
      await page.locator("[data-act=play]:visible").first().click();
      await page.waitForFunction(() => document.querySelector(".pick-card.whole .tab-bar.on"), null, { timeout: 8000 });
      const lit = await page.evaluate(() => { const e = document.querySelector(".pick-card.whole .tab-bar.on"); return [e.dataset.form, e.dataset.pbar]; });
      eq("whole: Play lights the song's first bar", lit, ["0", "0"]);
      const n = await page.evaluate(() => window.songbook.getPlayer().session.bars.length);
      eq("whole: Play has every bar of the song", n, st.bars);
      await page.locator("[data-act=play]:visible").first().click();
      // A bar opens its section's editor.
      await page.click(".pick-card.whole .tab-bar[data-form='2'][data-pbar='1']");
      await page.waitForSelector(".popover .step-grid, .popover");
      check("whole: tapping a bar edits it", (await page.textContent(".popover")).includes("Bar 2"));
    }
    check(`whole ${w}: no page errors`, errors.length === 0, errors.join("; "));
    await context.close();
  });
}

/* ---- The tuning picker, and your own shapes ---- */
await section("tuning and shapes", async () => {
  const { context, page, errors } = await newPage();
  const id = await seed(page);
  await show(page, `#/song/${id}/chords`);
  await page.locator("[data-act=tuning]:visible").first().click();
  await page.waitForSelector(".popover [data-tune]");
  await page.screenshot({ path: `${out}/tuning-picker-375.png` });
  await page.click(".popover [data-tname='Drop D']");
  await page.waitForTimeout(300);
  const prefs = await page.evaluate((id) => import("/js/library.js").then((L) => L.loadPrefs(id, null)), id);
  eq("tuning: Drop D kept as yours for this song", prefs.tuning, { name: "Drop D", notes: "D A D G B E", source: "mine" });
  await page.click(".popover [data-close]");
  check("tuning: the chip says Drop D", (await page.textContent(".tuning-chip")).includes("Drop D"));
  const gBox = await page.$eval(".boxes .box[data-chord='G'] svg", (s) => s.getAttribute("aria-label"));
  check("tuning: G in Drop D uses a Drop-D shape (low string at fret 5)", /\b5/.test(gBox) && !gBox.includes("320003"), gBox);
  // Your own shape for D, typed.
  await page.click(".boxes .box[data-chord='D']");
  await page.waitForSelector(".popover .own-shape");
  await page.click(".popover .own-shape summary");
  await page.fill(".popover .own-spec[data-name='D']", "x00232");
  await page.click(".popover [data-own='D']");
  await page.waitForTimeout(400);
  const p2 = await page.evaluate((id) => import("/js/library.js").then((L) => L.loadPrefs(id, null)), id);
  eq("shapes: your D is kept", p2.voicings.D, "x00232");
  check("shapes: and labelled yours", (await page.textContent(".popover")).includes("yours"));
  // Tap frets on the grid: string 1 at fret 3 (x00233).
  await page.click(".popover .own-shape summary").catch(() => {});
  const grid = await page.$(".popover .fret-picker");
  if (grid) {
    await page.click(".popover .fret-picker .fp-cell[data-s='5'][data-f='3']");
    check("shapes: tapping a fret updates the shape", (await page.inputValue(".popover .own-spec[data-name='D']")) === "x00233", await page.inputValue(".popover .own-spec[data-name='D']"));
  }
  await page.screenshot({ path: `${out}/own-shape-375.png` });
  await page.click(".popover [data-close]");
  check("shapes: the box says yours", await page.$eval(".boxes .box[data-chord='D']", (b) => b.classList.contains("yours") && b.textContent.includes("yours")));
  await page.locator("[data-act=play]:visible").first().click();
  await page.waitForTimeout(800);
  const pl = await page.evaluate(() => { const s = window.songbook.getPlayer().session; return { open: s.open, d: s.bars.flatMap((b) => b.chords).find((c) => c.name === "D").frets }; });
  await page.locator("[data-act=play]:visible").first().click();
  eq("shapes: Play uses your D (x00232)", pl.d, [null, 0, 0, 2, 3, 2]);
  eq("shapes: in Drop D", pl.open, [null, 64, 59, 55, 50, 45, 38]);
  check("tuning and shapes: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- The part editor ---- */
for (const [w, h, scheme] of [[375, 752, "dark"], [375, 630, "light"], [1440, 900, "light"]]) {
  await section(`part editor ${w}x${h}`, async () => {
    const { context, page, errors } = await newPage(w, h, scheme);
    const id = await seed(page);
    const tag = `${w}x${h} ${scheme === "dark" ? "Mocha" : "Latte"}`;
    await show(page, `#/song/${id}/picking`);
    await page.waitForSelector("[data-act=part-new]");
    await settled(page, `picking (no part) ${tag}`);
    await page.click("[data-act=part-new]");
    await page.waitForSelector(".part-strip .pbar");
    eq(`${tag}: a part starts empty (nothing guessed)`, await page.evaluate((id) => import("/js/part.js").then((P) => P.loadParts(id)).then((x) => x.Verse), id), { source: "mine", bars: [{ steps: "- - - - - - - -" }] });
    await settled(page, `picking with a part ${tag}`);
    await page.screenshot({ path: `${out}/part-strip-${w}x${h}-${scheme}.png` });
    // Bar 1: Travis from the library.
    await page.click(".pbar[data-pbar='0']");
    await page.waitForSelector(".popover [data-view]");
    await page.click(".popover [data-view='pattern']");
    await page.waitForSelector(".popover .lib-list");
    await page.click(".popover .lib-list summary");
    await page.click(".popover .lib-list [data-pattern='travis']");
    await page.waitForTimeout(300);
    // Bar 2: written out, with a fret and a hammer-on.
    await page.click(".popover [data-next]");
    await page.waitForSelector(".popover [data-view='steps']");
    await page.click(".popover [data-view='steps']");
    await page.waitForSelector(".popover .sg-c");
    await settled(page, `step grid ${tag}`);
    // It starts from what the bar plays now (Travis, repeated): clear it to write it afresh.
    eq(`${tag}: written out from what the bar played`, await page.evaluate((id) => import("/js/part.js").then((P) => P.loadParts(id)).then((x) => x.Verse.bars[1].steps), id), "pB i pA m pB i pA m");
    await page.click(".popover [data-grid='clear']");
    await page.waitForTimeout(200);
    await page.click(".popover .sg-c[data-st='0'][data-s='5']");     // p on the C shape's bass (string 5)
    await page.click(".popover .sg-c[data-st='2'][data-s='3']");     // i on string 3
    await page.click(".popover .sg-c[data-st='4'][data-s='4']");     // p on string 4: the alternate bass
    await page.click(".popover .sg-c[data-st='6'][data-s='2']");     // m on string 2
    await page.click(".popover .sg-c[data-st='6'][data-s='2']");     // tap again: a
    await page.click(".popover .sg-c[data-st='2'][data-s='3']");     // select i again... (cycles to m)
    await page.click(".popover .sg-c[data-st='2'][data-s='3']");     // ...a
    await page.click(".popover .sg-c[data-st='2'][data-s='3']");     // ...gone
    await page.click(".popover .sg-c[data-st='2'][data-s='3']");     // i again, selected
    await page.waitForSelector(".popover .note-detail");
    await page.click(".popover .note-detail [data-fret='1']");      // shape's fret 0 -> 1? (C shape: string 3 open) -> @1
    await page.click(".popover .note-detail [data-fret='1']");      // @2
    await page.click(".popover .note-detail [data-tech='h']");      // hammer to 4
    await page.screenshot({ path: `${out}/step-grid-${w}x${h}-${scheme}.png` });
    let parts = await page.evaluate((id) => import("/js/part.js").then((P) => P.loadParts(id)), id);
    eq(`${tag}: bar 1 plays Travis`, parts.Verse.bars[0], { pattern: "travis" });
    eq(`${tag}: bar 2 written out, with the fret and the hammer-on`, parts.Verse.bars[1].steps, "pB - i@2h4 - pA - a2 -");
    // Repeat bar 2 over the next bar, then copy it to bar 4.
    await page.click(".popover [data-repeat='1']");
    await page.waitForTimeout(300);
    await page.click(".popover [data-copy]");
    await page.click(".popover [data-next]");
    await page.click(".popover [data-next]");
    await page.click(".popover [data-paste]");
    await page.waitForTimeout(300);
    await page.click(".popover [data-close]");
    parts = await page.evaluate((id) => import("/js/part.js").then((P) => P.loadParts(id)), id);
    eq(`${tag}: repeat and paste`, [parts.Verse.bars[2], parts.Verse.bars[3]], [{}, { steps: "pB - i@2h4 - pA - a2 -" }]);
    const strip = await page.$$eval(".pbar .pl", (els) => els.map((e) => e.textContent.trim()));
    eq(`${tag}: the strip shows each bar's pattern`, strip, ["travis", "written", "″", "written"]);
    check(`${tag}: and where it changes`, await page.$eval(".pbar[data-pbar='1']", (e) => e.classList.contains("change")));
    // Play picks the part bar by bar, with the fret.
    await page.locator("[data-act=play]:visible").first().click();
    await page.waitForTimeout(3600);
    const log = await playLog(page);
    await page.locator("[data-act=play]:visible").first().click();
    const bar2 = log.filter((e) => e.type === "step" && e.bar === 1 && e.part);
    eq(`${tag}: Play: bar 2's steps, with i on fret 2 (A3) and its rest`, bar2.slice(0, 4).map((e) => e.midis), [[48], [], [57], []]);
    check(`${tag}: Play: bar 1 is Travis on G`, log.filter((e) => e.bar === 0).slice(0, 4).map((e) => e.midis.join("+")).join(" ") === "43 55 50 59", JSON.stringify(log.filter((e) => e.bar === 0).slice(0, 4)));
    const link = new URL(await page.getAttribute("#pima-link", "href"), "http://x/");
    check(`${tag}: Pimapeggio opens on the bar shown`, link.searchParams.has("pattern") || link.searchParams.has("steps"), link.search);
    check(`${tag}: no page errors`, errors.length === 0, errors.join("; "));
    await context.close();
  });
}

/* ---- A detected part: "?" bars, Mark as checked; parts from a bundle ---- */
await section("detected part", async () => {
  const { context, page, errors } = await newPage();
  const id = await seed(page);
  await page.evaluate(async (id) => {
    const Pt = await import("/js/part.js");
    await Pt.saveSectionPart(id, "Chorus", { source: "detected", detector: "tests", fingers: "inferred", patterns: { a: { steps: "pB i pA m pB i pA m@3", npb: 2 } },
      bars: [{ pattern: "travis", confidence: 0.9, match: { pattern: "travis", hits: 8, of: 8 } }, { pattern: "a", confidence: 0.4 }, { steps: "pB - i3@2 - pA - m -", confidence: 0.7 }, {}] });
  }, id);
  await show(page, `#/song/${id}/chords`);
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, `#/song/${id}/picking`);
  await page.click("[data-pick-sec='1']");
  await page.waitForSelector(".pbar");
  check("detected: labelled detected, check by ear", (await page.textContent(".pick-card")).includes("Detected part"));
  check("detected: says the fingers are inferred, not heard", (await page.textContent("#view-song")).includes("inferred, not heard"));
  eq("detected: the unsure bar shows ?", await page.$$eval(".pbar.unsure", (els) => els.map((e) => e.dataset.pbar)), ["1"]);
  await page.screenshot({ path: `${out}/detected-part-375.png` });
  // Mostly written out (its own pattern, a bar of steps): shown as tab, the whole section.
  eq("tab: a written-out part opens as tab", await page.$eval("[data-pview].on", (e) => e.dataset.pview), "tab");
  eq("tab: a bar each, the empty one repeating the last", await page.$$eval(".tab-bar svg.tab-svg", (els) => els.length), 4);
  eq("tab: bar 3's frets in order (D: the bass, i3@2 on the G string, the A string, m)", await page.$$eval(".tab-bar[data-pbar='2'] .tfret", (els) => els.map((e) => e.textContent)), ["0", "2", "2", "3"]);
  check("tab: the chord over each bar", (await page.textContent(".tab-bar[data-pbar='0']")).includes("Em"));
  await settled(page, "tab view");
  await page.click("[data-pview=notation]");
  await page.waitForSelector(".tab-bar svg.notation");
  eq("notation: a staff per bar", await page.$$eval(".tab-bar svg.notation", (els) => els.length), 4);
  await settled(page, "notation view");
  await page.click("[data-pview=picking]");
  await page.waitForSelector(".part-strip .pbar");
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, `#/song/${id}/picking`);
  await page.click("[data-pick-sec='1']");
  await page.waitForSelector(".pbar");
  eq("part view: your choice is kept", await page.$eval("[data-pview].on", (e) => e.dataset.pview), "picking");
  await page.click("[data-act=part-check]");
  await page.waitForTimeout(400);
  const p = await page.evaluate((id) => import("/js/part.js").then((P) => P.loadParts(id)).then((x) => x.Chorus), id);
  eq("detected: Mark as checked makes it yours", [p.source, p.checkedFrom, p.bars[1]], ["mine", "tests", { pattern: "a" }]);
  // A bundle's part.json never replaces a part of yours.
  const n = await page.evaluate(async (id) => {
    const B = await import("/js/bundle.js");
    return B.importParts({ tuning: "E A D G B E", capo: 0, sections: {
      Chorus: { source: "detected", detector: "pc", fingers: "inferred", bars: [{ pattern: "pima" }] },
      Verse: { source: "detected", detector: "pc", fingers: "inferred", bars: [{ pattern: "pima", confidence: 0.5 }] },
      Nope: { source: "detected", detector: "pc", bars: [{ pattern: "pima" }] } } }, id, ["Verse", "Chorus"]);
  }, id);
  const after = await page.evaluate((id) => import("/js/part.js").then((P) => P.loadParts(id)), id);
  eq("bundle parts: one new section, yours kept, unknown section skipped", [n, after.Chorus.source, after.Verse.source, !!after.Nope], [1, "mine", "detected", false]);
  check("detected part: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Finding the part on the PC for a song analysed there (a stand-in helper) ---- */
await section("part from the pc", async () => {
  const { context, page, errors } = await newPage();
  const id = await seed(page, { timed: true });
  await page.evaluate(async (id) => {
    const L = await import("/js/library.js");
    const c = await L.get("charts", id);
    c.analysis.bundle = { created: "2026-10-14T00:00:00Z", job: "job-0", stems: ["guitar", "other"] };
    await L.saveChart(c);
    localStorage.setItem("songbook-helper-url", "http://127.0.0.1:8799");
  }, id);
  const zip = Buffer.from(await page.evaluate(async () => {
    const { makeZip } = await import("/js/zip.js");
    const part = { source: "detected", detector: "stand-in", fingers: "inferred", bars: [{ pattern: "travis", confidence: 0.8, match: { pattern: "travis", hits: 8, of: 8 } }, { steps: "pB i3@2 pA m pB i pA m", confidence: 0.5 }] };
    const z = await makeZip([
      { name: "bundle.json", data: JSON.stringify({ app: "songbook", kind: "bundle", version: 1, partsOnly: true, files: ["part.json"], stems: [] }) },
      { name: "part.json", data: JSON.stringify({ detector: "stand-in", tuning: "E A D G B E", capo: 0, sections: { Verse: part } }) }]);
    return Array.from(new Uint8Array(await z.arrayBuffer()));
  }));
  let asked = null, polls = 0;
  const cors = { "Access-Control-Allow-Origin": "*" };
  await context.route("http://127.0.0.1:8799/**", async (r) => {
    const url = r.request().url();
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST" } });
    if (url.endsWith("/ping")) return r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, helper: "songbook", analysis: { available: true, gpu: "Test GPU" } }) });
    if (new URL(url).pathname === "/analyze") { asked = (r.request().postDataBuffer() || Buffer.alloc(0)).toString("latin1"); return r.fulfill({ status: 202, contentType: "application/json", headers: cors, body: JSON.stringify({ id: "job-p", state: "queued" }) }); }
    if (url.includes("/jobs/job-p")) { polls++; return r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ id: "job-p", state: polls > 2 ? "done" : "running", steps: [{ key: "parts", label: "Guitar part", p: polls / 3 }], progress: polls / 3 }) }); }
    if (url.includes("/bundle/job-p.zip")) return r.fulfill({ status: 200, contentType: "application/zip", headers: cors, body: zip });
    return r.fulfill({ status: 404, headers: cors, body: "{}" });
  });
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, `#/song/${id}/picking`);
  await page.waitForSelector("[data-act=part-pc]");
  await page.click("[data-act=part-pc]");
  await until(page, (id) => import("/js/part.js").then((P) => P.loadParts(id)).then((x) => !!x.Verse), id);
  check("pc part: asked for just the part, on the earlier job, with the tuning and capo", /name="job"\r\n\r\njob-0/.test(asked) && /name="parts"\r\n\r\nguitar/.test(asked) && /name="capo"\r\n\r\n0/.test(asked) && !/name="file"/.test(asked));
  const v = await page.evaluate((id) => import("/js/part.js").then((P) => P.loadParts(id)).then((x) => x.Verse), id);
  eq("pc part: kept as detected, on the device", [v.source, v.detector, v.bars.length], ["detected", "stand-in", 2]);
  const c = await page.evaluate((id) => import("/js/library.js").then((L) => L.get("charts", id)), id);
  eq("pc part: the chart is left as it was", c.detector, "tests");
  await page.waitForSelector(".part-strip");
  check("pc part: Picking mode shows the detected part", (await page.textContent(".pick-card")).includes("Detected part"));
  check("pc part: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- The part along with the recording, on its clock ---- */
await section("play along", async () => {
  const { context, page, errors } = await newPage(1440, 900, "light");
  const id = await seed(page, { timed: true });
  await page.evaluate(async (id) => {
    const Pt = await import("/js/part.js");
    await Pt.saveSectionPart(id, "Verse", { source: "mine", bars: [{ pattern: "travis" }] });
  }, id);
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, `#/song/${id}/picking`);
  await page.waitForSelector("[data-act=part-along]");
  await settled(page, "picking with play-along 1440x900 Latte");
  await page.click("[data-act=part-along]");
  await until(page, () => { const s = window.songbook.playerState(); return s && s.partLayer && s.engine && s.engine.playing && s.partNotes.length > 4; }, null, 30000);
  const st = await page.evaluate(() => { const s = window.songbook.playerState(); return { notes: s.partNotes, rate: s.engine.currentRate }; });
  // Bar 1 (G) starts at 1.0 s: travis's 8 eighths over 2.4 s, so a note every 0.3 s.
  const songTimes = st.notes.map((n) => n.song).sort((a, b) => a - b).slice(0, 4);
  eq("play along: the part's notes fall on the bar's eighths", songTimes.map((t) => Math.round(t * 1000) / 1000), [1, 1.3, 1.6, 1.9]);
  eq("play along: G's bass first, in sounding pitch", st.notes.sort((a, b) => a.song - b.song)[0].midi, 43);
  await page.click("[data-ab='part']");
  const mix = await page.evaluate(() => window.songbook.playerState().set.mix);
  check("play along: A/B, the part only: the recording is off, the app guitar on", !mix.recording.on && mix.guitar.on, JSON.stringify(mix));
  await page.click("[data-ab='both']");
  await page.screenshot({ path: `${out}/play-along-1440.png` });
  await page.click("[data-act=part-along]");
  check("play along: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

await browser.close();
report("part");
