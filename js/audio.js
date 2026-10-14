// The one AudioContext, its limiter and mixer bus, and the app's own sounds:
// the plucked-string synth, strums and the click.
// audioContext()/resumeAudio() follow speedy-pitcher's js/engine.js; the pluck
// synth, playNote, silenceNotes and the click come from Pimapeggio's app.js
// (both apps are the owner's). Everything is scheduled on the audio clock.

let ctx = null;
let bus = null;
const listeners = new Set();

// iOS 17+: "playback" plays through the silent switch and stays off the
// voice-call route.
export function setAudioSession(type) {
  if (navigator.audioSession) {
    try { navigator.audioSession.type = type; } catch (e) { /* unsupported */ }
  }
}

export function audioContext() {
  if (!ctx) {
    setAudioSession("playback");
    // "playback" asks for bigger hardware buffers: more headroom for the
    // time-stretcher on a phone, and nothing here needs low latency.
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
    ctx.addEventListener("statechange", () => listeners.forEach((fn) => fn(ctx.state)));
    buildBus();
  }
  return ctx;
}

// iOS also has an "interrupted" state (calls, Siri, other apps' audio).
export function resumeAudio() {
  const c = audioContext();
  if (c.state !== "running") return c.resume().catch(() => {});
  return Promise.resolve();
}

export function onAudioState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Starting audio needs a user gesture; on touch screens pointerdown doesn't
// count, so resume at the end of every tap too.
if (typeof document !== "undefined") {
  ["pointerup", "touchend", "click", "keydown"].forEach((type) => {
    document.addEventListener(type, () => {
      if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    }, true);
  });
}

/* ---- Mixer bus: tracks -> master -> limiter -> speakers ---- */

function buildBus() {
  // A gentle limiter: ringing notes overlap, and strums stack six plucks.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  limiter.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(limiter);
  bus = { limiter, master, tracks: new Map() };
}

// A mixer track: one GainNode into the master, with volume and mute.
export function track(name, volume = 1) {
  audioContext();
  let t = bus.tracks.get(name);
  if (t) return t;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(bus.master);
  t = {
    name, gain, volume, muted: false,
    setVolume(v) { this.volume = v; this.apply(); },
    setMuted(m) { this.muted = m; this.apply(); },
    apply() { this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, ctx.currentTime, 0.02); },
  };
  bus.tracks.set(name, t);
  return t;
}

export function tracks() { return bus ? [...bus.tracks.values()] : []; }
export function masterGain() { audioContext(); return bus.master; }

/* ---- Additive plucked string (Pimapeggio's renderPluck) ----
   Built harmonic by harmonic rather than from a Karplus-Strong noise burst,
   so brightness is fully under control: a pluck-position spectrum that rolls
   off steeply above ~2 kHz, with upper harmonics dying away faster than the
   fundamental, the way a real string mellows as it rings. */

const PLUCK_SECONDS = 4;
const PLUCK_POS = 0.2;      // pluck point as a fraction of string length
const PLUCK_TILT = 1.0;     // harmonic amplitude falls as 1 / h^tilt
const PLUCK_CUTOFF = 2000;  // Hz; -12 dB/octave above this
const PLUCK_BODY = 250;     // Hz; partials below this are weakened (guitar body, phone speakers)
const INHARMONICITY = 0.00008;

