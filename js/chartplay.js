// Plays a chart's bars on the app guitar: strummed (a strum pattern) or
// picked (a Pimapeggio pattern), with an optional count-in and loop. The step
// scheduling is Pimapeggio's scheduleStep/chordAt, generalised to charts.
//
// bars: [{ chords: [{ name, frets, pima }] }] — the chords as they should sound
// (already transposed, simplified and voiced for the capo by the caller).

import { audioContext, resumeAudio, StringVoices, strum, parseStrum, playClick, warmNotes,
  requestWakeLock, releaseWakeLock } from "./audio.js";
import { Lookahead, VisualQueue } from "./scheduler.js";
import { noteString, chordMidi, OPEN_MIDI } from "./patterns.js";

// Every note a chord might play: its strummed shape, and for patterns the
// Pimapeggio voicing on all six strings.
function chordNotes(ch, capo, picked) {
  if (!ch || !ch.frets) return [];
  if (picked && ch.pima) return [1, 2, 3, 4, 5, 6].map((s) => chordMidi(ch.pima, s, capo));
  const out = [];
  ch.frets.forEach((f, i) => { if (f !== null) out.push(OPEN_MIDI[6 - i] + f + capo); });
  return out;
}

// Beats per bar for a time signature; compound meters count dotted beats.
export function meter(time) {
  const [n, d] = String(time || "4/4").split("/").map(Number);
  if (d === 8 && n % 3 === 0) return { beats: n / 3, sub: 3 };
  return { beats: n || 4, sub: d === 8 ? 1 : 2 };
}

const HOME = { i: 3, m: 2, a: 1 };

export class ChartPlayer extends EventTarget {
  constructor(trackName = "guitar") {
    super();
    this.voices = new StringVoices(trackName);
    this.session = null;
    this.visuals = new VisualQueue((ev) => this.dispatchEvent(new CustomEvent(ev.type, { detail: ev })));
    this.look = new Lookahead((horizon, now) => this.fill(horizon, now));
    this.log = [];  // scheduled onsets, for checks: { time, type, bar, chord }
    document.addEventListener("visibilitychange", () => {
      // iOS suspends audio in the background: end the run cleanly instead of drifting.
      if (document.visibilityState === "hidden" && this.session) this.stop();
    });
  }

  get playing() { return !!this.session; }

  // opts: { bars, bpm, time, strum (string) | pattern (Pimapeggio pattern),
  //         capo, countIn (bool), loop (bool), startBar, cents }
  async start(opts) {
    this.stop(0.02);
    const c = audioContext();
    await resumeAudio();
    const { beats } = meter(opts.time);
    const s = {
      ...opts,
      beats,
      bar: opts.startBar || 0,
      slot: 0,
      pIdx: 0,
      countLeft: opts.countIn ? beats : 0,
      countTotal: opts.countIn ? beats : 0,
      nextTime: 0,
      endTime: null,
    };
    if (opts.pattern) {
      s.npb = opts.npb || opts.pattern.npb;
      s.slots = beats * s.npb;
    } else {
      s.strumSlots = parseStrum(opts.strum);
      s.slots = s.strumSlots.length;
    }
    this.voices.cents = opts.cents || 0;
    // Render the first bar's notes now, the rest in the background.
    const midis = (b) => b.chords.flatMap((ch) => chordNotes(ch, opts.capo || 0, !!opts.pattern));
    await warmNotes(opts.bars.slice(s.bar, s.bar + 1).flatMap(midis));
    warmNotes(opts.bars.flatMap(midis));
    s.nextTime = c.currentTime + 0.08;
    this.session = s;
    this.log = [];
    this.look.start();
    requestWakeLock();
    this.dispatchEvent(new CustomEvent("state", { detail: { playing: true } }));
  }

  stop(fade = 0.08) {
    if (!this.session) return;
    this.session = null;
    this.look.stop();
    this.visuals.stop();
    this.voices.silence(fade);
    releaseWakeLock();
    this.dispatchEvent(new CustomEvent("state", { detail: { playing: false } }));
  }

