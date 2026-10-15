// The synth band (plan §9.2): bass and drums generated from a chart, played
// with the app guitar in Player mode, with or without a recording. Nothing
// here is transcribed: the bass plays the chords' roots and fifths (a slash
// chord's bass note first), with a step into the next chord; the drums play
// a groove chosen by the meter, tempo and style, a crash where a section
// starts and a fill where one ends. A bar of N.C. (a break) is silent.
// The band follows the chart's own bar times when it has them (an analysed
// recording, so the band and the recording line up, loops and lyric timing
// included), else bars laid out at the chart's tempo (bandTimeline).
// Pure: node tests it. Events are in song seconds; js/player.js schedules
// them through the engine at any speed, and transposes them.

import { parseChord, splitBars, QUALITIES } from "./chords.js";

const BASS_LOW = 28, BASS_HIGH = 47;   // E1 .. B2

// A chart without bar times -> bars at its tempo, in the order of its form:
// { bars: [{ t, n, chords }], beats: [t], analysis: { segments: [{ name, bars: [first, last] }], bpb } }.
export function bandTimeline(chart, { tempo, beats = 4, lead = 0.5 } = {}) {
  const beat = 60 / (tempo || chart.tempo || 100);
  const secs = chart.sections || [];
  const form = chart.form && chart.form.length ? chart.form : secs.map((s) => s.name);
  const bars = [], segments = [], times = [];
  let t = lead;
  for (const name of form) {
    const s = secs.find((x) => x.name === name);
    if (!s) continue;
    const one = splitBars(s.chords);
    const all = Array.from({ length: Math.max(1, s.repeat || 1) }, () => one).flat();
    if (!all.length) continue;
    const first = bars.length;
    for (const chords of all) {
      bars.push({ t: round(t), n: beats, chords: chords.slice() });
      for (let k = 0; k < beats; k++) times.push(round(t + k * beat));
      t += beats * beat;
    }
    segments.push({ name, bars: [first, bars.length - 1] });
  }
  times.push(round(t));
  return { bars, beats: times, analysis: { segments, bpb: beats }, end: round(t) };
}

const round = (x) => Math.round(x * 1000) / 1000;

// The groove for a meter, tempo and style: per bar, the hits on a grid of
// `sub` steps per beat. { name, sub, kick, snare, rim, hat } (step indexes).
export function grooveFor({ beats = 4, sub = 2, tempo = 100, style = null } = {}) {
  const soft = style === "fingerpicked" || tempo < 76;
  const steps = (list) => list.map((b) => Math.round(b * sub));
  if (sub === 3) {
    // Compound (6/8, 12/8): kick on 1, snare on the next dotted beat, hats on every eighth.
    return { name: "compound", sub, kick: steps([0]), snare: soft ? [] : steps([1, 3].filter((b) => b < beats)), rim: soft ? steps([1, 3].filter((b) => b < beats)) : [],
      hat: Array.from({ length: beats * sub }, (_, k) => k) };
  }
  const allBeats = Array.from({ length: beats }, (_, k) => k);
  if (beats === 3) {
    // A waltz: kick on 1, the other two beats lighter.
    return { name: "waltz", sub, kick: steps([0]), snare: [], rim: steps([1, 2]), hat: soft ? steps(allBeats) : Array.from({ length: beats * sub }, (_, k) => k) };
  }
  const back = allBeats.filter((b) => b % 2 === 1);
  if (soft) {
    // Brushes, more or less: kick on 1 and 3, a cross-stick on the backbeat, hats on the beat.
    return { name: "soft", sub, kick: steps(allBeats.filter((b) => b % 2 === 0)), snare: [], rim: steps(back), hat: steps(allBeats) };
  }
  const fast = tempo >= 150;
  return { name: fast ? "rock, quarter hats" : "rock", sub, kick: steps(allBeats.filter((b) => b % 2 === 0)), snare: steps(back), rim: [],
    hat: fast ? steps(allBeats) : Array.from({ length: beats * sub }, (_, k) => k) };
}

// The chord's bass note (a slash chord's bass, else its root) and fifth, as pitch classes.
function bassNotes(name) {
  const c = parseChord(name);
  if (!c || c.nc) return null;
  const iv = (QUALITIES[c.q] || QUALITIES[""]).iv;
  const fifth = iv.find((x) => x >= 6 && x <= 8) ?? 7;
  return { low: c.bass ?? c.root, root: c.root, fifth: (c.root + fifth) % 12 };
}

// The MIDI note of pitch class pc nearest `near`, in the bass's range.
function nearest(pc, near) {
  let best = null;
  for (let m = BASS_LOW; m <= BASS_HIGH; m++) if (m % 12 === pc && (best === null || Math.abs(m - near) < Math.abs(best - near))) best = m;
  return best;
}

