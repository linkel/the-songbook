// Play along: your recording, with bars lit on its own clock (the analysed
// bar times), and an optional soft strum of the chart on the recording's
// beats. Everything is scheduled on the AudioContext clock; the lit bar is
// whatever is audible now. Speed and pitch come with the recording player.

import { audioContext, resumeAudio, track, StringVoices, strum, warmNotes, requestWakeLock, releaseWakeLock } from "./audio.js";
import { Lookahead, VisualQueue, audibleTime } from "./scheduler.js";

const STANDARD = [null, 64, 59, 55, 50, 45, 40];   // open strings by string number

export class PlayAlong extends EventTarget {
  constructor() {
    super();
    this.voices = new StringVoices("guitar");
    this.visuals = new VisualQueue((ev) => this.dispatchEvent(new CustomEvent(ev.type, { detail: ev })));
    this.look = new Lookahead((h) => this.fill(h));
    this.src = null;
    this.buffer = null;
    this.mono = null;
    this.log = [];   // { type, bar, time } as scheduled, for checks
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && this.playing) this.stop(); });
  }

  get playing() { return !!this.src; }

  // Song time (seconds into the recording) that's audible now.
  get position() { return this.playing ? audibleTime() - this.origin : this.pausedAt || 0; }

  // mono: Float32Array at 44.1 kHz. bars: [{ t, n, chords, frets: [frets per chord] }].
  // beats: beat times. opts: { from, strum, capo, cents (the recording's tuning),
  // open (the guitar's tuning: open strings by string number) }.
  async start(mono, bars, beats, opts = {}) {
    this.stop();
    const c = audioContext();
    await resumeAudio();
    if (this.mono !== mono) {
      this.buffer = c.createBuffer(1, mono.length, 44100);
      this.buffer.copyToChannel(mono, 0);
      this.mono = mono;
    }
    this.bars = bars;
    this.beats = beats;
    this.opts = opts;
    this.voices.cents = opts.cents || 0;
    const from = Math.max(0, Math.min(opts.from || 0, this.buffer.duration - 0.05));
    if (opts.strum) {
      const midis = [];
      const open = opts.open || STANDARD;
      for (const b of bars) for (const f of b.frets || []) if (f) f.forEach((x, i) => { if (x !== null) midis.push(open[6 - i] + x + (opts.capo || 0)); });
      await warmNotes(midis);
    }
    const src = c.createBufferSource();
    src.buffer = this.buffer;
    src.connect(track("recording").gain);
    const t0 = c.currentTime + 0.1;
    src.start(t0, from);
    src.onended = () => { if (this.src === src) this.stop(true); };
    this.src = src;
    this.origin = t0 - from;
    this.nextBar = bars.findIndex((b) => b.t + 0.001 >= from);
    if (this.nextBar < 0) this.nextBar = bars.length;
    // Light the bar we start inside, too.
    const inside = bars.findIndex((b, i) => b.t <= from && (i + 1 >= bars.length || bars[i + 1].t > from));
    if (inside >= 0 && bars[inside].t < from) this.visuals.push({ time: t0, type: "bar", bar: inside, start: true });
    this.nextBeat = beats.findIndex((t) => t >= from);
    if (this.nextBeat < 0) this.nextBeat = beats.length;
    this.log = [];
    this.look.start();
    requestWakeLock();
    this.dispatchEvent(new CustomEvent("state", { detail: { playing: true } }));
  }

  stop(ended = false) {
    if (!this.src) return;
    const src = this.src;
    this.src = null;
    this.pausedAt = ended ? 0 : this.position;
    try { src.stop(); } catch (e) { /* already stopped */ }
    this.look.stop();
    this.visuals.stop();
    this.voices.silence(0.1);
    releaseWakeLock();
    this.dispatchEvent(new CustomEvent("state", { detail: { playing: false, ended } }));
  }

  // The chord shape playing at song time t (half-bar aware).
  shapeAt(t) {
    let i = this.bars.length - 1;
    while (i > 0 && this.bars[i].t > t) i--;
    const b = this.bars[i];
    if (!b || !b.frets || !b.frets.length) return null;
    const end = i + 1 < this.bars.length ? this.bars[i + 1].t : b.t + 2;
    const k = Math.min(b.frets.length - 1, Math.floor((t - b.t) / Math.max(0.01, end - b.t) * b.frets.length));
    return b.frets[k];
  }

  fill(horizon) {
    if (!this.src) return;
    while (this.nextBar < this.bars.length && this.origin + this.bars[this.nextBar].t < horizon) {
      const time = this.origin + this.bars[this.nextBar].t;
      this.visuals.push({ time, type: "bar", bar: this.nextBar });
      this.log.push({ type: "bar", bar: this.nextBar, time });
      this.nextBar++;
    }
    while (this.nextBeat < this.beats.length && this.origin + this.beats[this.nextBeat] < horizon) {
      const t = this.beats[this.nextBeat];
      if (this.opts.strum) {
        const frets = this.shapeAt(t + 0.01);
        if (frets) strum(this.voices, frets, this.origin + t, { capo: this.opts.capo || 0, level: 0.16, open: this.opts.open });
      }
      this.nextBeat++;
    }
  }
}
