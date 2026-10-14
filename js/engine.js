// The recording player: Signalsmith Stretch plays the song with independent
// speed and pitch, and loop jumps, count-in clicks and speed-trainer steps are
// all scheduled ahead on the audio clock, so loops stay seamless even when the
// page is busy or in the background. From speedy-pitcher's js/engine.js (the
// owner's app), with its output going through the Songbook's mixer
// ("recording" and "click" tracks) and helpers for mapping song time to the
// audio clock, which the app guitar and the highlights use.

import SignalsmithStretch from "../vendor/signalsmith-stretch/SignalsmithStretch.mjs";
import { audioContext, track } from "./audio.js";
import { trainerRate } from "./trainer.js";

// 200 ms blocks rather than the default 120: fractional pitch shifts (fine
// tuning) land within ~1-2 cents on real recordings instead of ~5, at ~20% more
// CPU. splitComputation spreads each block's FFT work across render quanta
// instead of doing it all in one: smoother load, fewer dropouts on phones.
export const STRETCH_CONFIG = { blockMs: 200, intervalMs: 40, splitComputation: true };

const HORIZON_VISIBLE = 1.5;  // seconds of future loop jumps to keep scheduled
const HORIZON_HIDDEN = 12;    // longer while backgrounded (timers get throttled)

let nodePromise = null;

export function makeClick(c, freq, len = 0.045) {
  const n = Math.floor(c.sampleRate * len);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / c.sampleRate;
    const env = Math.min(1, i / (c.sampleRate * 0.001)) * Math.exp(-t / 0.012);
    d[i] = env * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(4 * Math.PI * freq * t)) * 0.6;
  }
  return buf;
}

export class FileEngine extends EventTarget {
  constructor() {
    super();
    this.kind = "file";
    this.duration = 0;
    this.playing = false;
    this.rate = 1;
    this.semitones = 0;
    this.formant = false;
    this.loop = { a: null, b: null, on: false };
    this.countIn = { beats: 0, beatSec: 0.6 };   // beatSec in song time
    this.trainer = null;  // { start, step, every, target, passes, rate } when running
    this.plan = [];       // mirror of the stretch node's schedule
    this.events = [];     // future UI events: { time, type, ... }
    this.clicks = [];     // scheduled click sources
    this.pausedAt = 0;
    this.passes = 0;      // completed loop passes, for display
    this.epoch = 0;       // bumped when pass counting restarts (new loop, trainer)
    this.lead = 0.1;
  }

  async init() {
    if (this.node) return;
    if (!nodePromise) {
      const c = audioContext();
      nodePromise = (async () => {
        const node = await SignalsmithStretch(c);
        await node.configure(STRETCH_CONFIG);
        return node;
      })();
    }
    const c = audioContext();
    this.node = await nodePromise;
    this.node.connect(track("recording").gain);
    this.clickGain = track("click").gain;
    this.clickHi = makeClick(c, 1760);
    this.clickLo = makeClick(c, 1175);
    // Schedule user actions this far ahead: the node needs that long to
    // compensate its own latency, and our position mirror then stays exact.
    this.lead = Math.min(0.35, (await this.node.latency()) + 0.02);
    this.timer = setInterval(() => this.tick(), 50);
  }

  // channels: Float32Array per channel at the context's sample rate. They are
  // transferred to the audio thread (the main thread no longer holds a copy).
  async load(channels, duration) {
    // A newer load may start while this one waits (e.g. for the first tap on
    // iOS); only the latest may touch the node, or the songs would get mixed.
    const seq = this.loadSeq = (this.loadSeq || 0) + 1;
    await this.init();
    if (seq !== this.loadSeq) return;
    this.stopNow();
    await this.node.dropBuffers();
    if (seq !== this.loadSeq) return;
    const transfer = channels.map((c) => c.buffer);
    try {
      await this.node.addBuffers(channels, transfer);
    } catch (e) {
      await this.node.addBuffers(channels.map((c) => c.slice()));
    }
    this.duration = duration;
    this.pausedAt = 0;
    this.plan = [{ output: 0, input: 0, rate: this.rate, active: false }];
  }

  unload() {
    this.stopNow();
    this.duration = 0;
    if (this.node) this.node.dropBuffers();
  }

  get now() { return audioContext().currentTime; }

  // What's audible right now, accounting for the hardware output latency.
  get position() {
    if (!this.playing) return this.pausedAt;
    const c = audioContext();
    const t = c.currentTime - (c.outputLatency || c.baseLatency || 0);
    // Changes are scheduled `lead` ahead: until they're heard, report where
    // playback is about to continue from rather than the old schedule.
    if (this.pending && t < this.pending.until) return this.pending.pos;
    return Math.max(0, Math.min(this.duration, this.posAt(t)));
  }

