// Phase 5a: analysis on the PC helper.
// 1. Bundle checks (node): the manifest and chart are validated before import.
// 2. The phone's side, against a stand-in helper (nothing real is sent): the
//    recording and your sheet's lyric lines go up, the job's steps show, the
//    bundle comes back and is kept (chart labelled with its detector, stems in
//    OPFS, lyric timing), the review shows the PC's draft, and the Player's
//    mixer gets a row per stem through one stretcher (mono stems on a phone,
//    stereo on a computer), with Full mix / Stems switching. Screenshots.
// 3. With the real helper running (SONGBOOK_HELPER, or 127.0.0.1:8766 / 8765),
//    guitar parts (Phase 5b) on parts rendered by tests/gen-part.js, and
//    accuracy on songs rendered by the app's synth: tempo ±2 bpm (or ×2),
//    the key (or its relative), >= 85% of bars right as triads, the AABB form
//    found, and stems that add back up to the song, lined up within 1 ms.
//    Skipped (not failed) when no helper with analysis is reachable.
// node pc.test.mjs [shotsDir]
import { chromium } from "playwright-core";
import fs from "fs";
import { fileURLToPath } from "url";
import { BASE, check, eq, report, fixtureLibrary, EXAMPLE_SHEET, layout } from "./lib.mjs";
import { checkManifest, checkChart } from "../js/bundle.js";

const out = process.argv[2] || fileURLToPath(new URL("shots/pc", import.meta.url));
fs.mkdirSync(out, { recursive: true });

/* ---- 1. Bundle checks ---- */
{
  const m = { app: "songbook", kind: "bundle", version: 1, files: ["chart.json", "stems/vocals.m4a"], stems: [{ name: "vocals", file: "stems/vocals.m4a" }] };
  check("bundle: a good manifest passes", (() => { try { checkManifest(m); return true; } catch (e) { return false; } })());
  const bad = (x, why) => check(`bundle: refuses ${why}`, (() => { try { checkManifest(x); return false; } catch (e) { return true; } })());
  bad({ ...m, app: "other" }, "another app's zip");
  bad({ ...m, version: 99 }, "a newer bundle version");
  bad({ ...m, files: ["chart.json"] }, "a stem that isn't in the zip");
  bad({ ...m, stems: [{ name: "kazoo", file: "stems/vocals.m4a" }] }, "an unknown stem");
  const chart = { sections: [{ name: "Part A", chords: "G | D" }], form: ["Part A", "Nope"], beats: [0, 0.5], source: "detected", detector: "x",
    bars: [{ t: 0, chords: ["G"] }, { t: 2, chords: ["D"] }], sources: [{ label: "sneaky", url: "https://example.org" }] };
  const c = checkChart(chart);
  eq("bundle: chart form keeps only real sections", c.form, ["Part A"]);
  eq("bundle: a detected chart carries no web sources", c.sources, []);
  const refuses = (x, why) => check(`bundle: chart refused when ${why}`, (() => { try { checkChart(x); return false; } catch (e) { return true; } })());
  refuses({ ...chart, source: "web" }, "it doesn't say detected");
  refuses({ ...chart, detector: null }, "it doesn't name its detector");
  refuses({ ...chart, bars: [{ t: 0, chords: ["H#9q"] }] }, "a chord can't be read");
}

const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });

