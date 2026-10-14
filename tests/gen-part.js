// Renders made-up guitar parts with the app's own pluck synth, note by note,
// on known strings and frets: library patterns and written-out bars (with @
// frets) over a progression, in any tuning, with soft drums so the beat is
// clear. Like a real string (and the app's StringVoices), a string plucked
// again stops its previous note. Runs in the browser (it imports the app's modules) and returns the
// samples and the truth; nothing is written to disk.
//   const { signal, truth } = await renderPart({ bpm: 90, bars: [...], tuning: "D A D F# A D" })
// bars: [{ chord: "G", pattern: "travis" } | { chord: "C", steps: "pB i3@2 pA m ..." }]
// truth: { notes: [{ t, midi, string, fret }], bars: [{ t, t1, chord, pattern }] }

import { renderPluck, midiToFreq } from "../js/audio.js";
import { bestVoicing, pimaChord } from "../js/chords.js";
import { PATTERN_BY_ID, parseSteps, noteSound } from "../js/patterns.js";
import { fillBar } from "../js/part.js";
import { tuningFrom } from "../js/tuning.js";

const SR = 44100;
const HOME = { i: 3, m: 2, a: 1 };

export async function renderPart({ bpm, bars, repeat = 2, beats = 4, tuning = null, lead = 0.6, seed = 3 }) {
  const t = tuningFrom(tuning ? { notes: tuning } : null);
  const beat = 60 / bpm;
  const all = [];
  for (let r = 0; r < repeat; r++) all.push(...bars);
  const total = lead + all.length * beats * beat + 3;
  const len = Math.ceil(total * SR);
  const out = new Float32Array(len);
  const strings = Array.from({ length: 7 }, () => new Float32Array(len));
  const cache = new Map();
  const note = (midi) => {
    if (!cache.has(midi)) cache.set(midi, renderPluck(midiToFreq(midi), SR).subarray(0, SR * 2));
    return cache.get(midi);
  };
  const add = (data, at, gain, buf = out) => {
    const i0 = Math.round(at * SR);
    const n = Math.min(data.length, buf.length - i0);
    for (let i = 0; i < n; i++) buf[i0 + i] += data[i] * gain;
  };
  // A new note on a string: the old one fades out over 8 ms, then the new one rings.
  const pluck = (string, data, at, gain) => {
    const buf = strings[string], i0 = Math.round(at * SR), fade = Math.round(0.008 * SR);
    for (let i = i0; i < buf.length; i++) buf[i] *= i - i0 < fade ? 1 - (i - i0) / fade : 0;
    add(data, at, gain, buf);
  };
  let s = seed >>> 0;
  const rand = () => ((s = Math.imul(s, 1664525) + 1013904223 >>> 0) / 4294967296) * 2 - 1;
  const kick = new Float32Array(Math.round(0.12 * SR));
  let ph = 0;
  for (let i = 0; i < kick.length; i++) { ph += 2 * Math.PI * (50 + 60 * Math.exp(-i / (0.03 * SR))) / SR; kick[i] = Math.sin(ph) * Math.exp(-i / (0.05 * SR)); }
  const hat = new Float32Array(Math.round(0.04 * SR));
  let prev = 0;
  for (let i = 0; i < hat.length; i++) { const x = rand(); hat[i] = (x - prev) * Math.exp(-i / (0.01 * SR)); prev = x; }

  const truth = { notes: [], bars: [] };
  all.forEach((b, bi) => {
    const t0 = lead + bi * beats * beat;
    const v = bestVoicing(b.chord, null, t);
    const ch = pimaChord(b.chord, { [b.chord]: v.spec }, t);
    const steps = b.pattern ? fillBar(PATTERN_BY_ID.get(b.pattern), beats) : parseSteps(b.steps);
    const dur = beats * beat / steps.length;
    truth.bars.push({ t: t0, t1: t0 + beats * beat, chord: b.chord, pattern: b.pattern || null, steps: steps.length });
    steps.forEach((st, k) => {
      const at = t0 + k * dur;
      for (const n of st) {
        const x = noteSound(n, ch, HOME, 0, t.open);
        pluck(x.string, note(x.midi), at, n.f === "p" ? 0.22 : 0.18);
        truth.notes.push({ t: at, midi: x.midi, string: x.string, fret: x.fret });
      }
    });
    for (let k = 0; k < beats; k++) {
      if (k % 2 === 0) add(kick, t0 + k * beat, 0.5);
      add(hat, t0 + k * beat, 0.06);
    }
  });
  for (const buf of strings) for (let i = 0; i < len; i++) out[i] += buf[i];
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < out.length; i++) out[i] *= 0.8 / peak;
  return { signal: out, truth, tuning: t };
}