  segAt(t) {
    let seg = this.plan[0];
    for (const s of this.plan) { if (s.output <= t) seg = s; else break; }
    return seg;
  }

  posAt(t) {
    const s = this.segAt(t);
    if (!s) return this.pausedAt;
    return s.active ? s.input + Math.max(0, t - s.output) * s.rate : s.input;
  }

  // The rate actually playing (the trainer may have changed it on a loop).
  get currentRate() {
    if (!this.playing) return this.rate;
    return this.segAt(this.now).rate;
  }

  get inCountIn() {
    if (!this.playing) return false;
    const s = this.segAt(this.now);
    return !s.active;
  }

  sched(seg) {
    while (this.plan.length && this.plan[this.plan.length - 1].output >= seg.output) this.plan.pop();
    this.plan.push(seg);
    this.node.schedule({
      output: seg.output, outputTime: seg.output, input: seg.input, rate: seg.rate, active: seg.active,
      semitones: this.semitones, formantCompensation: this.formant, formantBaseHz: 0,
    });
  }

  cancelFrom(t) {
    this.events = this.events.filter((e) => e.time < t);
    this.clicks = this.clicks.filter((c) => {
      if (c.when >= t - 0.001) { try { c.src.stop(); } catch (e) { /* not started */ } return false; }
      return c.when > this.now - 1;
    });
  }

  stopNow() {
    if (!this.node) return;
    const t = this.now;
    this.cancelFrom(-1);
    this.plan = [{ output: t, input: this.pausedAt, rate: this.rate, active: false }];
    this.node.schedule({ output: t, outputTime: t, input: this.pausedAt, active: false });
    this.playing = false;
  }

  scheduleClicks(t0, beats, beatDur, pass) {
    for (let i = 0; i < beats; i++) {
      const when = t0 + i * beatDur;
      const src = audioContext().createBufferSource();
      src.buffer = i === 0 ? this.clickHi : this.clickLo;
      src.connect(this.clickGain);
      src.start(when);
      this.clicks.push({ src, when });
      this.addEvent({ time: when, type: "beat", beat: i + 1, beats, pass });
    }
  }

  // Start playing `input` at audio time t0, with a count-in first if enabled.
  startAt(t0, input, rate, countIn) {
    const beats = countIn ? this.countIn.beats : 0;
    if (beats > 0) {
      const beatDur = this.countIn.beatSec / rate;
      this.sched({ output: t0, input, rate, active: false });
      this.scheduleClicks(t0, beats, beatDur, null);
      t0 += beats * beatDur;
    }
    this.sched({ output: t0, input, rate, active: true });
  }

  // Throw away the future and continue from the current state at now + lead.
  replan({ countIn = false, input = null } = {}) {
    if (!this.node) return;
    const t0 = this.now + this.lead;
    this.cancelFrom(t0);
    if (!this.playing) {
      this.sched({ output: t0, input: input ?? this.pausedAt, rate: this.rate, active: false });
      return;
    }
    let pos = input ?? this.posAt(t0);
    const seg = this.segAt(t0);
    // Mid count-in: start the count again at the new settings.
    if (input === null && !seg.active) countIn = true;
    if (pos >= this.duration) pos = 0;
    this.pending = input === null ? null : { until: t0, pos };
    this.startAt(t0, pos, this.rate, countIn);
    this.tick();
  }

  play() {
    if (!this.node || !this.duration || this.playing) return;
    let pos = this.pausedAt;
    const { a, b, on } = this.loop;
    if (on && a !== null && b !== null && (pos < a || pos >= b)) pos = a;
    if (pos >= this.duration - 0.05) pos = on && a !== null ? a : 0;
    this.pausedAt = pos;
    this.playing = true;
    if (this.trainer) this.rate = this.trainer.rate;
    this.replan({ countIn: true, input: pos });
    this.emit("state");
  }

  pause() {
    if (!this.playing) return;
    const t0 = this.now + this.lead;
    this.pausedAt = Math.min(this.posAt(t0), this.duration);
    this.playing = false;
    this.cancelFrom(t0);
    this.sched({ output: t0, input: this.pausedAt, rate: this.rate, active: false });
    this.emit("state");
  }

  seek(t) {
    t = Math.max(0, Math.min(this.duration, t));
    this.pausedAt = t;
    // Paused, too: the schedule's resting point moves, so the position reads
    // right in the moment between pressing Play and the audio starting.
    this.replan({ input: t });
    this.emit("seek");
  }

  setRate(r) {
    this.rate = r;
    // A manual change mid-training becomes the trainer's new starting point.
    if (this.trainer) Object.assign(this.trainer, { rate: r, baseRate: r, basePasses: this.trainer.passes });
    this.replan();
  }

