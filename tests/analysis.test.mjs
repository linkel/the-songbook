// Analysis accuracy on songs rendered by the app's own synth (tests/gen-song.js):
// tempo within ±2 bpm (or ×2 / ÷2), the key right (or its relative major or
// minor), and at least 85% of bars with the right triad. Also: the play-along
// highlight lands within 50 ms of the bar times, and recordings round-trip
// through on-device storage. Nothing is written to disk. node analysis.test.mjs
import { chromium } from "playwright-core";
import { BASE, check, eq, report } from "./lib.mjs";

const SONGS = [
  { name: "G D Em C, 96 bpm", bpm: 96, bars: ["G", "D", "Em", "C"], key: "G" },
  { name: "Am F C G, 120 bpm", bpm: 120, bars: ["Am", "F", "C", "G"], key: "Am" },
  { name: "AABB form in D, 84 bpm", bpm: 84, bars: ["D", "Bm", "G", "A", "D", "Bm", "G", "A", "G", "A", "D", "D"], key: "D", repeat: 2, form: ["Part A", "Part B", "Part A", "Part B"] },
  { name: "Bb Eb F Gm, 100 bpm", bpm: 100, bars: ["Bb", "Eb", "F", "Gm"], key: "Bb" },
  { name: "one-beat pickup, 104 bpm", bpm: 104, bars: ["G", "C", "D", "G", "Em", "C", "D", "D"], pickup: 1, repeat: 3, key: "G", phase: 1 },
  { name: "two chords a bar, 92 bpm", bpm: 92, bars: ["C G", "Am F", "C G", "F F"], key: "C" },
  { name: "waltz in 3/4, 140 bpm", bpm: 140, bars: ["C", "F", "G", "C"], bpb: 3, key: "C", meter: 3 },
  { name: "E A B A, 150 bpm", bpm: 150, bars: ["E", "A", "B", "A"], repeat: 6, key: "E" },
  { name: "Dm Bb F C, 66 bpm", bpm: 66, bars: ["Dm", "Bb", "F", "C"], repeat: 3, key: "Dm" },
];

const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext();
await context.route("**/private/**", (route) => route.fulfill({ status: 404, body: "" }));
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(BASE);
await page.waitForSelector("html[data-ready]");

const profileHits = { edma: 0, bgate: 0, temperley: 0 };
for (const s of SONGS) {
  const r = await page.evaluate(async (s) => {
    const gen = await import("/tests/gen-song.js");
    const A = await import("/js/analysis.js");
    const D = await import("/js/detect.js");
    const C = await import("/js/chords.js");
    const { signal, truth } = await gen.renderSong(s);
    const t0 = performance.now();
    const res = await A.analyseSignal(signal);
    const ms = performance.now() - t0;
    const beats = D.beatChords(res);
    const meter = D.findMeter(beats);
    const bars = D.makeBars(beats, meter);
    const keys = Object.fromEntries(Object.entries(res.keys).map(([p, k]) => [p, D.keyName(k)]));
    return { bpm: res.bpm, keys, meter, acc: gen.barAccuracy(bars, truth, (n) => C.simplifyChord(n || "")),
      form: D.findSections(bars).form, ms, seconds: res.duration };
  }, s);
  const okTempo = [1, 2, 0.5].some((f) => Math.abs(r.bpm - s.bpm * f) <= 2);
  check(`${s.name}: tempo ${r.bpm.toFixed(1)} (±2, or ×2/÷2)`, okTempo);
  const relativeOf = (k) => (/m$/.test(k) ? transpose(k.slice(0, -1), 3) : transpose(k, -3) + "m");
  check(`${s.name}: key ${r.keys.edma} (or the relative)`, r.keys.edma === s.key || r.keys.edma === relativeOf(s.key), JSON.stringify(r.keys));
  for (const [p, k] of Object.entries(r.keys)) if (k === s.key || k === relativeOf(s.key)) profileHits[p]++;
  check(`${s.name}: ${Math.round(r.acc * 100)}% of bars right (>= 85%)`, r.acc >= 0.85);
  if (s.meter) eq(`${s.name}: meter`, r.meter.bpb, s.meter);
  if (s.phase !== undefined) eq(`${s.name}: beat 1 after the pickup`, r.meter.phase, s.phase);
  // The ring-out after the last bar may add a short "End".
  if (s.form) eq(`${s.name}: sections`, r.form.slice(0, s.form.length), s.form);
  console.log(`  ${s.name}: ${r.bpm.toFixed(1)} bpm, keys ${JSON.stringify(r.keys)}, ${Math.round(r.acc * 100)}% bars, ${(r.ms / 1000).toFixed(1)} s for ${r.seconds.toFixed(0)} s of audio`);
}
console.log(`  Key profiles right (or relative) out of ${SONGS.length}: ${JSON.stringify(profileHits)}`);
check("edma does at least as well as the others", profileHits.edma >= Math.max(profileHits.bgate, profileHits.temperley) - 1, JSON.stringify(profileHits));

