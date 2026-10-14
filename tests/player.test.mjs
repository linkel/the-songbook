// The recording player (Phase 3), in Chrome: speed keeps pitch, and pitch
// shifts land within 2 cents on a guitar-like song (3 when also slowed down,
// and on pure test tones: with 200 ms blocks Signalsmith Stretch runs a
// little sharp; 300 ms blocks get within ~1 cent for ~45% more CPU), the
// chord-now display stays on the right bar at 50% speed and across loop
// jumps, loops are seamless, count-in lands on the beat at 50% and 75%, the
// app guitar strums on the recording's beats, a pitch shift renames the
// chords, the mixer drives the right track, settings survive a reload, saved
// loops reach Practice, and YouTube (a stand-in for its player API), the PC
// helper (a stand-in for its download), LRCLIB (invented lyrics), tap-to-sync
// and the speedy-pitcher import all work. Nothing real is fetched.
// node player.test.mjs [shotsDir]
import { chromium } from "playwright-core";
import fs from "fs";
import { fileURLToPath } from "url";
import { BASE, check, eq, report, fixtureLibrary, EXAMPLE_SHEET, layout } from "./lib.mjs";

const out = process.argv[2] || fileURLToPath(new URL("shots/player", import.meta.url));
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });

// A stand-in for YouTube's IFrame player API: plays a silent 200 s "video" on
// performance.now(), at the rate it's given.
const FAKE_YT = `(() => {
  const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  class Player {
    constructor(el, o) {
      this.o = o; this.rate = 1; this.pos = (o.playerVars && o.playerVars.start) || 0; this.playing = false; this.at = 0;
      const f = document.createElement("iframe"); f.title = "YouTube stand-in"; el.replaceWith(f); this.f = f;
      window.__yt = this;
      setTimeout(() => o.events.onReady && o.events.onReady({ target: this }), 20);
    }
    now() { return this.playing ? this.pos + (performance.now() - this.at) / 1000 * this.rate : this.pos; }
    getDuration() { return 200; }
    getCurrentTime() { return this.now(); }
    getPlayerState() { return this.playing ? S.PLAYING : S.PAUSED; }
    playVideo() { if (!this.playing) { this.at = performance.now(); this.playing = true; this.o.events.onStateChange({ data: S.PLAYING }); } }
    pauseVideo() { if (this.playing) { this.pos = this.now(); this.playing = false; this.o.events.onStateChange({ data: S.PAUSED }); } }
    seekTo(t) { this.pos = t; this.at = performance.now(); }
    setPlaybackRate(r) { this.pos = this.now(); this.at = performance.now(); this.rate = r; }
    destroy() { this.playing = false; if (this.f) this.f.remove(); }
  }
  window.YT = { Player, PlayerState: S };
  if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();
})();`;

async function newPage(w = 375, h = 752, scheme = "dark") {
  const phone = w < 860;
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: scheme });
  const lib = fixtureLibrary();
  await context.route("**/private/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(lib) }));
  await context.route("https://www.youtube.com/iframe_api", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_YT }));
  // Late July's bundled clip (songs/audio/): absent unless a test serves a stand-in.
  await context.route("**/songs/audio/**", (r) => r.fulfill({ status: 404, body: "" }));
  await context.route("https://www.youtube.com/oembed**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title: "A tutorial (stand-in)" }) }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  // Generous: a busy machine (the whole suite at once) can be slow to start a page.
  await page.waitForSelector("html[data-ready]", { timeout: 90000 });
  return { context, page, errors };
}

async function section(name, fn) {
  try { await fn(); } catch (e) { check(`${name}: ran to the end`, false, e.message.split("\n").slice(0, 3).join(" | ")); }
}

async function show(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(350);
}

const P = (page) => page.evaluate(() => {
  const s = window.songbook.playerState();
  if (!s) return null;
  const e = s.engine;
  return { kind: s.kind, set: s.set, duration: s.duration, timed: s.timed, loops: s.loops, voicesCents: s.voicesCents, passes: s.passes,
    playing: !!(e && e.playing), pos: e ? e.position : 0, rate: e ? e.currentRate : null };
});

// A made-up song in the library with a detected chart and its recording.
// Returns { id, truth: [{ t, t1, chord }], wav }.
async function seedSong(page, { title = "Player Song", bars = ["G", "D", "Em", "C"], bpm = 120, repeat = 4 } = {}) {
  return page.evaluate(async ({ title, bars, bpm, repeat }) => {
    const gen = await import("/tests/gen-song.js");
    const A = await import("/js/analysis.js");
    const R = await import("/js/review.js");
    const L = await import("/js/library.js");
    const Rec = await import("/js/recordings.js");
    const { invalidateSongs } = await import("/js/songs.js");
    const { signal, truth } = await gen.renderSong({ bpm, bars, repeat });
    const raw = await A.analyseSignal(signal);
    const id = await L.addManualSong(title, "Nobody");
    const chart = R.chartFromRaw(raw, { id, title, artist: "Nobody", file: "song.wav" });
    await L.saveChart(chart);
    await Rec.saveRecording(id, new File([gen.wavBytes(signal)], "song.wav", { type: "audio/wav" }));
    invalidateSongs();
    window.__truth = truth;
    return { id, truth, bars: chart.bars.map((b) => [b.t, b.chords.join(" ")]) };
  }, { title, bars, bpm, repeat });
}