  setPitch(semitones, formant) {
    this.semitones = semitones;
    this.formant = formant;
    this.replan();
  }

  setLoop(a, b, on) {
    // A new loop starts the pass count (and the trainer's steps) over.
    if (a !== this.loop.a || b !== this.loop.b) {
      this.passes = 0;
      this.epoch++;
      if (this.trainer) Object.assign(this.trainer, { passes: 0, basePasses: 0, baseRate: this.trainer.rate });
    }
    this.loop = { a, b, on };
    this.replan();
  }

  setCountIn(beats, beatSec) {
    this.countIn = { beats, beatSec };
    this.replan();
  }

  // trainer: { start, step, every, target } or null. Starts at `start`.
  setTrainer(t) {
    this.trainer = t ? { ...t, passes: 0, basePasses: 0, baseRate: t.start, rate: t.start } : null;
    if (t) this.rate = t.start;
    this.passes = 0;
    this.epoch++;
    this.replan();
    this.emit("rate");
  }

  tick() {
    if (!this.node) return;
    const now = this.now;
    // Fire due UI events.
    while (this.events.length && this.events[0].time <= now) {
      const e = this.events.shift();
      // Wraps scheduled before the count restarted still play, but don't count.
      if (e.type === "wrap" && e.epoch === this.epoch) {
        this.passes = e.passes;
        if (this.trainer) { this.trainer.passes = e.passes; this.trainer.rate = e.rate; }
        this.rate = e.rate;
        this.emit("rate");
      }
      if (e.type === "ended") { this.playing = false; this.pausedAt = e.input; this.emit("state"); }
      this.emit(e.type, e);
    }
    while (this.plan.length > 1 && this.plan[1].output <= now - 0.5) this.plan.shift();
    if (this.playing) this.extendPlan(now);
  }

  // Keep loop jumps / the end of the song scheduled up to the horizon.
  extendPlan(now) {
    const horizon = now + (document.visibilityState === "visible" ? HORIZON_VISIBLE : HORIZON_HIDDEN);
    const { a, b, on } = this.loop;
    const looping = on && a !== null && b !== null && b - a > 0.05;
    for (let guard = 0; guard < 64; guard++) {
      const last = this.plan[this.plan.length - 1];
      if (!last.active) return;  // a count-in gap is always followed by its restart
      const stopAt = looping && last.input < b ? b : this.duration;
      const tEnd = last.output + (stopAt - last.input) / last.rate;
      if (tEnd > horizon) return;
      if (stopAt !== b) {
        this.sched({ output: tEnd, input: this.duration, rate: last.rate, active: false });
        this.addEvent({ time: tEnd, type: "ended", input: this.duration });
        return;
      }
      // Loop wrap. The trainer decides the speed of the next pass.
      const lastWrap = [...this.events].reverse().find((e) => e.type === "wrap" && e.epoch === this.epoch);
      const prevPasses = lastWrap ? lastWrap.passes : this.passes;
      const passes = prevPasses + 1;
      const rate = this.trainer ? trainerRate(this.trainer, passes) : last.rate;
      this.addEvent({ time: tEnd, type: "wrap", passes, rate, epoch: this.epoch });
      let t0 = tEnd;
      const beats = this.countIn.beats;
      if (beats > 0) {
        const beatDur = this.countIn.beatSec / rate;
        this.sched({ output: tEnd, input: b, rate, active: false });
        this.scheduleClicks(tEnd, beats, beatDur, passes);
        t0 += beats * beatDur;
      }
      this.sched({ output: t0, input: a, rate, active: true });
    }
  }

  addEvent(e) {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > e.time) i--;
    this.events.splice(i, 0, e);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // Song times in `times` (sorted) that play between audio times t0 and t1,
  // with the audio time each plays at: [{ index, song, at, seg }]. A loop jump
  // can make a song time play more than once; `seg` (the segment's start)
  // tells those apart.
  timesBetween(times, t0, t1) {
    const out = [];
    for (let k = 0; k < this.plan.length; k++) {
      const s = this.plan[k];
      if (!s.active) continue;
      const end = k + 1 < this.plan.length ? this.plan[k + 1].output : Infinity;
      const from = Math.max(t0, s.output), to = Math.min(t1, end);
      if (to <= from) continue;
      const songFrom = s.input + (from - s.output) * s.rate, songTo = s.input + (to - s.output) * s.rate;
      let i = lowerBound(times, songFrom);
      for (; i < times.length && times[i] < songTo; i++) out.push({ index: i, song: times[i], at: s.output + (times[i] - s.input) / s.rate, seg: s.output });
    }
    return out;
  }
}

function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