// timed: { bars: [{ t, t1, n, chords }], sections: [{ name, bars: [indexes] }] }
// -> { bass: [{ t, dur, midi, vel }], drums: [{ t, drum, vel }], groove }.
export function arrange(timed, { beats = 4, sub = 2, tempo = 100, style = null } = {}) {
  const groove = grooveFor({ beats, sub, tempo, style });
  const bass = [], drums = [];
  const bars = timed.bars;
  const starts = new Set((timed.sections || []).map((s) => s.bars[0]));
  const ends = new Set((timed.sections || []).map((s) => s.bars[s.bars.length - 1]));
  // The chords in order, each with its time span.
  const segs = [];
  bars.forEach((b, i) => {
    const n = b.chords.length;
    b.chords.forEach((name, k) => segs.push({ name, bar: i, t0: b.t + (b.t1 - b.t) * k / n, t1: b.t + (b.t1 - b.t) * (k + 1) / n, beats: (b.n || beats) / n }));
  });
  let near = 40;
  segs.forEach((s, k) => {
    const notes = bassNotes(s.name);
    if (!notes) return;
    const beat = (s.t1 - s.t0) / s.beats;
    const next = segs[k + 1] && bassNotes(segs[k + 1].name);
    const low = nearest(notes.low, near);
    near = low;
    const fifth = nearest(notes.fifth, low + 5);
    const vel = 0.85 + 0.1 * ((k * 7) % 3) / 2;
    if (s.beats >= 4) {
      const half = Math.floor(s.beats / 2);
      bass.push({ t: s.t0, dur: beat * half * 0.92, midi: low, vel });
      // The fifth on the second half; the last beat steps into the next chord when it changes.
      const walk = next && next.low !== notes.low;
      bass.push({ t: s.t0 + half * beat, dur: beat * (walk ? half - 1 : half) * 0.92, midi: fifth, vel: vel * 0.8 });
      if (walk) {
        const target = nearest(next.low, low);
        const step = target > low ? target - (Math.abs(target - low) > 2 ? 2 : 1) : target + (Math.abs(target - low) > 2 ? 2 : 1);
        bass.push({ t: s.t1 - beat, dur: beat * 0.9, midi: Math.max(BASS_LOW, Math.min(BASS_HIGH, step)), vel: vel * 0.7 });
      }
    } else if (s.beats >= 3) {
      bass.push({ t: s.t0, dur: beat * 2 * 0.92, midi: low, vel });
      bass.push({ t: s.t0 + 2 * beat, dur: beat * 0.9, midi: fifth, vel: vel * 0.75 });
    } else {
      bass.push({ t: s.t0, dur: (s.t1 - s.t0) * 0.92, midi: low, vel });
    }
  });
  bars.forEach((b, i) => {
    if (b.chords.every((c) => { const p = parseChord(c); return !p || p.nc; })) return;   // a break
    const n = b.n || beats;
    const step = (b.t1 - b.t) / (n * groove.sub);
    const at = (k) => b.t + k * step;
    const last = ends.has(i) && i < bars.length - 1;
    const fillFrom = last ? (n - 1) * groove.sub : Infinity;
    for (const k of groove.kick) if (k < n * groove.sub && k < fillFrom) drums.push({ t: at(k), drum: "kick", vel: k === 0 ? 1 : 0.8 });
    for (const k of groove.snare) if (k < n * groove.sub && k < fillFrom) drums.push({ t: at(k), drum: "snare", vel: 0.8 });
    for (const k of groove.rim) if (k < n * groove.sub && k < fillFrom) drums.push({ t: at(k), drum: "rim", vel: 0.6 });
    for (const k of groove.hat) if (k < n * groove.sub && k < fillFrom) drums.push({ t: at(k), drum: "hat", vel: k % groove.sub === 0 ? 0.55 : 0.35 });
    if (starts.has(i) && i > 0) drums.push({ t: b.t, drum: "crash", vel: 0.7 });
    if (last) {
      // A fill on the section's last beat: four sixteenths (two eighths when it's soft or a waltz).
      const hits = groove.name === "soft" || groove.name === "waltz" ? 2 : 4;
      const beat = (b.t1 - b.t) / n;
      for (let h = 0; h < hits; h++) drums.push({ t: b.t + (n - 1) * beat + h * beat / hits, drum: groove.name === "soft" ? "rim" : "snare", vel: 0.55 + 0.1 * h });
    }
  });
  drums.sort((x, y) => x.t - y.t);
  return { bass, drums, groove: groove.name };
}