// A song with no recording and a YouTube link (a tutorial, say). Returns its id.
async function youTubeSong(page) {
  return page.evaluate(async () => {
    const L = await import("/js/library.js");
    const id = await L.addManualSong("Tutorial Song", "Nobody");
    const p = await L.loadPrefs(id, null);
    p.player = { youtube: { id: "H_p4siY3Zc4", title: "A tutorial (stand-in)" } };
    await L.savePrefs(id, p);
    return id;
  });
}

async function openPlayer(page, id) {
  await show(page, `#/song/${encodeURIComponent(id)}/player`);
  await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind && s.engine && s.duration > 0 && document.querySelector(".wave-main"); }, null, { timeout: 30000 });
  await page.waitForTimeout(400);
}

const chordAt = (truth, t) => { const x = truth.find((b) => t >= b.t && t < b.t1); return x ? x.chord : null; };

/* ---- Speed keeps pitch; pitch shifts land on pitch (offline renders) ---- */
await section("stretch", async () => {
  const { context, page } = await newPage();
  const r = await page.evaluate(async () => {
    const SS = (await import("/vendor/signalsmith-stretch/SignalsmithStretch.mjs")).default;
    const { STRETCH_CONFIG } = await import("/js/engine.js");
    const sr = 48000;
    // A 4 s tone at 440 Hz with a little second harmonic.
    const n = sr * 4;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / sr) + 0.1 * Math.sin(2 * Math.PI * 880 * i / sr);
    // Frequency from rising zero crossings (interpolated) of the fundamental:
    // low-passed first so the harmonic doesn't add crossings.
    const freq = (y, from, to) => {
      const a = Math.exp(-2 * Math.PI * 900 / sr);
      const z = new Float32Array(y.length);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < y.length; i++) { s1 = (1 - a) * y[i] + a * s1; s2 = (1 - a) * s1 + a * s2; z[i] = s2; }
      let first = null, last = null, count = 0;
      for (let i = Math.floor(from * sr) + 1; i < Math.floor(to * sr); i++) {
        if (z[i - 1] < 0 && z[i] >= 0) {
          const t = (i - 1 + z[i - 1] / (z[i - 1] - z[i])) / sr;
          if (first === null) first = t; else count++;
          last = t;
        }
      }
      return count / (last - first);
    };
    const render = async (rate, semitones) => {
      const len = Math.ceil(n / rate);
      const oc = new OfflineAudioContext(1, len, sr);
      const node = await SS(oc);
      await node.configure(STRETCH_CONFIG);
      node.connect(oc.destination);
      await node.addBuffers([x]);
      await node.schedule({ output: 0, outputTime: 0, input: 0, active: true, rate, semitones });
      const buf = await oc.startRendering();
      const y = buf.getChannelData(0);
      return { f: freq(y, 0.5, len / sr - 0.5), seconds: len / sr };
    };
    const cents = (f, want) => 1200 * Math.log2(f / want);
    const out = {};
    for (const [name, rate, semis, want] of [["50% speed", 0.5, 0, 440], ["75% speed", 0.75, 0, 440], ["−2 semitones", 1, -2, 440 * 2 ** (-2 / 12)],
      ["+1 semitone at 70%", 0.7, 1, 440 * 2 ** (1 / 12)], ["−20 cents at 75%", 0.75, -0.2, 440 * 2 ** (-0.2 / 12)]]) {
      const res = await render(rate, semis);
      out[name] = { cents: cents(res.f, want), seconds: res.seconds };
    }
    return out;
  });
  for (const [name, v] of Object.entries(r)) {
    const bound = /semitone|cents/.test(name) ? 3 : 0.5;
    check(`stretch, test tone, ${name}: within ${bound} cents (${v.cents.toFixed(2)})`, Math.abs(v.cents) <= bound, JSON.stringify(v));
  }
  check("stretch: 50% speed is twice as long", Math.abs(r["50% speed"].seconds - 8) < 0.01);
  // A strummed synth song, measured the way "Match my tuning" measures a recording.
  const g = await page.evaluate(async () => {
    const SS = (await import("/vendor/signalsmith-stretch/SignalsmithStretch.mjs")).default;
    const { STRETCH_CONFIG } = await import("/js/engine.js");
    const gen = await import("/tests/gen-song.js");
    const W = await import("/js/wavedata.js");
    const { signal } = await gen.renderSong({ bpm: 96, bars: ["G", "D", "Em", "C"], repeat: 2, drums: false });
    const sr = 44100;
    const est = (y) => {
      const buf = new AudioBuffer({ length: y.length, sampleRate: sr, numberOfChannels: 1 });
      buf.copyToChannel(y, 0);
      return W.estimateTuning(W.makeAnalysis(buf), 1, y.length / sr - 1).cents;
    };
    const base = est(signal);
    const out = {};
    for (const [name, rate, semis] of [["−2 semitones", 1, -2], ["+1 semitone", 1, 1], ["+1 semitone at 70%", 0.7, 1], ["−20 cents at 75%", 0.75, -0.2], ["50% speed", 0.5, 0]]) {
      const oc = new OfflineAudioContext(1, Math.ceil(signal.length / rate), sr);
      const node = await SS(oc);
      await node.configure(STRETCH_CONFIG);
      node.connect(oc.destination);
      await node.addBuffers([signal]);
      await node.schedule({ output: 0, outputTime: 0, input: 0, active: true, rate, semitones: semis });
      let c = est((await oc.startRendering()).getChannelData(0)) - base - (semis * 100) % 100;
      out[name] = ((c + 50) % 100 + 100) % 100 - 50;
    }
    return out;
  });
  // With slowing down and a fine tune together it can run a little further sharp.
  for (const [name, c] of Object.entries(g)) {
    const bound = /at \d+%/.test(name) && /semitone|cents/.test(name) ? 3 : 2;
    check(`stretch, guitar-like song, ${name}: within ${bound} cents (${c.toFixed(2)})`, Math.abs(c) <= bound);
  }
  await context.close();
});