async function newPage(w = 375, h = 752, scheme = "dark") {
  const phone = w < 860;
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: scheme });
  const lib = fixtureLibrary();
  await context.route("**/private/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(lib) }));
  await context.route("**/songs/audio/**", (r) => r.fulfill({ status: 404, body: "" }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector("html[data-ready]", { timeout: 90000 });
  return { context, page, errors };
}

async function section(name, fn) {
  try { await fn(); } catch (e) { check(`${name}: ran to the end`, false, e.message.split("\n").slice(0, 3).join(" | ")); }
}

// Poll an async check in the page (waitForFunction would take its promise as true).
async function until(page, fn, arg, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting: " + fn.toString().slice(0, 120));
    await page.waitForTimeout(250);
  }
}

async function show(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(350);
}

// A made-up song with a recording and a sheet (invented lyrics), no chart yet.
async function seed(page) {
  return page.evaluate(async (sheet) => {
    const gen = await import("/tests/gen-song.js");
    const L = await import("/js/library.js");
    const Rec = await import("/js/recordings.js");
    const { invalidateSongs } = await import("/js/songs.js");
    const { importText } = await import("/js/chordpro.js");
    const { signal, truth } = await gen.renderSong({ bpm: 100, bars: ["G", "Em", "C", "D"], repeat: 4 });
    const id = await L.addManualSong("PC Song", "Nobody");
    await Rec.saveRecording(id, new File([gen.wavBytes(signal)], "pc-song.wav", { type: "audio/wav" }));
    await L.saveSheet({ id, chordpro: importText(sheet), source: "mine" });
    invalidateSongs();
    return { id, truth };
  }, EXAMPLE_SHEET);
}

// A bundle like the helper's, made in the page: the browser's own analysis as
// the "detected" chart, three stems, and lyric timing for the first lines.
async function standInBundle(page, id, withAudio = false) {
  return page.evaluate(async ({ id, withAudio }) => {
    const gen = await import("/tests/gen-song.js");
    const A = await import("/js/analysis.js");
    const R = await import("/js/review.js");
    const { makeZip } = await import("/js/zip.js");
    const { signal } = await gen.renderSong({ bpm: 100, bars: ["G", "Em", "C", "D"], repeat: 4 });
    const raw = await A.analyseSignal(signal);
    const chart = R.chartFromRaw(raw, { id, title: "PC Song", artist: "Nobody", file: "pc-song.wav" });
    chart.detector = "stand-in detector (tests)";
    chart.analysis = { ...chart.analysis, beatChords: chart.bars.flatMap((b) => Array(b.n).fill(b.chords[0])), beatStrength: chart.bars.flatMap((b) => Array(b.n).fill(0.9)),
      chroma: undefined, helper: { detector: chart.detector }, profile: "edma" };
    delete chart.analysis.chroma;
    // Sections by sound, as the PC finds them: every 4 bars a "Part A".
    const D = await import("/js/detect.js");
    chart.analysis.segments = [];
    for (let i = 0; i + 3 < chart.bars.length; i += 4) chart.analysis.segments.push({ name: "Part A", bars: [i, i + 3] });
    Object.assign(chart, D.sectionsFromSegments(chart.bars, chart.analysis.segments));
    window.__form = chart.form;
    const quiet = new Float32Array(signal.length);
    for (let i = 0; i < quiet.length; i++) quiet[i] = 0.05 * Math.sin(2 * Math.PI * 440 * i / 44100);
    const wav = (x) => gen.wavBytes(x);
    const files = [
      { name: "bundle.json", data: JSON.stringify({ app: "songbook", kind: "bundle", version: 1, songId: id, title: "PC Song", artist: "Nobody", created: "2026-10-14T00:00:00Z",
        source: { name: withAudio ? "A tutorial.m4a" : "pc-song.wav", link: withAudio ? "https://www.youtube.com/watch?v=H_p4siY3Zc4" : null }, detector: chart.detector,
        files: ["chart.json", "stems/vocals.m4a", "stems/guitar.m4a", "stems/drums.m4a", "timing.json", ...(withAudio ? ["audio.m4a"] : [])],
        stems: [{ name: "vocals", label: "Vocals", file: "stems/vocals.m4a" }, { name: "guitar", label: "Guitar", file: "stems/guitar.m4a" }, { name: "drums", label: "Drums", file: "stems/drums.m4a" }],
        timing: true, audio: withAudio ? "audio.m4a" : null }) },
      { name: "chart.json", data: JSON.stringify(chart) },
      { name: "stems/vocals.m4a", data: wav(quiet) },
      { name: "stems/guitar.m4a", data: wav(signal) },
      { name: "stems/drums.m4a", data: wav(quiet) },
      { name: "timing.json", data: JSON.stringify({ lines: [{ index: 0, t: 2.4 }, { index: 1, t: 4.8 }, { index: 2, t: 7.2 }, { index: 99, t: 9 }] }) },
    ];
    if (withAudio) files.push({ name: "audio.m4a", data: wav(signal) });
    const z = await makeZip(files);
    return Array.from(new Uint8Array(await z.arrayBuffer()));
  }, { id, withAudio });
}

// The stand-in helper at 127.0.0.1:8799.
async function standIn(context, zip) {
  const seen = { posts: [], polls: 0 };
  const cors = { "Access-Control-Allow-Origin": "*" };
  const steps = (p) => [["prepare", "Reading the audio"], ["stems", "Stems (Demucs)"], ["beats", "Beats and bar lines"], ["chords", "Chords (ChordMini)"],
    ["sections", "Key and sections"], ["lyrics", "Lining up your lyrics"], ["bundle", "Packing the bundle"]].map(([key, label], i) => ({ key, label, p: Math.max(0, Math.min(1, p * 7 - i)) }));
  await context.route("http://127.0.0.1:8799/**", async (r) => {
    const url = r.request().url();
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" } });
    if (url.endsWith("/ping")) return r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ ok: true, yt_dlp: "test", helper: "songbook", version: 2, analysis: { available: true, gpu: "Test GPU" } }) });
    if (new URL(url).pathname === "/analyze") {
      seen.posts.push(r.request().postDataBuffer() || Buffer.alloc(0));
      return r.fulfill({ status: 202, contentType: "application/json", headers: cors, body: JSON.stringify({ id: "job-1", state: "queued", steps: steps(0), progress: 0 }) });
    }
    if (url.includes("/jobs/job-1")) {
      seen.polls++;
      const p = Math.min(1, seen.polls / 4);
      return r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ id: "job-1", state: p >= 1 ? "done" : "running", steps: steps(p), progress: p, bundle: "/bundle/job-1.zip" }) });
    }
    if (url.includes("/bundle/job-1.zip")) return r.fulfill({ status: 200, contentType: "application/zip", headers: cors, body: Buffer.from(zip) });
    return r.fulfill({ status: 404, headers: cors, body: "{}" });
  });
  return seen;
}

