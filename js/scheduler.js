// Lookahead scheduling and the visual event queue, from Pimapeggio's app.js.
// Sound is scheduled on the AudioContext clock LOOKAHEAD ahead; setInterval
// only wakes the scheduler up. The display follows by consuming timed events
// in requestAnimationFrame against the clock minus the output latency, so
// what lights up is what you hear.

import { audioContext } from "./audio.js";

export const TICK_MS = 25;
export const LOOKAHEAD = 0.12;

export class Lookahead {
  // fill(horizon, now): schedule everything that starts before `horizon`.
  constructor(fill) {
    this.fill = fill;
    this.timer = null;
  }
  start() {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  get running() { return this.timer !== null; }
  tick() {
    const c = audioContext();
    this.fill(c.currentTime + LOOKAHEAD, c.currentTime);
  }
}

// What's audible now: the context clock minus the hardware output latency.
export function audibleTime() {
  const c = audioContext();
  return c.currentTime - (c.outputLatency || 0);
}

export class VisualQueue {
  constructor(apply) {
    this.apply = apply;
    this.q = [];
    this.raf = 0;
    this.frame = this.frame.bind(this);
  }
  push(ev) {
    let i = this.q.length;
    while (i > 0 && this.q[i - 1].time > ev.time) i--;
    this.q.splice(i, 0, ev);
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }
  clear() { this.q = []; }
  stop() {
    this.q = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  frame() {
    this.raf = 0;
    const now = audibleTime();
    while (this.q.length && this.q[0].time <= now) this.apply(this.q.shift());
    if (this.q.length) this.raf = requestAnimationFrame(this.frame);
  }
}