export function renderPluck(freq, sr) {
  const n = Math.floor(sr * PLUCK_SECONDS);
  const acc = new Float64Array(n);
  const sustain = 6 * Math.pow(82 / freq, 0.3); // fundamental T60, seconds

  for (let h = 1; h <= 48; h++) {
    const f = h * freq * Math.sqrt(1 + INHARMONICITY * h * h);
    if (f > 6000 || f > sr * 0.45) break;
    const amp = Math.abs(Math.sin(Math.PI * h * PLUCK_POS)) / Math.pow(h, PLUCK_TILT) /
                Math.sqrt(1 + Math.pow(f / PLUCK_CUTOFF, 4)) /
                Math.sqrt(1 + Math.pow(PLUCK_BODY / f, 2));
    if (amp < 1e-4) continue; // node at the pluck point
    const t60 = sustain / (1 + Math.pow(f / 1000, 1.3));
    // Damped sinusoid amp * r^k * sin(w k + phase) via its two-term recurrence.
    const r = Math.pow(0.001, 1 / (t60 * sr));
    const w = 2 * Math.PI * f / sr;
    const c = 2 * r * Math.cos(w), r2 = r * r;
    const phase = h * 2.4; // spread phases to keep the peak (and loudness jumps) down
    let y0 = amp * Math.sin(phase);
    let y1 = amp * Math.sin(phase - w) / r;
    for (let k = 0; k < n; k++) {
      acc[k] += y0;
      const y = c * y0 - r2 * y1;
      y1 = y0;
      y0 = y;
    }
  }

  // Raised-cosine attack so the onset has no click, then normalize and
  // fade the tail to silence.
  const attack = Math.floor(sr * 0.008);
  for (let i = 0; i < attack; i++) acc[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / attack);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(acc[i]));
  const norm = peak > 0 ? 0.8 / peak : 1;
  const fadeStart = n - Math.floor(sr * 0.3);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = acc[i] * norm;
    if (i > fadeStart) v *= (n - i) / (n - fadeStart);
    data[i] = v;
  }
  return data;
}

const pluckCache = new Map(); // midi -> AudioBuffer

export function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

export function getPluckBuffer(midi) {
  let buf = pluckCache.get(midi);
  if (buf) return buf;
  const c = audioContext();
  const data = renderPluck(midiToFreq(midi), c.sampleRate);
  buf = c.createBuffer(1, data.length, c.sampleRate);
  buf.copyToChannel(data, 0);
  pluckCache.set(midi, buf);
  return buf;
}

// Render notes ahead of time, one per task, so playback doesn't stall on the
// first strum of each chord. Resolves when all are ready.
export function warmNotes(midis) {
  const todo = [...new Set(midis)].filter((m) => !pluckCache.has(m));
  return new Promise((resolve) => {
    const next = () => {
      if (!todo.length) { resolve(); return; }
      getPluckBuffer(todo.shift());
      setTimeout(next, 0);
    };
    next();
  });
}

/* ---- Voices: one per string, like a real guitar ----
   A new note on a string damps the previous one while other strings ring on.
   Each instrument (app guitar, synth-band bass...) has its own set and track. */

export class StringVoices {
  constructor(trackName = "guitar") {
    this.trackName = trackName;
    this.voices = new Array(7).fill(null);
    this.live = new Set();
    this.cents = 0;  // fine tune for every note (e.g. to match a recording)
  }

  playNote(string, midi, time, level) {
    const c = audioContext();
    const out = track(this.trackName).gain;
    const prev = this.voices[string];
    if (prev && this.live.has(prev)) {
      prev.gain.gain.setTargetAtTime(0, time, 0.015);
      try { prev.src.stop(time + 0.2); } catch (e) { /* already stopped */ }
    }
    const src = c.createBufferSource();
    src.buffer = getPluckBuffer(midi);
    if (this.cents) src.detune.value = this.cents;
    const gain = c.createGain();
    gain.gain.value = level;
    src.connect(gain);
    gain.connect(out);
    src.start(time);
    const v = { src, gain, start: time, string, midi };
    this.voices[string] = v;
    this.live.add(v);
    src.onended = () => this.live.delete(v);
    return v;
  }

  // Damp a string at `time` (for "x" muted strums and rests).
  damp(string, time, fade = 0.03) {
    const v = this.voices[string];
    if (!v || !this.live.has(v)) return;
    v.gain.gain.setTargetAtTime(0, time, fade);
    try { v.src.stop(time + fade * 8); } catch (e) { /* already stopped */ }
  }