/* ---- 2. The phone's side, against a stand-in helper ---- */
for (const [w, h, scheme] of (process.env.ONLY ? [] : [[375, 752, "dark"], [1440, 900, "light"]])) {
  await section(`stand-in ${w}`, async () => {
    const { context, page, errors } = await newPage(w, h, scheme);
    const { id } = await seed(page);
    const zip = await standInBundle(page, id);
    const seen = await standIn(context, zip);
    await page.evaluate(() => localStorage.setItem("songbook-helper-url", "http://127.0.0.1:8799"));
    await show(page, `#/song/${encodeURIComponent(id)}/analyse`);
    await page.waitForSelector("#pc [data-pc=start]:not([disabled])", { timeout: 10000 });
    check(`${w}: the PC card names the GPU`, (await page.textContent("#pc")).includes("Test GPU"));
    check(`${w}: offers to line up the sheet's lyrics`, !!(await page.$("#pc [data-pc=lyrics]")));
    if (w < 860) await page.screenshot({ path: `${out}/analyse-pc-${w}-${scheme}.png` });
    await page.click("#pc [data-pc=start]");
    await page.waitForSelector("#pc .prog", { timeout: 10000 });
    await page.waitForTimeout(1700);
    if (w < 860) await page.screenshot({ path: `${out}/analyse-pc-running-${w}-${scheme}.png` });
    await until(page, (id) => import("/js/library.js").then((L) => L.get("charts", id)).then((c) => !!(c && c.detector && c.detector.startsWith("stand-in"))), id);
    const body = seen.posts[0] ? seen.posts[0].toString("latin1") : "";

    check(`${w}: sent the recording`, /name="file"; filename="pc-song.wav"/.test(body));
    // The [Intro] line has chords only, so the first lyric is line 1.
    check(`${w}: sent the sheet's lyric lines, by index`, /name="lyrics"/.test(body) && body.includes('{"index":1,"text":"Morning light on the kitchen floor,"}') && !body.includes('"index":0'));
    check(`${w}: sent the song's id and title`, /name="song"/.test(body) && body.includes("PC Song"));
    await page.waitForTimeout(800);
    const st = await page.evaluate(async (id) => {
      const L = await import("/js/library.js");
      const Rec = await import("/js/recordings.js");
      const Ly = await import("/js/lyrics.js");
      const c = await L.get("charts", id);
      const m = await Rec.stemsMeta(id);
      const t = await Ly.getTiming(id);
      return { source: c.source, detector: c.detector, bars: c.bars.length, form: c.form, stems: m && m.stems.map((s) => s.label), backend: m && m.stems[0].backend,
        timing: t && t.lines.map((x) => x.index), timingSource: t && t.source, jobs: window.songbook.pcJobs(), html: document.querySelector("#view-song").textContent,
        wantForm: window.__form };
    }, id);
    eq(`${w}: chart kept as detected`, st.source, "detected");
    check(`${w}: names its detector`, st.detector === "stand-in detector (tests)");
    eq(`${w}: sections from the PC's segments`, st.form, st.wantForm);
    eq(`${w}: stems kept`, st.stems, ["Vocals", "Guitar", "Drums"]);
    check(`${w}: stems in OPFS`, st.backend === "opfs", st.backend);
    eq(`${w}: lyric timing kept for lines the sheet has`, [st.timing, st.timingSource], [[0, 1, 2], "aligned"]);
    check(`${w}: the review shows the PC's draft`, /Analysed on your PC: stand-in detector/.test(st.html) && /bars/.test(st.html), st.html.slice(0, 300));
    await page.screenshot({ path: `${out}/analyse-pc-done-${w}-${scheme}.png` });

    // The Player: one row per stem.
    await show(page, `#/song/${encodeURIComponent(id)}/player`);
    await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind === "file" && s.duration > 0 && s.layout; }, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const ps = await page.evaluate(() => window.songbook.playerState());
    eq(`${w}: plays the stems`, ps.stems, true);
    eq(`${w}: one stretcher, ${w < 860 ? "a mono channel" : "two channels"} per stem`, ps.layout, ["vocals", "guitar", "drums"].map((n) => ({ track: "stem-" + n, channels: w < 860 ? 1 : 2 })));
    const rows = await page.$$eval(".mixer .track .tn", (els) => els.map((e) => e.firstChild.textContent.trim()));
    eq(`${w}: mixer rows`, rows, ["Vocals", "Guitar", "Drums", "App guitar", "Count-in"]);
    await page.click(".mixer [data-mute='stem:guitar']");
    const muted = await page.evaluate(() => import("/js/audio.js").then((A) => A.tracks().filter((t) => t.name.startsWith("stem-")).map((t) => [t.name, t.muted])));
    eq(`${w}: muting the guitar stem mutes just that track`, Object.fromEntries(muted), { "stem-vocals": false, "stem-guitar": true, "stem-drums": false });
    const play = page.locator("[data-act=play]:visible").first();
    await play.click();
    await page.waitForTimeout(1500);
    const pos = (await page.evaluate(() => window.songbook.playerState().engine.position));
    check(`${w}: stems play (${pos.toFixed(2)} s in)`, pos > 0.8);
    await page.screenshot({ path: `${out}/player-stems-${w}-${scheme}.png`, fullPage: false });
    await page.click(".mixer [data-stems='0']");
    await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && !s.stems && !s.layout; }, null, { timeout: 15000 });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => { const s = window.songbook.playerState(); return { pos: s.engine.position, playing: s.engine.playing }; });
    check(`${w}: Full mix carries on from the same place (${after.pos.toFixed(2)} s, was ${pos.toFixed(2)})`, after.playing && after.pos >= pos - 0.2);
    const rows2 = await page.$$eval(".mixer .track .tn", (els) => els.map((e) => e.firstChild.textContent.trim()));
    eq(`${w}: Full mix has the recording row`, rows2[0], "Recording");
    await play.click();
    // Settings: the stems are listed with Delete.
    await show(page, "#/settings");
    await page.waitForSelector("[data-del-stems]");
    check(`${w}: Settings lists the stems`, (await page.textContent("#view-settings")).includes("PC Song: stems"));
    check(`${w}: no page errors`, errors.length === 0, errors.join("; "));
    await context.close();
  });
}