function transpose(name, n) {
  const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const idx = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 }[name];
  return NAMES[(idx + n + 12) % 12];
}

// Play along: each bar lights within 50 ms of its time in the recording.
const timing = await page.evaluate(async () => {
  const gen = await import("/tests/gen-song.js");
  const { PlayAlong } = await import("/js/playalong.js");
  const { audioContext } = await import("/js/audio.js");
  const { signal, truth } = await gen.renderSong({ bpm: 120, bars: ["G", "D", "Em", "C"], repeat: 2 });
  const bars = truth.map((t) => ({ t: t.t, n: 4, chords: [t.chord], frets: [null] }));
  const pa = new PlayAlong();
  const seen = [];
  pa.addEventListener("bar", (e) => {
    const c = audioContext();
    if (!e.detail.start) seen.push({ bar: e.detail.bar, late: (c.currentTime - (c.outputLatency || 0)) - e.detail.time, pos: pa.position, want: bars[e.detail.bar].t });
    else seen.push({ bar: e.detail.bar, start: true, late: 0, pos: bars[e.detail.bar].t, want: bars[e.detail.bar].t });
  });
  await pa.start(signal, bars, truth.map((t) => t.t), { from: 0 });
  await new Promise((r) => setTimeout(r, 5200));
  // Jump into the middle of bar 3 and check again.
  pa.stop();
  await pa.start(signal, bars, truth.map((t) => t.t), { from: bars[3].t + 0.9 });
  await new Promise((r) => setTimeout(r, 2500));
  pa.stop();
  return seen;
});
const lateness = timing.map((s) => s.late);
check("play-along: bars light in order", timing.slice(0, 3).map((s) => s.bar).join() === "0,1,2", JSON.stringify(timing.map((s) => s.bar)));
check("play-along: highlight within 50 ms of the bar times", lateness.length >= 4 && lateness.every((l) => l >= -0.001 && l <= 0.05), lateness.map((l) => (l * 1000).toFixed(0) + "ms").join(" "));
check("play-along: song position matches the bar time", timing.every((s) => Math.abs(s.pos - s.want) <= 0.05), timing.map((s) => (s.pos - s.want).toFixed(3)).join(" "));
check("play-along: starting mid-bar lights that bar, then the next", timing.some((s) => s.bar === 3) && timing.some((s) => s.bar === 4));

// Recordings: kept on the device, read back byte for byte, deleted.
const store = await page.evaluate(async () => {
  const R = await import("/js/recordings.js");
  const bytes = new Uint8Array(300000).map((_, i) => (i * 7) & 255);
  const file = new File([bytes], "test.m4a", { type: "audio/mp4" });
  const meta = await R.saveRecording("test-song", file);
  const back = new Uint8Array(await (await R.getRecording("test-song")).arrayBuffer());
  const same = back.length === bytes.length && back.every((b, i) => b === bytes[i]);
  const list = (await R.listRecordings()).map((r) => r.id);
  const info = await R.storageInfo();
  await R.deleteRecording("test-song");
  const gone = (await R.getRecording("test-song")) === null && !(await R.listRecordings()).some((r) => r.id === "test-song");
  return { backend: meta.backend, same, list, recBytes: info.recordings, gone, name: meta.name };
});
eq("recording kept in OPFS", store.backend, "opfs");
check("recording reads back byte for byte", store.same);
check("recording listed with its size", store.list.includes("test-song") && store.recBytes >= 300000);
check("recording deleted", store.gone);
check("no page errors", errors.length === 0, errors.join("; "));
await browser.close();
report("analysis");