  setTempo(bpm) { if (this.session) this.session.bpm = bpm; }   // from the next slot

  pushLog(e) {
    this.log.push(e);
    if (this.log.length > 512) this.log.shift();
  }

  // Swap the chords (transpose/capo/simplify while playing) from the next slot.
  setBars(bars) { if (this.session) this.session.bars = bars; }

  slotDur(s) { return (s.beats * 60 / s.bpm) / s.slots; }

  fill(horizon, now) {
    const s = this.session;
    if (!s) return;
    // After an interruption the clock has moved on: re-anchor rather than
    // firing a burst of stale notes.
    if (s.nextTime < now - 0.03) {
      s.nextTime = now + 0.05;
      this.visuals.clear();
    }
    if (s.endTime !== null) {
      if (now > s.endTime + 0.05) this.stop(0.3);
      return;
    }
    while (this.session === s && s.endTime === null && s.nextTime < horizon) {
      if (s.countLeft > 0) this.scheduleCount(s);
      else this.scheduleSlot(s);
    }
  }

  scheduleCount(s) {
    const beat = s.countTotal - s.countLeft;
    playClick(s.nextTime, beat === 0);
    this.visuals.push({ time: s.nextTime, type: "count", n: beat + 1, of: s.countTotal });
    s.countLeft--;
    s.nextTime += 60 / s.bpm;
  }

  // The chord at a slot; two chords in a bar split it evenly (chordAt).
  chordAt(s) {
    const bar = s.bars[s.bar];
    const idx = Math.min(bar.chords.length - 1, Math.floor(s.slot * bar.chords.length / s.slots));
    return { chord: bar.chords[idx], idx };
  }

  scheduleSlot(s) {
    const t = s.nextTime;
    const { chord, idx } = this.chordAt(s);
    const perBeat = s.slots / s.beats;
    if (s.slot === 0) this.visuals.push({ time: t, type: "bar", bar: s.bar });
    if (s.slot % perBeat === 0) this.visuals.push({ time: t, type: "beat", bar: s.bar, beat: s.slot / perBeat });
    const prevIdx = s.slot === 0 ? -1 : Math.min(s.bars[s.bar].chords.length - 1, Math.floor((s.slot - 1) * s.bars[s.bar].chords.length / s.slots));
    if (idx !== prevIdx) this.visuals.push({ time: t, type: "chord", bar: s.bar, index: idx, name: chord && chord.name });

    if (chord && chord.frets) {
      if (s.pattern) {
        const notes = s.pattern.steps[s.pIdx];
        const level = 0.42 / Math.sqrt(notes.length);
        const midis = [];
        for (const n of notes) {
          const str = noteString(n, chord.pima, HOME);
          const midi = chordMidi(chord.pima, str, s.capo || 0);
          midis.push(midi);
          this.voices.playNote(str, midi, t, n.f === "p" ? level * 1.15 : level);
        }
        this.pushLog({ time: t, type: "step", bar: s.bar, chord: chord.name, step: s.pIdx, midis });
        this.visuals.push({ time: t, type: "step", bar: s.bar, step: s.pIdx });
        s.pIdx = (s.pIdx + 1) % s.pattern.steps.length;
      } else {
        const slot = s.strumSlots[s.slot];
        if (slot.dir) {
          if (slot.mute) {
            for (let k = 1; k <= 6; k++) this.voices.damp(k, t);
          } else {
            const notes = strum(this.voices, chord.frets, t, { dir: slot.dir, capo: s.capo || 0, level: slot.accent ? 0.36 : 0.24 });
            this.pushLog({ time: t, type: "strum", bar: s.bar, chord: chord.name, dir: slot.dir, midis: notes.map((n) => n.midi) });
          }
        }
      }
    }

    s.nextTime += this.slotDur(s);
    s.slot++;
    if (s.slot >= s.slots) {
      s.slot = 0;
      s.bar++;
      if (s.bar >= s.bars.length) {
        if (s.loop) s.bar = 0;
        else {
          s.endTime = s.nextTime;
          this.visuals.push({ time: s.endTime, type: "end" });
        }
      }
    }
  }
}