/* ---- Layout of the new screens: 375×752, 375×630, 1440×900, Mocha and Latte ---- */
for (const [w, h] of [[375, 752], [375, 630], [1440, 900]]) {
  for (const scheme of ["dark", "light"]) {
    if (process.env.ONLY) break;
    await section(`layout ${w}x${h} ${scheme}`, async () => {
      const { context, page } = await newPage(w, h, scheme);
      const { id } = await seed(page);
      const zip = await standInBundle(page, id);
      await standIn(context, zip);
      await page.evaluate(() => localStorage.setItem("songbook-helper-url", "http://127.0.0.1:8799"));
      const tag = `${w}x${h} ${scheme === "dark" ? "Mocha" : "Latte"}`;
      await show(page, `#/song/${encodeURIComponent(id)}/analyse`);
      await page.waitForSelector("#pc [data-pc=start]:not([disabled])");
      await layout(page, `PC card ${tag}`);
      await page.click("#pc [data-pc=start]");
      await page.waitForSelector("#pc .prog");
      await page.waitForTimeout(1600);
      await layout(page, `PC running ${tag}`);
      await until(page, (id) => import("/js/library.js").then((L) => L.get("charts", id)).then((c) => !!(c && c.detector)), id);
      await page.waitForTimeout(800);
      await show(page, `#/song/${encodeURIComponent(id)}/player`);
      await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.layout; }, null, { timeout: 30000 });
      await page.waitForTimeout(400);
      await page.evaluate(() => document.querySelector(".mixer").scrollIntoView());
      await layout(page, `stems mixer ${tag}`);
      if (h === 630 || w > 860) await page.screenshot({ path: `${out}/player-stems-${w}x${h}-${scheme}.png` });
      await show(page, "#/settings");
      await page.waitForSelector("#bundle-file");
      await page.evaluate(() => document.querySelector("#bundle-file").closest(".set-row").scrollIntoView());
      await layout(page, `settings ${tag}`);
      await context.close();
    });
  }
}

