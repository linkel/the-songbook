// The synth band's voices (plan §9.2), each on its own mixer track: a low
// plucked bass (a saw and a triangle through a closing low-pass, so it's
// heard on a phone speaker too), a drum kit built from sine sweeps and noise
// (kick, snare, cross-stick, hats, crash), and a soft lead for a melody line.
// Every note is scheduled ahead on the audio clock; silence() stops what's
// still to come (pause, seek, loop changes).

import { audioContext, track, midiToFreq } from "./audio.js";

class Voice {
  constructor(trackName) {
    this.trackName = trackName;
    this.live = new Set();
    this.cents = 0;
  }

  get out() { return track(this.trackName).gain; }

  keep(nodes, end) {
    const v = { nodes, end };
    this.live.add(v);
    nodes[0].onended = () => this.live.delete(v);
    return v;
  }

  silence(fade = 0.04) {
    const c = audioContext();
    const now = c.currentTime;
    for (const v of this.live) {
      if (v.amp) { v.amp.gain.cancelScheduledValues(now); v.amp.gain.setTargetAtTime(0, now, fade); }
      // A note that hasn't started yet never will (stopping before the start time).
      for (const n of v.nodes) if (n.stop) { try { n.stop(now + fade * 6); } catch (e) { /* already stopped */ } }
    }
    this.live.clear();
  }
}

export class BassVoice extends Voice {
  constructor(trackName = "band-bass") { super(trackName); this.last = null; }

  play(midi, time, dur, vel = 0.9) {
    const c = audioContext();
    // One string: a new note stops the one before.
    if (this.last && this.last.end > time) {
      this.last.amp.gain.cancelScheduledValues(time);
      this.last.amp.gain.setTargetAtTime(0, time, 0.01);
    }
    const f = midiToFreq(midi);
    const saw = c.createOscillator(), tri = c.createOscillator();
    saw.type = "sawtooth";
    tri.type = "triangle";
    saw.frequency.value = f;
    tri.frequency.value = f;
    saw.detune.value = tri.detune.value = this.cents;
    const mixS = c.createGain(), mixT = c.createGain();
    mixS.gain.value = 0.35;
    mixT.gain.value = 0.8;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(1400, time);
    lp.frequency.exponentialRampToValueAtTime(320, time + 0.25);
    const amp = c.createGain();
    const peak = 0.42 * vel, end = time + Math.max(0.08, dur);
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(peak, time + 0.006);
    amp.gain.setTargetAtTime(peak * 0.55, time + 0.01, 0.25);
    amp.gain.setTargetAtTime(0, end, 0.03);
    saw.connect(mixS); tri.connect(mixT); mixS.connect(lp); mixT.connect(lp); lp.connect(amp); amp.connect(this.out);
    saw.start(time); tri.start(time);
    saw.stop(end + 0.3); tri.stop(end + 0.3);
    const v = this.keep([saw, tri, amp], end);
    v.amp = amp;
    this.last = v;
    return v;
  }
}

let noise = null;
function noiseBuffer() {
  if (noise) return noise;
  const c = audioContext();
  noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = noise.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = (seed / 0x3fffffff) - 1; }
  return noise;
}

export class DrumKit extends Voice {
  constructor(trackName = "band-drums") { super(trackName); }

  noise(time, len, vel, { type = "highpass", freq = 6000, q = 0.7 } = {}) {
    const c = audioContext();
    const src = c.createBufferSource();
    src.buffer = noiseBuffer();
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const amp = c.createGain();
    amp.gain.setValueAtTime(vel, time);
    amp.gain.exponentialRampToValueAtTime(0.001, time + len);
    src.connect(f); f.connect(amp); amp.connect(this.out);
    src.start(time, Math.random() * 1.5);
    src.stop(time + len + 0.05);
    const v = this.keep([src, amp], time + len);
    v.amp = amp;
  }

  tone(time, from, to, len, vel, type = "sine") {
    const c = audioContext();
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, time);
    o.frequency.exponentialRampToValueAtTime(to, time + Math.min(len, 0.12));
    const amp = c.createGain();
    amp.gain.setValueAtTime(vel, time);
    amp.gain.exponentialRampToValueAtTime(0.001, time + len);
    o.connect(amp); amp.connect(this.out);
    o.start(time);
    o.stop(time + len + 0.05);
    const v = this.keep([o, amp], time + len);
    v.amp = amp;
  }

  play(drum, time, vel = 0.8) {
    if (drum === "kick") {
      this.tone(time, 150, 46, 0.42, 0.95 * vel);
      this.noise(time, 0.012, 0.25 * vel, { type: "lowpass", freq: 3000 });
    } else if (drum === "snare") {
      this.tone(time, 230, 170, 0.1, 0.35 * vel, "triangle");
      this.noise(time, 0.17, 0.45 * vel, { type: "highpass", freq: 1500 });
    } else if (drum === "rim") {
      this.tone(time, 520, 480, 0.04, 0.3 * vel, "triangle");
      this.noise(time, 0.03, 0.25 * vel, { type: "bandpass", freq: 1900, q: 3 });
    } else if (drum === "hat") {
      this.noise(time, 0.05, 0.22 * vel, { type: "highpass", freq: 7500 });
    } else if (drum === "open-hat") {
      this.noise(time, 0.3, 0.2 * vel, { type: "highpass", freq: 7000 });
    } else if (drum === "crash") {
      this.noise(time, 1.4, 0.28 * vel, { type: "highpass", freq: 4500 });
    }
  }
}

// A soft lead for a melody line (a transcribed vocal, say): a sine with a
// little triangle, a gentle attack and a touch of vibrato.
export class LeadVoice extends Voice {
  constructor(trackName = "band-melody") { super(trackName); }

  play(midi, time, dur, vel = 0.8) {
    const c = audioContext();
    const f = midiToFreq(midi);
    const o = c.createOscillator(), t = c.createOscillator(), lfo = c.createOscillator(), depth = c.createGain();
    o.type = "sine"; t.type = "triangle";
    o.frequency.value = t.frequency.value = f;
    o.detune.value = t.detune.value = this.cents;
    lfo.frequency.value = 5;
    depth.gain.value = f * 0.004;
    lfo.connect(depth); depth.connect(o.frequency); depth.connect(t.frequency);
    const tg = c.createGain();
    tg.gain.value = 0.25;
    const amp = c.createGain();
    const end = time + Math.max(0.1, dur), peak = 0.3 * vel;
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(peak, time + 0.04);
    amp.gain.setTargetAtTime(peak * 0.8, time + 0.05, 0.3);
    amp.gain.setTargetAtTime(0, end, 0.06);
    o.connect(amp); t.connect(tg); tg.connect(amp); amp.connect(this.out);
    for (const x of [o, t, lfo]) { x.start(time); x.stop(end + 0.5); }
    const v = this.keep([o, t, lfo, amp], end);
    v.amp = amp;
  }
}