/* ---- Playing a recording: sync, loops, count-in, app guitar, pitch, mixer ---- */
let SONG = null;
await section("player", async () => {
  const { context, page, errors } = await newPage();
  SONG = await seedSong(page);
  const { id, truth } = SONG;
  await openPlayer(page, id);
  const p0 = await P(page);
  eq("player: your file, with bar times", [p0.kind, p0.timed], ["file", true]);
  check("player: duration", Math.abs(p0.duration - (truth[truth.length - 1].t1 + 2.5)) < 0.2, String(p0.duration));
  const lanes = await page.evaluate(() => document.querySelector(".karaoke").textContent);
  check("player: chord now shown before playing", /G/.test(lanes), lanes);
  await page.screenshot({ path: `${out}/player-ready.png` });

  // 50% speed: the chord shown matches what's playing.
  for (let i = 0; i < 10; i++) await page.click("[data-hold='speed-']");
  eq("player: 50% speed", (await P(page)).set.speed, 0.5);
  await page.click(".transport.mobile .p-play");
  const samples = [];
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(120);
    samples.push(await page.evaluate(() => ({ pos: window.songbook.playerState().engine.position, shown: document.querySelector(".karaoke .big").textContent.trim() })));
  }
  const near = (t) => truth.some((b) => Math.abs(b.t - t) < 0.12);
  const judged = samples.filter((s) => !near(s.pos));
  const right = judged.filter((s) => (s.shown === "–" ? null : s.shown) === chordAt(truth, s.pos)).length;
  check(`player: at 50% the chord shown is the one playing (${right}/${judged.length})`, judged.length > 20 && right / judged.length >= 0.9, JSON.stringify(samples.slice(0, 6)));
  const span = samples[samples.length - 1].pos - samples[0].pos;
  check(`player: 50% speed moves at half speed (${span.toFixed(2)} s of song in ~4.7 s)`, span > 1.9 && span < 2.8);
  // App guitar: on, it strums on the recording's beats at this speed.
  await page.click("[data-mute='guitar']");
  await page.waitForTimeout(2500);
  const g = await page.evaluate(() => {
    const s = window.songbook.playerState();
    return { strums: s.strums.map((x) => ({ at: x.at, song: x.song, map: s.engine.posAt(x.at) })), cents: s.voicesCents };
  });
  check("app guitar: strums scheduled", g.strums.length >= 2, JSON.stringify(g.strums.length));
  check("app guitar: each strum lands on its beat in song time", g.strums.every((x) => Math.abs(x.map - x.song) < 0.005), JSON.stringify(g.strums.slice(0, 3)));
  const tracks = await page.evaluate(async () => { const A = await import("/js/audio.js"); return Object.fromEntries(A.tracks().map((t) => [t.name, { v: t.volume, m: t.muted }])); });
  eq("mixer: the app guitar track is on", tracks["app-guitar"].m, false);
  await page.click(".transport.mobile .p-play");
  await page.waitForTimeout(200);
  eq("player: paused", (await P(page)).playing, false);

  // Mixer: the recording's mute and volume reach its own track only.
  await page.click("[data-mute='recording']");
  await page.$eval("[data-vol='guitar']", (r) => { r.value = "0.3"; r.dispatchEvent(new Event("input")); });
  const t2 = await page.evaluate(async () => { const A = await import("/js/audio.js"); return Object.fromEntries(A.tracks().map((t) => [t.name, { v: t.volume, m: t.muted }])); });
  check("mixer: recording muted, guitar at 0.3, click untouched", t2.recording.m === true && t2["app-guitar"].v === 0.3 && t2["app-guitar"].m === false && (!t2.click || t2.click.m === false), JSON.stringify(t2));
  await page.click("[data-mute='recording']");

  // A one-bar loop at full speed: position jumps from B back to A with no gap.
  for (let i = 0; i < 10; i++) await page.click("[data-hold='speed+']");
  const b1 = truth[4], b2 = truth[5];
  await page.evaluate(([a, b]) => import("/js/player.js").then((m) => m.loopTo(a, b)), [b1.t, b2.t]);
  await page.evaluate((a) => window.songbook.playerState().engine.seek(a), b1.t);
  const started = await page.evaluate(async () => { const A = await import("/js/audio.js"); return A.audioContext().currentTime; });
  await page.click(".transport.mobile .p-play");
  const loopSamples = [];
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(40);
    loopSamples.push(await page.evaluate((t0) => ({ pos: window.songbook.playerState().engine.position, shown: document.querySelector(".karaoke .big").textContent.trim(),
      gaps: window.songbook.playerState().engine.plan.filter((s, i, a) => i > 0 && !s.active && a[i - 1].active && s.output > t0 + 0.05).length }), started));
  }
  const wraps = [];
  for (let i = 1; i < loopSamples.length; i++) if (loopSamples[i].pos < loopSamples[i - 1].pos - 0.5) wraps.push([loopSamples[i - 1].pos, loopSamples[i].pos]);
  check("loop: wraps at least once in 3.6 s", wraps.length >= 1, JSON.stringify(loopSamples.map((s) => +s.pos.toFixed(2)).slice(0, 20)));
  check("loop: jumps from B to A seamlessly (no pause in the schedule)", wraps.every(([x, y]) => x > b2.t - 0.12 && y < b1.t + 0.12) && loopSamples.every((s) => s.gaps === 0), JSON.stringify(wraps));
  const outside = loopSamples.slice(3).filter((s) => s.pos < b1.t - 0.06 || s.pos > b2.t + 0.06);
  check("loop: playback stays inside A–B", outside.length === 0, JSON.stringify(outside.slice(0, 4)));
  const afterWrap = loopSamples.filter((s) => s.pos > b1.t + 0.1 && s.pos < b2.t - 0.1);
  check("loop: the chord shown stays right across the jump", afterWrap.length > 5 && afterWrap.every((s) => s.shown === b1.chord), JSON.stringify(afterWrap.slice(0, 3)));
  await page.click(".transport.mobile .p-play");

  // Count-in lands on the beat at 75% and 50%.
  await page.click("[data-count='1']");
  for (const speed of [0.75, 0.5]) {
    await page.evaluate((s) => import("/js/player.js").then((m) => m.speedBy(s - window.songbook.playerState().set.speed)), speed);
    await page.evaluate((a) => window.songbook.playerState().engine.seek(a), b1.t);
    await page.click(".transport.mobile .p-play");
    await page.waitForTimeout(100);
    const ci = await page.evaluate(() => {
      const e = window.songbook.playerState().engine;
      const clicks = e.clicks.map((c) => c.when).sort((a, b) => a - b).slice(-4);
      return { clicks, start: e.plan.find((s) => s.active && s.output > clicks[0]), tempo: 60 / e.countIn.beatSec, beats: e.countIn.beats };
    });
    const beat = 60 / ci.tempo / speed;
    const spacing = ci.clicks.slice(1).map((c, i) => c - ci.clicks[i]);
    check(`count-in at ${speed * 100}%: ${ci.beats} clicks a beat apart`, ci.beats === 4 && ci.clicks.length === 4 && spacing.every((d) => Math.abs(d - beat) < 0.002), JSON.stringify({ spacing, beat }));
    check(`count-in at ${speed * 100}%: the music starts on the next beat`, ci.start && Math.abs(ci.start.output - (ci.clicks[0] + 4 * beat)) < 0.002 && Math.abs(ci.start.input - b1.t) < 0.01, JSON.stringify(ci.start));
    await page.click(".transport.mobile .p-play");
    await page.waitForTimeout(150);
  }
  const ciTempo = await page.evaluate(() => 60 / window.songbook.playerState().engine.countIn.beatSec);
  check(`count-in: at the song's analysed tempo (${ciTempo.toFixed(2)} bpm)`, Math.abs(ciTempo - 120) < 0.5);

  // Pitch −2: chords follow (G D Em C -> F C Dm Bb), here and in Chords mode.
  await page.click("[data-hold='pitch-']");
  await page.click("[data-hold='pitch-']");
  await page.evaluate((a) => window.songbook.playerState().engine.seek(a + 0.3), truth[0].t);
  await page.waitForTimeout(300);
  const pst = await P(page);
  eq("pitch: −2 semitones", pst.set.semis, -2);
  eq("pitch: the chord shown follows (G -> F)", await page.$eval(".karaoke .big", (e) => e.textContent.trim()), "F");
  check("pitch: the app guitar plays at the recording's pitch", Math.abs(pst.voicesCents - (-200)) <= 6, String(pst.voicesCents));
  await show(page, `#/song/${encodeURIComponent(id)}/chords`);
  const disp = (await page.evaluate(() => window.songbook.songState().displayed));
  eq("pitch: Chords mode shows the shifted chords", disp.slice(0, 4), ["F", "C", "Dm", "Bb"]);
  check("pitch: the toolbar says so", /−2 pitch/.test(await page.textContent(".toolbar")));
  await openPlayer(page, id);

  // Save a loop: it shows in Practice, and opens the Player on it.
  await page.click("[data-act='loop-bars']");
  await page.click("[data-act='save-loop']");
  await page.fill("#loop-name", "First four bars");
  await page.screenshot({ path: `${out}/player-save-loop.png` });
  await page.click("#loop-save");
  await page.waitForTimeout(300);
  check("loops: saved loop is a pill", (await page.textContent(".loop-pills")).includes("First four bars"));
  await show(page, "#/practice");
  check("practice: lists the saved loop", (await page.textContent("#view-practice")).includes("First four bars"));
  await page.screenshot({ path: `${out}/practice.png` });
  await page.evaluate(() => import("/js/player.js").then((m) => m.loopTo(0, 0.5)));
  await page.click(".loop-link");
  await page.waitForTimeout(1200);
  const pl = await P(page);
  check("practice: opens the Player on that loop", pl.set.loopOn && pl.set.loopId && Math.abs(pl.set.b - pl.set.a - 8) < 0.2, JSON.stringify([pl.set.a, pl.set.b, pl.set.loopId]));

  // Settings survive a reload.
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await openPlayer(page, id);
  const rl = await P(page);
  eq("reload: speed, pitch, count-in and loop kept", [rl.set.speed, rl.set.semis, rl.set.countIn, rl.set.loopOn], [0.5, -2, 1, true]);
  eq("reload: the engine has them", [rl.rate, await page.evaluate(() => window.songbook.playerState().engine.semitones)], [0.5, -2]);

  // Shortcuts.
  await page.keyboard.press("ArrowUp");
  eq("keys: ↑ speeds up", (await P(page)).set.speed, 0.55);
  await page.keyboard.press("ArrowRight");
  eq("keys: → pitch up", (await P(page)).set.semis, -1);
  await page.keyboard.press("l");
  check("keys: L loops the section", (await P(page)).set.loopOn);
  check("player: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Layout of the Player at every size, both flavours ---- */
for (const [w, h] of [[375, 752], [375, 630], [1440, 900]]) {
  for (const [theme, scheme] of [["mocha", "dark"], ["latte", "light"]]) {
    await section(`layout ${w}x${h} ${theme}`, async () => {
      const { context, page, errors } = await newPage(w, h, scheme);
      const s = await seedSong(page, { title: "Layout Song", repeat: 2 });
      await openPlayer(page, s.id);
      await page.click("[data-act='loop-bars']");
      await page.waitForTimeout(200);
      const tag = `${w}x${h} ${theme}`;
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-player.png` });
      await layout(page, `${tag} player`);
      await page.$eval("#song-scroll", (el) => { el.scrollTop = el.scrollHeight / 2; });
      await page.waitForTimeout(150);
      await page.click("[data-act='trainer']");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-player-middle.png` });
      await layout(page, `${tag} player, controls`);
      await page.$eval("#song-scroll", (el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-player-mixer.png` });
      await layout(page, `${tag} player, mixer`);
      // No recording, a YouTube link (the stand-in), then its player.
      await show(page, `#/song/${await youTubeSong(page)}/player`);
      await page.waitForSelector("[data-yt]");
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-player-source.png` });
      await layout(page, `${tag} player, no recording`);
      await page.click("[data-yt]");
      await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind === "youtube" && s.duration > 0; });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-player-youtube.png` });
      await layout(page, `${tag} player, YouTube`);
      await show(page, "#/practice");
      await layout(page, `${tag} practice`);
      await show(page, "#/settings");
      await page.$eval("#player-card", (el) => el.scrollIntoView());
      await page.waitForTimeout(100);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-settings-player.png` });
      await layout(page, `${tag} settings, player card`);
      check(`${tag}: no page errors`, errors.length === 0, errors.join("; "));
      await context.close();
    });
  }
}

/* ---- YouTube without the helper ---- */
await section("youtube", async () => {
  const { context, page, errors } = await newPage();
  const yid = await youTubeSong(page);
  await show(page, `#/song/${yid}/player`);
  await page.waitForSelector("[data-yt]");
  check("youtube: offers the song's link", (await page.textContent(".song-scroll")).includes("A tutorial (stand-in)"));
  await page.click("[data-yt]");
  await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind === "youtube" && s.duration > 0; });
  await page.click("[data-hold='speed-']");
  eq("youtube: speed goes to YouTube's player", await page.evaluate(() => window.__yt.rate), 0.95);
  check("youtube: pitch is unavailable", await page.$eval("[data-hold='pitch+']", (b) => b.disabled));
  await page.click(".transport.mobile .p-play");
  await page.waitForTimeout(600);
  const yp = await P(page);
  check("youtube: plays", yp.playing && yp.pos > 0.2, JSON.stringify([yp.playing, yp.pos]));
  await page.click(".transport.mobile .p-play");
  await page.waitForTimeout(200);
  // Loop A..B in YouTube's player.
  await page.evaluate(() => import("/js/player.js").then((m) => m.loopTo(10, 11)));
  await page.evaluate(() => window.songbook.playerState().engine.seek(10.5));
  await page.click(".transport.mobile .p-play");
  await page.waitForTimeout(1800);
  const yl = await P(page);
  check("youtube: loops back to A", yl.pos >= 9.9 && yl.pos < 11.1, String(yl.pos));
  await page.click(".transport.mobile .p-play");
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, `#/song/${yid}/player`);
  await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind === "youtube"; }, null, { timeout: 8000 });
  check("youtube: reopens on YouTube after a reload", true);
  check("youtube: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- A recording that comes with the app (a stand-in for Late July's clip) ---- */
await section("bundled audio", async () => {
  const { context, page, errors } = await newPage();
  const wav = Buffer.from(await page.evaluate(async () => {
    const g = await import("/tests/gen-song.js");
    const { signal } = await g.renderSong({ bpm: 118, bars: ["D", "G", "D", "A"], repeat: 1 });
    return Array.from(g.wavBytes(signal));
  }));
  let asked = null;
  await context.route("**/songs/audio/**", (r) => { asked = r.request().url(); r.fulfill({ status: 200, contentType: "audio/wav", body: wav }); });
  await show(page, "#/song/late-july/player");
  await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind === "file" && s.duration > 0; }, null, { timeout: 20000 });
  check("bundled: loads Late July's clip by itself", asked && asked.includes("/songs/audio/Late%20July"), asked);
  eq("bundled: with the chords' bar times", (await P(page)).timed, true);
  eq("bundled: played straight from the app, not stored again", await page.evaluate(() => import("/js/recordings.js").then((m) => m.recordingMeta("late-july"))), null);
  check("bundled: labelled", (await page.textContent(".topbar .badge")).includes("With the app"));
  check("bundled: the tutorial isn't offered as a source", (await page.$$("[data-yt]")).length === 0);
  await page.click(".transport.mobile .p-play");
  await page.waitForTimeout(1200);
  check("bundled: plays", (await P(page)).playing && (await P(page)).pos > 0.3);
  await page.click(".transport.mobile .p-play");
  // Chosen YouTube before (as on the phone): the song's own recording still opens.
  await page.evaluate(async () => { const L = await import("/js/library.js"); const p = await L.loadPrefs("late-july", null); p.player = { ...p.player, source: "youtube", youtube: { id: "H_p4siY3Zc4", title: "tutorial" } }; await L.savePrefs("late-july", p); });
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, "#/song/late-july/player");
  await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind && s.duration > 0; }, null, { timeout: 20000 });
  eq("bundled: wins over an earlier YouTube choice", (await P(page)).kind, "file");
  check("bundled: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- The PC helper's download (a stand-in), then pitch ---- */
await section("helper", async () => {
  const { context, page, errors } = await newPage();
  const wav = Buffer.from(await page.evaluate(async () => {
    const g = await import("/tests/gen-song.js");
    const { signal } = await g.renderSong({ bpm: 100, bars: ["D", "A", "G", "D"], repeat: 1 });
    return Array.from(g.wavBytes(signal));
  }));
  let asked = null;
  await context.route("http://127.0.0.1:8799/**", (r) => {
    asked = r.request().url();
    if (asked.includes("/ping")) return r.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ ok: true, yt_dlp: "test", helper: "songbook" }) });
    return r.fulfill({ status: 200, contentType: "audio/wav", headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Title, X-Duration, X-Source-Id", "X-Title": encodeURIComponent("Late July (tutorial)"), "X-Source-Id": "H_p4siY3Zc4" }, body: wav });
  });
  await show(page, "#/settings");
  await page.fill("#helper-url", "http://127.0.0.1:8799");
  await page.click("#helper-form button");
  await page.waitForTimeout(500);
  check("helper: Test connects", (await page.textContent("#helper-status")).includes("Connected"), await page.textContent("#helper-status"));
  const hid = await youTubeSong(page);
  await show(page, `#/song/${hid}/player`);
  await page.waitForSelector("[data-dl]");
  await page.click("[data-dl]");
  await page.waitForFunction(() => { const s = window.songbook.playerState(); return s && s.kind === "file" && s.duration > 0; }, null, { timeout: 20000 });
  check("helper: asked for the tutorial's audio", asked && asked.includes("/audio?url=") && asked.includes("H_p4siY3Zc4"), asked);
  const meta = await page.evaluate((id) => import("/js/recordings.js").then((m) => m.recordingMeta(id)), hid);
  eq("helper: kept as the song's recording", [meta.source, meta.name], ["helper", "Late July (tutorial).wav"]);
  await page.click("[data-hold='pitch+']");
  eq("helper: then pitch works", (await P(page)).set.semis, 1);
  check("helper: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- LRCLIB (invented lyrics) and the sheet following the recording ---- */
await section("lrclib", async () => {
  const { context, page, errors } = await newPage();
  const s = await seedSong(page, { title: "Lyric Song", repeat: 2 });
  const t = s.truth;
  // Invented lines, each starting on a bar.
  const LINES = ["Paper lanterns on a quiet street", "nobody hurries and nobody waits", "humming something that I can't repeat", "under the arch of the garden gates"];
  const lrc = LINES.map((l, i) => `[00:${(t[1 + i * 2].t).toFixed(2).padStart(5, "0")}] ${l}`).join("\n");
  let asked = null;
  await context.route("https://lrclib.net/api/**", (r) => {
    asked = r.request().url();
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trackName: "Lyric Song", artistName: "Nobody", duration: 20, syncedLyrics: lrc, plainLyrics: LINES.join("\n") }) });
  });
  await show(page, `#/song/${encodeURIComponent(s.id)}/sheet`);
  await page.click("[data-act='lrclib-new']");
  await page.waitForSelector(".sheet .line", { timeout: 8000 });
  check("lrclib: asked with title, artist and length", asked && /track_name=Lyric\+Song/.test(asked) && /artist_name=Nobody/.test(asked) && /duration=\d+/.test(asked), asked);
  const sheet = await page.evaluate(() => [...document.querySelectorAll(".sheet .line")].map((l) => l.textContent.replace(/\s+/g, " ").trim()));
  check("lrclib: a sheet with the lines and the detected chords on them", sheet.length >= 4 && sheet.some((l) => /^D/.test(l) || /G/.test(l)), JSON.stringify(sheet.slice(0, 3)));
  check("lrclib: labelled as LRCLIB with chords placed by time", /LRCLIB/.test(await page.textContent(".sources")) && /placed by time/.test(await page.textContent(".sources")));
  const st = await page.evaluate(() => window.songbook.songState());
  eq("lrclib: every line timed", st.timing.lines.length, 4);
  await page.screenshot({ path: `${out}/lrclib-sheet.png` });
  // Play from the sheet: the line lights as it's sung.
  await page.click(".transport.mobile .play");
  await page.waitForFunction((t) => { const p = window.songbook.playerNow(); return p && p.pos > t; }, t[3].t + 0.4, { timeout: 15000 });
  const lit = await page.$eval(".sheet .line.now", (l) => l.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
  check("lrclib: the line being sung is lit", lit && lit.includes("nobody hurries"), lit);
  await page.click(".transport.mobile .play");
  check("lrclib: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Tap-to-sync on a pasted sheet ---- */
await section("tap-sync", async () => {
  const { context, page, errors } = await newPage();
  const s = await seedSong(page, { title: "Sync Song", repeat: 2 });
  await page.evaluate(async ([id, text]) => {
    const L = await import("/js/library.js");
    const C = await import("/js/chordpro.js");
    await L.saveSheet({ id, chordpro: C.importText(text, { title: "Sync Song", artist: "Nobody" }), source: "mine" });
  }, [s.id, EXAMPLE_SHEET]);
  await show(page, "#/songs");
  await show(page, `#/song/${encodeURIComponent(s.id)}/sheet`);
  await page.click("[data-act='sync']");
  await page.waitForSelector(".sync-bar");
  await page.screenshot({ path: `${out}/tap-sync.png` });
  await page.click("[data-sync='play']");
  await page.waitForTimeout(700);
  await page.click("[data-sync='tap']");
  await page.waitForTimeout(900);
  await page.click("[data-sync='tap']");
  await page.click("[data-sync='later']");
  const st = await page.evaluate(() => window.songbook.songState());
  const lines = st.timing.lines;
  check("tap-sync: two lines timed, in order", lines.length === 2 && lines[1].t > lines[0].t, JSON.stringify(lines));
  check("tap-sync: the nudge moved the last line", lines.length === 2 && Math.abs(lines[1].t - lines[0].t - 1.0) < 0.35, JSON.stringify(lines));
  // LRCLIB lines matched to the sheet.
  await context.route("https://lrclib.net/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ trackName: "Sync Song", artistName: "Nobody", syncedLyrics: "[00:03.00] Morning light on the kitchen floor\n[00:07.00] coffee cooling by the open door\n[00:11.00] every little thing I meant to say" }) }));
  await page.click("[data-sync='lrclib']");
  await page.waitForTimeout(800);
  const st2 = await page.evaluate(() => window.songbook.songState());
  check("lrclib on a sheet: matching lines get LRCLIB's times", st2.timing.source === "lrclib" && st2.timing.lines.filter((x) => [3, 7, 11].includes(x.t)).length === 3, JSON.stringify(st2.timing));
  await page.click("[data-sync='play']");
  await page.click("[data-sync='done']");
  check("tap-sync: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- speedy-pitcher: an export file, and its database on the same site ---- */
await section("speedy-pitcher", async () => {
  const { context, page, errors } = await newPage();
  check("speedy-pitcher: none here, and none created by looking", !(await page.evaluate(async () => {
    location.hash = "#/settings";
    await new Promise((r) => setTimeout(r, 400));
    return (await indexedDB.databases()).some((d) => d.name === "speedy-pitcher");
  })));
  check("speedy-pitcher: no Import-from-here button", (await page.$$("#sp-here")).length === 0);
  const zip = Buffer.from(await page.evaluate(async () => {
    const { makeZip } = await import("/js/zip.js");
    const g = await import("/tests/gen-song.js");
    const { signal } = await g.renderSong({ bpm: 100, bars: ["C", "G"], repeat: 1 });
    const songs = [
      { id: "f1", type: "file", title: "Test Artist 3 - Test Song 0003", fileName: "Test Artist 3 - Test Song 0003.wav", mime: "audio/wav",
        settings: { speed: 0.8, semis: 1, cents: -12, formant: false, a: 1, b: 3, loopOn: true, countIn: 1, trainer: { start: 0.6, step: 0.05, every: 2, target: 1 } },
        loops: [{ name: "Tricky bit", a: 1.5, b: 2.5 }] },
      { id: "y1", type: "youtube", videoId: "abcdefghijk", title: "Somebody New - Made Up Tune", settings: { speed: 0.7 }, loops: [] },
    ];
    const blob = await makeZip([{ name: "library.json", data: JSON.stringify({ app: "speedy-pitcher", version: 1, songs }) }, { name: "audio/f1.wav", data: g.wavBytes(signal) }]);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  await page.setInputFiles("#sp-file", { name: "speedy-pitcher-library.zip", mimeType: "application/zip", buffer: zip });
  await page.waitForSelector("#view-import .batch-row");
  const rows = await page.evaluate(() => window.songbook.importState().rows);
  eq("import: both songs listed", rows.length, 2);
  check("import: the file matches its song in the library", rows[0].sure && rows[0].choice !== "new", JSON.stringify(rows[0]));
  eq("import: the unknown one becomes a new song", rows[1].choice, "new");
  await page.screenshot({ path: `${out}/import.png` });
  await page.click("#view-import [data-act=import]");
  await page.waitForFunction(() => window.songbook.importState().rows.every((r) => r.status === "done"), null, { timeout: 15000 });
  const got = await page.evaluate(async (id) => {
    const L = await import("/js/library.js");
    const R = await import("/js/recordings.js");
    const prefs = await L.loadPrefs(id, null);
    const loops = (await L.getAll("loops")).filter((l) => l.songId === id);
    const newId = L.songIdFor("Made Up Tune", "Somebody New");
    const np = await L.loadPrefs(newId, null);
    return { rec: await R.recordingMeta(id), player: prefs.player, loops: loops.map((l) => l.name), yt: np.player && np.player.youtube, entry: await L.getEntry(newId) };
  }, rows[0].choice);
  check("import: the recording came over", got.rec && got.rec.source === "speedy-pitcher" && got.rec.size > 1000, JSON.stringify(got.rec));
  eq("import: settings came over", [got.player.speed, got.player.semis, got.player.cents, got.player.a, got.player.loopOn, got.player.countIn, got.player.trainer.start], [0.8, 1, -12, 1, true, 1, 0.6]);
  eq("import: loops came over (to Practice)", got.loops, ["Tricky bit"]);
  check("import: the YouTube song was added, with its link", got.entry && got.yt && got.yt.id === "abcdefghijk", JSON.stringify(got));
  await show(page, "#/practice");
  check("import: Practice lists the imported loop", (await page.textContent("#view-practice")).includes("Tricky bit"));

  // speedy-pitcher's own database on this site (as on GitHub Pages).
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open("speedy-pitcher", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("songs", { keyPath: "id" }); req.result.createObjectStore("blobs", { keyPath: "id" }); };
    req.onsuccess = () => {
      const tx = req.result.transaction(["songs", "blobs"], "readwrite");
      tx.objectStore("songs").put({ id: "z9", type: "file", title: "Test Artist 5 - Test Song 0005", fileName: "x.wav", settings: { speed: 0.9 }, loops: [] });
      tx.objectStore("blobs").put({ id: "z9", blob: new Blob([new Uint8Array(2000)], { type: "audio/wav" }) });
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await show(page, "#/settings");
  await page.click("#sp-here");
  await page.waitForSelector("#view-import .batch-row");
  const rows2 = await page.evaluate(() => window.songbook.importState());
  check("same site: reads speedy-pitcher's library directly", rows2.from === "here" && rows2.rows.length === 1 && rows2.rows[0].sure, JSON.stringify(rows2));
  check("speedy-pitcher: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Export your charts (for songs/ in the repo) ---- */
await section("charts export", async () => {
  const { context, page, errors } = await newPage(375, 752, "dark");
  const s = await seedSong(page, { title: "Export Song", repeat: 2 });
  await show(page, "#/settings");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#charts-export")]);
  const file = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  const c = file.charts.find((x) => x.id === s.id);
  check("export: a charts file with this song", file.app === "songbook" && file.kind === "charts" && !!c, dl.suggestedFilename());
  check("export: chords, bar times and beats", c && c.source === "detected" && c.detector && c.sections.length && c.bars.length && c.beats.length && typeof c.bars[0].t === "number");
  check("export: no recording name or chroma", c && !JSON.stringify(c).includes("song.wav") && !(c.analysis && (c.analysis.chroma || c.analysis.file || c.analysis.ticks)), JSON.stringify(c && c.analysis));
  check("export: says so", /chart/.test(await page.textContent("#charts-out")));
  check("charts export: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Test stretch speed ---- */
await section("bench", async () => {
  const { context, page } = await newPage(1440, 900);
  await show(page, "#/settings");
  await page.click("#bench");
  await page.waitForFunction(() => /Six stems: [\d.]+×|Couldn't/.test(document.querySelector("#bench-out").textContent), null, { timeout: 90000 });
  const txt = await page.textContent("#bench-out");
  const x = parseFloat((txt.match(/Recording: ([\d.]+)×/) || [])[1]);
  const y = parseFloat((txt.match(/Six stems: ([\d.]+)×/) || [])[1]);
  check(`bench: the recording runs faster than real time (${txt})`, x > 1);
  check(`bench: six stems through one node run faster than real time`, y > 1);
  await context.close();
});

await browser.close();
report("player");