/* ---- Resuming a job after a reload ---- */
if (!process.env.ONLY) await section("resume", async () => {
  const { context, page, errors } = await newPage();
  const { id } = await seed(page);
  const zip = await standInBundle(page, id);
  const seen = await standIn(context, zip);
  await page.evaluate(() => localStorage.setItem("songbook-helper-url", "http://127.0.0.1:8799"));
  await show(page, `#/song/${encodeURIComponent(id)}/analyse`);
  await page.waitForSelector("#pc [data-pc=start]:not([disabled])");
  await page.click("#pc [data-pc=start]");
  await page.waitForFunction(() => window.songbook.pcJobs().some((j) => j.id === "job-1"));
  seen.polls = -20;   // keep it "running" for a while
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, `#/song/${encodeURIComponent(id)}/analyse`);
  await page.waitForSelector("#pc .prog", { timeout: 10000 });
  check("resume: the job shows again after a reload", true);
  seen.polls = 3;
  await until(page, (id) => import("/js/library.js").then((L) => L.get("charts", id)).then((c) => !!(c && c.detector)), id);
  check("resume: and its results arrive", true);
  check("resume: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- A YouTube link analysed on the PC: the recording comes back too ---- */
await section("link", async () => {
  const { context, page, errors } = await newPage();
  await context.route("https://www.youtube.com/**", (r) => r.fulfill({ status: 404, body: "" }));
  const id = await page.evaluate(async () => {
    const L = await import("/js/library.js");
    const id = await L.addManualSong("Link Song", "Nobody");
    const p = await L.loadPrefs(id, null);
    p.player = { source: "youtube", youtube: { id: "H_p4siY3Zc4", title: "A tutorial (stand-in)" } };
    await L.savePrefs(id, p);
    return id;
  });
  const zip = await standInBundle(page, id, true);
  const seen = await standIn(context, zip);
  let asked = null;
  context.on("request", (r) => { if (r.url().includes("/analyze")) asked = r.url(); });
  await page.evaluate(() => localStorage.setItem("songbook-helper-url", "http://127.0.0.1:8799"));
  await show(page, `#/song/${encodeURIComponent(id)}/player`);
  await page.waitForSelector("[data-pcl]", { timeout: 15000 });
  await page.click("[data-pcl]");
  await page.waitForTimeout(1000);
  await page.waitForSelector(".pc-status .prog", { timeout: 10000 });
  await page.screenshot({ path: `${out}/player-link-running-375-dark.png` });
  await until(page, (id) => import("/js/recordings.js").then((R) => R.recordingMeta(id)).then((m) => !!(m && m.source === "helper")), id);
  check("link: asked the PC to download and analyse the link", asked && asked.includes("/analyze?url=") && asked.includes("H_p4siY3Zc4"), asked);
  check("link: sent no file", seen.posts[0] && !/name="file"/.test(seen.posts[0].toString("latin1")));
  await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind === "file" && s.duration > 0; }, null, { timeout: 30000 });
  const ps = await page.evaluate(() => { const s = window.songbook.playerState(); return { stems: s.stems, source: s.set.source }; });
  eq("link: the Player now plays what came back, as stems", ps, { stems: true, source: "file" });
  const meta = await page.evaluate((id) => import("/js/recordings.js").then((R) => R.recordingMeta(id)), id);
  eq("link: the recording is kept, with its link", [meta.name, meta.link], ["A tutorial.m4a", "https://www.youtube.com/watch?v=H_p4siY3Zc4"]);
  check("link: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- 3. The real helper: accuracy on rendered songs ---- */
const SONGS = [
  { name: "G D Em C, 96 bpm", bpm: 96, bars: ["G", "D", "Em", "C"], key: "G" },
  { name: "AABB form in D, 84 bpm", bpm: 84, bars: ["D", "Bm", "G", "A", "D", "Bm", "G", "A", "G", "A", "D", "D"], key: "D", repeat: 2, form: true },
  { name: "two chords a bar, 92 bpm", bpm: 92, bars: ["C G", "Am F", "C G", "F F"], key: "C" },
  { name: "waltz in 3/4, 140 bpm", bpm: 140, bars: ["C", "F", "G", "C"], bpb: 3, key: "C", meter: 3 },
  { name: "Dm Bb F C, 66 bpm", bpm: 66, bars: ["Dm", "Bb", "F", "C"], repeat: 3, key: "Dm" },
  { name: "D D/F# G A, 100 bpm", bpm: 100, bars: ["D", "D/F#", "G", "A"], key: "D", slash: true },
];

async function realHelper() {
  const tries = [process.env.SONGBOOK_HELPER, "http://127.0.0.1:8766", "http://127.0.0.1:8765"].filter(Boolean);
  for (const u of tries) {
    try {
      const r = await fetch(u + "/ping", { signal: AbortSignal.timeout(2000) });
      const j = await r.json();
      if (j.helper === "songbook" && j.analysis && j.analysis.available) return u;
    } catch (e) { /* not there */ }
  }
  return null;
}

const HELPER = process.env.ONLY ? null : await realHelper();
if (!HELPER) {
  console.log("  (the real-helper checks were skipped: no helper with analysis at SONGBOOK_HELPER, :8766 or :8765)");
} else {
  await section("real helper", async () => {
    const { context, page, errors } = await newPage(1440, 900);
    for (const s of SONGS) {
      const r = await page.evaluate(async ({ s, helper }) => {
        const gen = await import("/tests/gen-song.js");
        const C = await import("/js/chords.js");
        const { readZip } = await import("/js/zip.js");
        const { signal, truth } = await gen.renderSong(s);
        const fd = new FormData();
        fd.append("file", new File([gen.wavBytes(signal)], "test.wav", { type: "audio/wav" }));
        fd.append("song", "test-" + s.bpm);
        fd.append("title", "Test " + s.name);
        let job = await (await fetch(helper + "/analyze", { method: "POST", body: fd })).json();
        const t0 = performance.now();
        while (!["done", "failed", "cancelled"].includes(job.state) && performance.now() - t0 < 180000) {
          await new Promise((r) => setTimeout(r, 700));
          job = await (await fetch(helper + "/jobs/" + job.id)).json();
        }
        if (job.state !== "done") return { error: job.error || job.state };
        const files = await readZip(await (await fetch(helper + "/bundle/" + job.id + ".zip")).blob());
        const chart = JSON.parse(await files.get("chart.json").blob.text());
        const bars = chart.bars.map((b, i) => ({ ...b, t1: chart.bars[i + 1] ? chart.bars[i + 1].t : b.t + (60 / s.bpm) * (s.bpb || 4) }));
        const acc = gen.barAccuracy(bars, truth, (n) => C.simplifyChord(n || ""));
        const exact = gen.barAccuracy(bars, truth, (n) => { const c = C.parseChord(n || ""); return c && !c.nc ? `${c.root}:${c.q}:${c.bass ?? c.root}` : n; });
        // The stems add back up to the song, lined up: the best lag of their sum against the input.
        const ac = new OfflineAudioContext(1, 44100, 44100);
        const m = JSON.parse(await files.get("bundle.json").blob.text());
        let sum = null;
        for (const st of m.stems) {
          const buf = await ac.decodeAudioData(await files.get(st.file).blob.arrayBuffer());
          const x = buf.getChannelData(0);
          if (!sum) sum = new Float32Array(x.length);
          for (let i = 0; i < Math.min(x.length, sum.length); i++) sum[i] += x[i];
        }
        const from = 44100 * 5, len = 44100 * 3;
        let best = 0, bestLag = 0, e1 = 0, e2 = 0;
        for (let lag = -441; lag <= 441; lag++) {
          let d = 0;
          for (let i = 0; i < len; i += 2) d += signal[from + i] * sum[from + i + lag];
          if (d > best) { best = d; bestLag = lag; }
        }
        for (let i = 0; i < len; i += 2) { e1 += signal[from + i] ** 2; e2 += sum[from + i + bestLag] ** 2; }
        return { bpm: chart.tempo, key: chart.key, time: chart.time, form: chart.form, acc, exact, lag: bestLag, corr: best / Math.sqrt(e1 * e2),
          stems: m.stems.map((x) => x.name), seconds: m.seconds, bars: chart.bars.map((b) => b.chords.join(" ")).slice(0, 12).join(" | ") };
      }, { s, helper: HELPER });
      if (r.error) { check(`${s.name}: helper finished`, false, r.error); continue; }
      console.log(`  ${s.name}: ${r.bpm} bpm, ${r.key}, ${r.time}, ${Math.round(r.acc * 100)}% bars (${Math.round(r.exact * 100)}% exact), stems lag ${r.lag} samples (r ${r.corr.toFixed(3)}), ${r.seconds} s. ${r.bars}`);
      check(`${s.name}: tempo ${r.bpm} (±2, or ×2/÷2)`, [1, 2, 0.5].some((f) => Math.abs(r.bpm - s.bpm * f) <= 2));
      const relOf = { G: "Em", D: "Bm", C: "Am", Dm: "F" }[s.key];
      check(`${s.name}: key ${r.key} (or the relative)`, r.key === s.key || r.key === relOf, r.key);
      check(`${s.name}: ${Math.round(r.acc * 100)}% of bars right (>= 85%)`, r.acc >= 0.85);
      if (s.meter) eq(`${s.name}: meter`, r.time, "3/4");
      if (s.form) {
        const f = r.form;
        check(`${s.name}: a part that comes back (${f.join(", ")})`, f.length >= 2 && new Set(f).size < f.length);
      }
      if (s.slash) check(`${s.name}: the slash chord named, ${Math.round(r.exact * 100)}% of bars exactly (>= 85%)`, r.exact >= 0.85);
      else check(`${s.name}: plain chords named plainly in ${Math.round(r.exact * 100)}% of bars (>= 85%)`, r.exact >= 0.85);
      check(`${s.name}: stems line up with the song within 1 ms (${r.lag} samples)`, Math.abs(r.lag) <= 44);
      check(`${s.name}: stems add back up to the song (r ${r.corr.toFixed(3)} >= 0.9)`, r.corr >= 0.9);
    }
    check("real helper: no page errors", errors.length === 0, errors.join("; "));
    await context.close();
  });

  // Guitar parts (Phase 5b): made-up progressions with library patterns and
  // some bars with @ frets, in standard tuning and open D, through the whole
  // analysis (chords and beats detected too). Notes at the right pitch within
  // 30 ms >= 90%, on the right string >= 80%, the right library pattern in
  // >= 85% of the bars that play one.
  await section("real helper: guitar parts", async () => {
    const { context, page, errors } = await newPage(1440, 900);
    const PARTS = [
      { name: "standard tuning", bpm: 92, lead: 1, bars: [
        { chord: "G", pattern: "travis" }, { chord: "C", pattern: "travis" }, { chord: "D", pattern: "travis" }, { chord: "G", pattern: "travis" },
        { chord: "Em", pattern: "pima" }, { chord: "C", pattern: "pima" }, { chord: "D", steps: "pB i3@4 pA m pB i pA m" }, { chord: "G", pattern: "travis" }] },
      { name: "open D", bpm: 96, lead: 1, tuning: "D A D F# A D", bars: [
        { chord: "D", pattern: "travis" }, { chord: "G", pattern: "travis" }, { chord: "A", pattern: "travis" }, { chord: "D", pattern: "travis" },
        { chord: "Bm", pattern: "pimami" }, { chord: "D", pattern: "pimami" }, { chord: "A", steps: "pB i pA m2@2 pB i pA m" }, { chord: "D", pattern: "travis" }] },
    ];
    let notes = 0, pitch = 0, string = 0, bars = 0, right = 0;
    for (const s of PARTS) {
      const r = await page.evaluate(async ({ s, helper }) => {
        const gen = await import("/tests/gen-part.js");
        const G = await import("/tests/gen-song.js");
        const { readZip } = await import("/js/zip.js");
        const { signal, truth } = await gen.renderPart(s);
        const fd = new FormData();
        fd.append("file", new File([G.wavBytes(signal)], "part.wav", { type: "audio/wav" }));
        fd.append("song", "part-test"); fd.append("title", "Part test " + s.name); fd.append("parts", "guitar");
        if (s.tuning) fd.append("tuning", s.tuning);
        let job = await (await fetch(helper + "/analyze", { method: "POST", body: fd })).json();
        const t0 = performance.now();
        while (!["done", "failed", "cancelled"].includes(job.state) && performance.now() - t0 < 240000) {
          await new Promise((r) => setTimeout(r, 700));
          job = await (await fetch(helper + "/jobs/" + job.id)).json();
        }
        if (job.state !== "done") return { error: job.error || job.state };
        const files = await readZip(await (await fetch(helper + "/bundle/" + job.id + ".zip")).blob());
        const chart = JSON.parse(await files.get("chart.json").blob.text());
        const part = files.get("part.json") ? JSON.parse(await files.get("part.json").blob.text()) : null;
        return { truth, bars: chart.bars.map((b) => b.t), segments: chart.analysis.segments, part };
      }, { s, helper: HELPER });
      if (r.error || !r.part) { check(`parts ${s.name}: helper made a part`, false, r.error || "no part.json"); continue; }
      const found = r.part.notes;
      let p = 0, st = 0;
      for (const n of r.truth.notes) {
        const m = found.find((f) => Math.abs(f[0] - n.t) <= 0.03 && f[1] === n.midi);
        if (m) { p++; if (m[2] === n.string) st++; }
      }
      // Each true bar's pattern: from the part of the section the bar falls in.
      let ok = 0, tot = 0;
      const got = r.truth.bars.map((tb) => {
        const bi = r.bars.findIndex((t) => Math.abs(t - tb.t) < 0.15);
        const sg = r.segments.find((x) => bi >= x.bars[0] && bi <= x.bars[1]);
        const pt = sg && r.part.sections[sg.name];
        let pat = null;
        if (pt) for (let j = 0; j <= bi - sg.bars[0] && j < pt.bars.length; j++) if (Object.keys(pt.bars[j]).length) pat = pt.bars[j].pattern || "written";
        if (tb.pattern) { tot++; ok += pat === tb.pattern; }
        return pat;
      });
      console.log(`  parts, ${s.name}: ${p}/${r.truth.notes.length} notes at the right pitch, ${st} on the right string, ${ok}/${tot} bars with the right pattern: ${got.join(" ")}`);
      check(`parts ${s.name}: the part is labelled detected, fingers inferred`, Object.values(r.part.sections).every((x) => x.source === "detected" && x.detector && x.fingers === "inferred"));
      notes += r.truth.notes.length; pitch += p; string += st; bars += tot; right += ok;
    }
    check(`parts: ${Math.round(100 * pitch / notes)}% of notes at the right pitch within 30 ms (>= 90%)`, pitch / notes >= 0.9);
    check(`parts: ${Math.round(100 * string / notes)}% on the right string (>= 80%)`, string / notes >= 0.8);
    check(`parts: the right library pattern in ${Math.round(100 * right / bars)}% of bars (>= 85%)`, right / bars >= 0.85);
    check("parts: no page errors", errors.length === 0, errors.join("; "));
    await context.close();
  });
}

await browser.close();
report("pc");