  silence(fade = 0.08) {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const v of this.live) {
      if (v.start > now) {
        try { v.src.stop(now); } catch (e) { /* already stopped */ }
      } else {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, fade);
        try { v.src.stop(now + fade * 8); } catch (e) { /* already stopped */ }
      }
    }
    this.voices.fill(null);
  }
}

/* ---- Strums ----
   A strum is staggered plucks across the strings of a voicing: low to high
   for a downstroke, high to low (top four strings) for an upstroke. */

const OPEN_MIDI = [null, 64, 59, 55, 50, 45, 40]; // by string, 1 = high E

// frets: low E to high E, null for unplayed. Returns [{ string, midi, at }].
export function strumNotes(frets, { dir = "D", capo = 0, spread = 0.012 } = {}) {
  let strings = [];
  frets.forEach((f, i) => { if (f !== null) strings.push({ string: 6 - i, midi: OPEN_MIDI[6 - i] + f + capo }); });
  if (dir === "U") strings = strings.filter((s) => s.string <= 4).reverse();
  return strings.map((s, k) => ({ ...s, at: k * spread }));
}

export function strum(voices, frets, time, { dir = "D", capo = 0, level = 0.34, spread } = {}) {
  const notes = strumNotes(frets, { dir, capo, spread: spread ?? (dir === "U" ? 0.009 : 0.013) });
  const per = level / Math.sqrt(Math.max(1, notes.length));
  notes.forEach((n, k) => {
    // Upstrokes are lighter; the first strings hit carry the accent.
    const l = per * (dir === "U" ? 0.7 : 1) * (1 - k * 0.04);
    voices.playNote(n.string, n.midi, time + n.at, l);
  });
  return notes;
}

// "D - D U - U D U" -> slots [{ dir: "D"|"U"|null, accent, mute }].
// D/U strum, d/u lighter, x a muted chuck, - a rest (strings ring on).
export function parseStrum(str) {
  const slots = String(str || "").trim().split(/\s+/).filter(Boolean).map((t) => {
    if (t === "-" || t === ".") return { dir: null };
    if (/^[DU]$/.test(t)) return { dir: t, accent: true };
    if (/^[du]$/.test(t)) return { dir: t.toUpperCase(), accent: false };
    if (/^[xX]$/.test(t)) return { dir: "D", mute: true };
    throw new Error("Bad strum token: " + t);
  });
  if (!slots.length) throw new Error("Empty strum pattern");
  return slots;
}

// A plain strum, one downstroke per beat: used when a chart has no strum
// pattern, and labelled as such.
export function plainStrum(time = "4/4") {
  const [n, d] = String(time).split("/").map(Number);
  if (d === 8 && n % 3 === 0) return Array.from({ length: n / 3 }, () => "D - -").join(" ");
  return Array.from({ length: n || 4 }, () => "D").join(" ");
}

/* ---- Click: Pimapeggio's "wood" sound ---- */

let noiseBuffer = null;

export function playClick(time, accented) {
  const c = audioContext();
  const out = track("click", 0.8).gain;
  if (!noiseBuffer) {
    const len = Math.floor(c.sampleRate * 0.1);
    noiseBuffer = c.createBuffer(1, len, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  const env = (peak, decay) => {
    const g = c.createGain();
    g.gain.setValueAtTime(peak, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + decay);
    g.connect(out);
    return g;
  };
  const level = accented ? 1.0 : 0.7;
  const noise = c.createBufferSource();
  noise.buffer = noiseBuffer;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = accented ? 2200 : 1600;
  bp.Q.value = 9;
  noise.connect(bp).connect(env(level * 1.4, 0.06));
  noise.start(time);
  noise.stop(time + 0.08);
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(accented ? 1050 : 780, time);
  osc.frequency.exponentialRampToValueAtTime(accented ? 700 : 520, time + 0.035);
  osc.connect(env(level * 0.9, 0.05));
  osc.start(time);
  osc.stop(time + 0.07);
}

/* ---- Wake lock while playing ---- */

let wakeLock = null;

export async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (e) { /* not critical */ }
}

export function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
