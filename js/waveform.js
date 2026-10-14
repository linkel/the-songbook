// Zoomable waveform with draggable loop handles, plus an overview strip of the
// whole song. Without audio data (YouTube) it draws a plain timeline.
// From speedy-pitcher's js/waveform.js (the owner's app), with the Songbook's
// colours, bar lines, a section lane along the top and a chord lane along the
// bottom (mockup 7).

import { fmtTime, clamp } from "./trainer.js";

const HANDLE_REACH = 26;   // CSS px from a handle that still grabs it
const MIN_SPAN = 1;        // seconds across the view at most zoom

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class WaveView {
  constructor(canvas, overview, handlers) {
    this.cv = canvas;
    this.ov = overview;
    this.h = handlers;      // { seek(t), setA(t), setB(t), loopChanged() }
    this.an = null;
    this.duration = 0;
    this.view = { start: 0, end: 1 };
    this.state = { pos: 0, a: null, b: null, on: false, playing: false };
    this.lanes = { bars: [], sections: [] };
    this.followPausedUntil = 0;
    this.dirty = true;
    this.colors = {};
    this.pointers = new Map();
    this.bindMain();
    this.bindOverview();
    new ResizeObserver(() => { this.resize(); }).observe(canvas);
    this.resize();
  }

  setSong(an, duration, view) {
    this.an = an;
    this.duration = duration;
    this.view = view && view.end > view.start ? { ...view } : { start: 0, end: duration || 1 };
    this.clampView();
    this.ovCache = null;
    this.dirty = true;
  }

  // bars: [{ t, label }] (label: the chords, as shown); sections: [{ t0, t1, name, color }].
  setLanes(lanes) {
    this.lanes = { bars: lanes.bars || [], sections: lanes.sections || [] };
    this.ovCache = null;
    this.dirty = true;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.cv, this.ov]) {
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    }
    this.dpr = dpr;
    this.ovCache = null;
    this.dirty = true;
  }

  readColors() {
    this.colors = {
      bg: css("--base"), wave: css("--overlay0"), waveLoop: css("--text"), grid: css("--surface0"),
      dim: css("--dim"), accent: css("--peach"), loop: css("--loop-fill"), loopOff: css("--loop-fill-off"),
      head: css("--green"), text: css("--text"), chord: css("--ink-mauve"),
      bar: css("--surface1"), onAccent: css("--on-accent"), onPeach: css("--on-peach"),
    };
  }

  // The theme changed: read the colours again.
  recolor() { this.colors = {}; this.ovCache = null; this.dirty = true; }

  // ---- geometry ----
  get span() { return this.view.end - this.view.start; }
  xToT(x) { return this.view.start + (x / this.cv.clientWidth) * this.span; }
  tToX(t) { return ((t - this.view.start) / this.span) * this.cv.clientWidth; }

  clampView() {
    const d = this.duration || 1;
    let span = clamp(this.span, Math.min(MIN_SPAN, d), d);
    let start = clamp(this.view.start, 0, d - span);
    this.view = { start, end: start + span };
  }

  zoom(factor, centerT) {
    if (centerT === undefined) {
      const p = this.state.pos;
      centerT = p >= this.view.start && p <= this.view.end ? p : (this.view.start + this.view.end) / 2;
    }
    const frac = (centerT - this.view.start) / this.span;
    const span = clamp(this.span / factor, Math.min(MIN_SPAN, this.duration), this.duration);
    this.view.start = centerT - frac * span;
    this.view.end = this.view.start + span;
    this.clampView();
    this.dirty = true;
    this.holdFollow();
  }

  fitLoop() {
    const { a, b } = this.state;
    if (a === null || b === null) { this.view = { start: 0, end: this.duration }; }
    else {
      const pad = Math.max(0.3, (b - a) * 0.08);
      this.view = { start: a - pad, end: b + pad };
    }
    this.clampView();
    this.dirty = true;
  }

  showAll() { this.view = { start: 0, end: this.duration }; this.clampView(); this.dirty = true; }

  holdFollow(ms = 2500) { this.followPausedUntil = performance.now() + ms; }

  update(state) {
    const s = this.state;
    if (s.pos !== state.pos || s.a !== state.a || s.b !== state.b || s.on !== state.on || s.playing !== state.playing) this.dirty = true;
    this.state = { ...state };
    // Follow the playhead: page forward when it runs off the right edge.
    if (state.playing && performance.now() > this.followPausedUntil && this.span < this.duration) {
      const p = state.pos;
      if (p > this.view.end - this.span * 0.04 || p < this.view.start) {
        const span = this.span;
        this.view.start = p - span * 0.08;
        this.view.end = this.view.start + span;
        this.clampView();
        this.dirty = true;
      }
    }
  }

  // ---- drawing ----
  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    if (!this.colors.bg) this.readColors();
    this.drawMain();
    this.drawOverview();
  }

  drawMain() {
    const g = this.cv.getContext("2d"), dpr = this.dpr;
    const W = this.cv.width, H = this.cv.height, C = this.colors;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    if (!this.duration) return;
    const { a, b, on, pos } = this.state;
    const LANE = 18 * dpr, hasSec = this.lanes.sections.length > 0, hasCh = this.lanes.bars.length > 0;
    const top = hasSec ? LANE + 4 * dpr : 18 * dpr, bottom = H - (hasCh ? LANE + 4 * dpr : 4 * dpr);
    const waveH = bottom - top, mid = top + waveH / 2;
    const xOf = (t) => this.tToX(t) * dpr;

    // Loop region
    if (a !== null) {
      const x0 = xOf(a), x1 = b !== null ? xOf(b) : xOf(a);
      g.fillStyle = on ? C.loop : C.loopOff;
      g.fillRect(x0, top, Math.max(0, x1 - x0), bottom - top);
    }

    g.font = `${11 * dpr}px -apple-system, system-ui, sans-serif`;
    g.textBaseline = "top";
    if (hasCh) {
      // Bar lines.
      g.fillStyle = C.bar;
      for (const bar of this.lanes.bars) {
        if (bar.t < this.view.start || bar.t > this.view.end) continue;
        g.fillRect(Math.round(xOf(bar.t)), top, dpr, bottom - top);
      }
    } else {
      // Time grid.
      const step = niceStep(this.span / (W / dpr / 70));
      for (let t = Math.ceil(this.view.start / step) * step; t <= this.view.end; t += step) {
        const x = Math.round(xOf(t)) + 0.5;
        g.fillStyle = C.grid;
        g.fillRect(x, top, dpr, bottom - top);
        g.fillStyle = C.dim;
        if (!hasSec) g.fillText(fmtGrid(t, step), x + 3 * dpr, 3 * dpr);
      }
    }

    // Waveform
    if (this.an) {
      const an = this.an, cols = W;
      const sPerPx = (this.span * an.rate) / cols;
      const scale = (waveH / 2) * 0.95 / Math.max(0.05, this.globalPeak());
      for (let x = 0; x < cols; x++) {
        const t0 = this.view.start + (x / cols) * this.span, t1 = t0 + this.span / cols;
        const [lo, hi] = this.range(t0, t1, sPerPx);
        const inLoop = a !== null && b !== null && t1 > a && t0 < b;
        g.fillStyle = inLoop && on ? C.waveLoop : C.wave;
        const y0 = mid - hi * scale, y1 = mid - lo * scale;
        g.fillRect(x, y0, 1, Math.max(dpr, y1 - y0));
      }
    } else {
      g.fillStyle = C.wave;
      g.fillRect(0, mid - dpr, W, 2 * dpr);
    }

    if (hasSec) this.drawSections(g, xOf, LANE, W);
    if (hasCh) this.drawChords(g, xOf, H - LANE, LANE, W, pos);

    // Handles
    for (const [t, label] of [[a, "A"], [b, "B"]]) {
      if (t === null) continue;
      const x = xOf(t);
      g.fillStyle = C.accent;
      g.fillRect(x - dpr, top, 2 * dpr, bottom - top);
      const tw = 22 * dpr, th = 22 * dpr;
      // A's tab sits left of its line and B's right, unless that runs off the edge.
      let tx = label === "A" ? x - tw : x;
      if (tx < 0) tx = x;
      if (tx + tw > W) tx = x - tw;
      roundRect(g, tx, bottom - th, tw, th, 5 * dpr);
      g.fill();
      g.fillStyle = C.onPeach;
      g.font = `700 ${13 * dpr}px -apple-system, system-ui, sans-serif`;
      g.textBaseline = "middle";
      g.textAlign = "center";
      g.fillText(label, tx + tw / 2, bottom - th / 2);
      g.textAlign = "left";
      g.textBaseline = "top";
    }

    // Playhead
    const px = xOf(pos);
    g.fillStyle = C.head;
    g.fillRect(px - dpr, top - 4 * dpr, 2 * dpr, bottom - top + 8 * dpr);
  }

  // Coloured blocks with the section names, along the top.
  drawSections(g, xOf, h, W) {
    const dpr = this.dpr, C = this.colors;
    g.font = `800 ${10 * dpr}px -apple-system, system-ui, sans-serif`;
    g.textBaseline = "middle";
    for (const s of this.lanes.sections) {
      if (s.t1 < this.view.start || s.t0 > this.view.end) continue;
      const x0 = Math.max(0, xOf(s.t0)) + dpr, x1 = Math.min(W, xOf(s.t1)) - dpr;
      if (x1 - x0 < 2 * dpr) continue;
      g.fillStyle = css(s.color || "--blue");
      roundRect(g, x0, 0, x1 - x0, h, 4 * dpr);
      g.fill();
      g.fillStyle = C.onAccent;
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, h);
      g.clip();
      g.fillText(s.name, x0 + 5 * dpr, h / 2);
      g.restore();
    }
    g.textBaseline = "top";
  }

  // Chord names at their bars along the bottom; the one playing in peach.
  drawChords(g, xOf, y, h, W, pos) {
    const dpr = this.dpr, C = this.colors, bars = this.lanes.bars;
    g.font = `800 ${11.5 * dpr}px -apple-system, system-ui, sans-serif`;
    g.textBaseline = "middle";
    let lastRight = -Infinity, prevLabel = null;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i], next = bars[i + 1];
      const t1 = next ? next.t : this.duration;
      if (t1 < this.view.start || bar.t > this.view.end) { prevLabel = bar.label; continue; }
      const x0 = xOf(bar.t), x1 = xOf(t1);
      const now = pos >= bar.t && pos < t1;
      g.fillStyle = C.bar;
      g.fillRect(Math.round(x0), y, dpr, h);
      // Repeats are left out when bars get narrow, so the names stay readable.
      const label = bar.label;
      const w = g.measureText(label).width;
      if (!now && (x0 + 3 * dpr < lastRight || (label === prevLabel && x1 - x0 < w + 8 * dpr))) { prevLabel = label; continue; }
      if (now) {
        g.fillStyle = C.accent;
        roundRect(g, x0 + dpr, y + dpr, Math.min(Math.max(w + 6 * dpr, x1 - x0 - 2 * dpr), W - x0), h - 2 * dpr, 4 * dpr);
        g.fill();
        g.fillStyle = C.onPeach;
      } else g.fillStyle = C.chord;
      g.fillText(label, x0 + 3 * dpr, y + h / 2);
      lastRight = x0 + 3 * dpr + w + 4 * dpr;
      prevLabel = label;
    }
    g.textBaseline = "top";
  }

  globalPeak() {
    if (this._peak !== undefined && this._peakFor === this.an) return this._peak;
    let m = 0;
    const d = this.an.peaks.data;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
    this._peak = m; this._peakFor = this.an;
    return m;
  }

  // min/max of the analysis signal between t0 and t1
  range(t0, t1, sPerPx) {
    const an = this.an;
    let lo = 0, hi = 0;
    if (sPerPx >= an.peaks.bucket * 2) {
      const d = an.peaks.data, bk = an.peaks.bucket;
      const b0 = Math.max(0, Math.floor(t0 * an.rate / bk)), b1 = Math.min(d.length / 2, Math.ceil(t1 * an.rate / bk));
      for (let i = b0; i < b1; i++) { if (d[2 * i] < lo) lo = d[2 * i]; if (d[2 * i + 1] > hi) hi = d[2 * i + 1]; }
    } else {
      const s = an.samples;
      const i0 = Math.max(0, Math.floor(t0 * an.rate)), i1 = Math.min(s.length, Math.max(i0 + 1, Math.ceil(t1 * an.rate)));
      for (let i = i0; i < i1; i++) { const v = s[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    return [lo, hi];
  }

  drawOverview() {
    const g = this.ov.getContext("2d"), dpr = this.dpr;
    const W = this.ov.width, H = this.ov.height, C = this.colors;
    if (!this.ovCache) {
      // Static part (waveform of the whole song) is drawn once offscreen.
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const o = c.getContext("2d");
      o.fillStyle = C.bg;
      o.fillRect(0, 0, W, H);
      if (this.an && this.duration) {
        const scale = (H / 2) * 0.9 / Math.max(0.05, this.globalPeak());
        o.fillStyle = C.wave;
        for (let x = 0; x < W; x++) {
          const t0 = (x / W) * this.duration, t1 = ((x + 1) / W) * this.duration;
          const [lo, hi] = this.range(t0, t1, Infinity);
          o.fillRect(x, H / 2 - hi * scale, 1, Math.max(dpr, (hi - lo) * scale));
        }
      }
      this.ovCache = c;
    }
    g.drawImage(this.ovCache, 0, 0);
    if (!this.duration) return;
    const xOf = (t) => (t / this.duration) * W;
    const { a, b, on, pos } = this.state;
    if (a !== null && b !== null) {
      g.fillStyle = on ? C.loop : C.loopOff;
      g.fillRect(xOf(a), 0, Math.max(dpr, xOf(b) - xOf(a)), H);
    }
    // View window
    g.strokeStyle = C.dim;
    g.lineWidth = dpr;
    if (this.span < this.duration - 0.01) g.strokeRect(xOf(this.view.start) + 0.5, 0.5, Math.max(2 * dpr, xOf(this.view.end) - xOf(this.view.start) - 1), H - 1);
    g.fillStyle = C.head;
    g.fillRect(xOf(pos) - dpr / 2, 0, dpr, H);
  }

  // ---- interaction ----
  bindMain() {
    const cv = this.cv;
    cv.addEventListener("pointerdown", (e) => {
      if (!this.duration) return;
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 2) {
        const [p, q] = [...this.pointers.values()];
        this.gesture = { kind: "pinch", dist: Math.abs(p.x - q.x) || 1, view: { ...this.view }, center: this.xToT((p.x + q.x) / 2) };
        return;
      }
      const t = this.xToT(e.offsetX);
      const { a, b } = this.state;
      const near = (h) => h !== null && Math.abs(this.tToX(h) - e.offsetX) < HANDLE_REACH;
      // Prefer the closer handle when both are in reach.
      let handle = null;
      if (near(a) && near(b)) handle = Math.abs(this.tToX(a) - e.offsetX) <= Math.abs(this.tToX(b) - e.offsetX) ? "a" : "b";
      else if (near(a)) handle = "a";
      else if (near(b)) handle = "b";
      this.gesture = handle
        ? { kind: "handle", handle, x0: e.offsetX, t0: t, orig: handle === "a" ? a : b }
        : { kind: "tap", x0: e.offsetX, view: { ...this.view }, moved: false };
      this.holdFollow(4000);
    });
    cv.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId) || !this.gesture) return;
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      const g = this.gesture;
      if (g.kind === "pinch" && this.pointers.size === 2) {
        const [p, q] = [...this.pointers.values()];
        const dist = Math.abs(p.x - q.x) || 1;
        const span = clamp((g.view.end - g.view.start) * g.dist / dist, Math.min(MIN_SPAN, this.duration), this.duration);
        const frac = (g.center - g.view.start) / (g.view.end - g.view.start);
        this.view = { start: g.center - frac * span, end: g.center - frac * span + span };
        this.clampView();
        this.dirty = true;
      } else if (g.kind === "handle") {
        const t = clamp(g.orig + (e.offsetX - g.x0) / this.cv.clientWidth * this.span, 0, this.duration);
        if (g.handle === "a") this.h.setA(Math.min(t, this.state.b !== null ? this.state.b - 0.05 : t), true);
        else this.h.setB(Math.max(t, this.state.a !== null ? this.state.a + 0.05 : t), true);
      } else if (g.kind === "tap" || g.kind === "pan") {
        const dx = e.offsetX - g.x0;
        if (Math.abs(dx) > 6) g.kind = "pan";
        if (g.kind === "pan") {
          const dt = -dx / this.cv.clientWidth * (g.view.end - g.view.start);
          this.view = { start: g.view.start + dt, end: g.view.end + dt };
          this.clampView();
          this.dirty = true;
        }
      }
      this.holdFollow(4000);
    });
    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const g = this.gesture;
      if (!g) return;
      if (g.kind === "tap" && e.type === "pointerup") this.h.seek(this.xToT(e.offsetX));
      if (g.kind === "handle") this.h.loopChanged();
      if (this.pointers.size === 0) this.gesture = null;
      else if (g.kind === "pinch") this.gesture = { kind: "none" };
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    // Desktop nicety: ctrl/trackpad-pinch wheel zooms, plain wheel pans.
    cv.addEventListener("wheel", (e) => {
      if (!this.duration) return;
      e.preventDefault();
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) this.zoom(Math.exp(-e.deltaY * 0.01), this.xToT(e.offsetX));
      else { const dt = e.deltaX / this.cv.clientWidth * this.span; this.view.start += dt; this.view.end += dt; this.clampView(); this.dirty = true; }
      this.holdFollow();
    }, { passive: false });
  }

  bindOverview() {
    const ov = this.ov;
    const move = (e) => {
      if (!this.duration) return;
      const t = clamp(e.offsetX / ov.clientWidth, 0, 1) * this.duration;
      const span = this.span;
      this.view = { start: t - span / 2, end: t + span / 2 };
      this.clampView();
      this.dirty = true;
      this.holdFollow(4000);
    };
    ov.addEventListener("pointerdown", (e) => { ov.setPointerCapture(e.pointerId); this.ovDrag = true; move(e); });
    ov.addEventListener("pointermove", (e) => { if (this.ovDrag) move(e); });
    ov.addEventListener("pointerup", () => { this.ovDrag = false; });
    ov.addEventListener("pointercancel", () => { this.ovDrag = false; });
  }
}

function niceStep(raw) {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s >= raw) || 600;
}

function fmtGrid(t, step) {
  if (step < 1) return fmtTime(t).replace(/^0:/, "");
  return fmtTime(t, false);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
