// Renders test songs with the app's own pluck synth: a strummed guitar,
// a plucked bass on beats 1 and 3, and simple synthesized drums, at a known
// tempo, key and progression. Runs in the browser (it imports the app's
// modules) and returns samples; nothing is written to disk.
//   const { signal, truth } = await renderSong({ bpm: 96, bars: ["G", "D", "Em", "C"], repeat: 4 })

import { renderPluck, midiToFreq } from "../js/audio.js";
import { bestVoicing, voicingMidi, parseChord } from "../js/chords.js";

const SR = 44100;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s, 1664525) + 1013904223 >>> 0) / 4294967296) * 2 - 1;
}

// bars: chord names per bar; "C G" splits a bar in two halves. pickup: beats
// of the last chord before bar 1 (an upbeat), so beat 1 isn't the first beat.
export async function renderSong({ bpm, bars, repeat = 4, bpb = 4, lead = 0.5, drums = true, seed = 7, pickup = 0 }) {
  const beat = 60 / bpm;
  const all = [];
  for (let r = 0; r < repeat; r++) all.push(...bars);
  const total = lead + (all.length * bpb + pickup) * beat + 2.5;
  const out = new Float32Array(Math.ceil(total * SR));
  const notes = new Map();
  const note = (midi) => {
    if (!notes.has(midi)) notes.set(midi, renderPluck(midiToFreq(midi), SR).subarray(0, SR * 2));
    return notes.get(midi);
  };
  const add = (data, t, gain) => {
    const at = Math.round(t * SR);
    const n = Math.min(data.length, out.length - at);
    for (let i = 0; i < n; i++) out[at + i] += data[i] * gain;
  };
  const rand = rng(seed);
  const noise = (len, decay, hp) => {
    const d = new Float32Array(Math.round(len * SR));
    let prev = 0;
    for (let i = 0; i < d.length; i++) {
      const x = rand();
      d[i] = (hp ? x - prev : x) * Math.exp(-i / (decay * SR));
      prev = x;
    }
    return d;
  };
  const kick = new Float32Array(Math.round(0.15 * SR));
  let ph = 0;
  for (let i = 0; i < kick.length; i++) {
    const f = 50 + 70 * Math.exp(-i / (0.03 * SR));
    ph += 2 * Math.PI * f / SR;
    kick[i] = Math.sin(ph) * Math.exp(-i / (0.06 * SR));
  }
  const snare = noise(0.12, 0.04, false), hat = noise(0.05, 0.012, true);

  const truth = [];
  const start = lead + pickup * beat;
  const play = (name, t) => {
    const v = bestVoicing(name);
    const midis = voicingMidi(v.frets);
    const root = parseChord(name).root;
    return { midis, root };
  };
  // The upbeat: the last bar's (last) chord, on the beats before bar 1.
  if (pickup) {
    const last = all[all.length - 1].split(/\s+/).pop();
    const { midis } = play(last);
    for (let k = 0; k < pickup; k++) midis.forEach((m, i) => add(note(m), lead + k * beat + i * 0.012, 0.16));
  }
  all.forEach((bar, b) => {
    const t0 = start + b * bpb * beat;
    const names = bar.split(/\s+/);
    names.forEach((name, h) => truth.push({ t: t0 + h * bpb * beat / names.length, t1: t0 + (h + 1) * bpb * beat / names.length, chord: name }));
    for (let k = 0; k < bpb; k++) {
      const name = names[Math.min(names.length - 1, Math.floor(k * names.length / bpb))];
      const { midis, root } = play(name);
      const t = t0 + k * beat;
      // Downstrokes on the beat, a light upstroke on the off-beat of 2 and 4.
      midis.forEach((m, i) => add(note(m), t + i * 0.012, 0.16));
      if (k % 2 === 1) midis.slice(-4).reverse().forEach((m, i) => add(note(m), t + beat / 2 + i * 0.009, 0.08));
      if (k % 2 === 0) add(note(36 + root + (root < 4 ? 12 : 0)), t, 0.45);
      if (drums) {
        if (k % 2 === 0) add(kick, t, 0.9);
        else add(snare, t, 0.35);
        add(hat, t, 0.12);
        add(hat, t + beat / 2, 0.08);
      }
    }
  });
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < out.length; i++) out[i] *= 0.8 / peak;
  return { signal: out, truth, beat, lead: start };
}

// Share of detected bars that are right: each chord of the bar (one, or one
// per half) matches, as a triad, what was played at that point.
export function barAccuracy(bars, truth, simplify) {
  let ok = 0, n = 0;
  for (const b of bars) {
    const end = b.t1 ?? b.t + 2;
    const parts = b.chords.length;
    const want = [];
    for (let h = 0; h < parts; h++) {
      const at = b.t + (end - b.t) * (h + 0.5) / parts;
      const tr = truth.find((x) => at >= x.t && at < x.t1);
      want.push(tr ? tr.chord : null);
    }
    if (want.some((w) => w === null)) continue;
    n++;
    if (b.chords.every((c, h) => simplify(c) === simplify(want[h]))) ok++;
  }
  return n ? ok / n : 0;
}

// 16-bit PCM WAV bytes for a mono signal, so a test can hand the app a "file".
export function wavBytes(signal, sr = SR) {
  const n = signal.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, signal[i])) * 32767, true);
  return new Uint8Array(buf);
}
