// Speed-trainer math and time formatting, from speedy-pitcher's js/practice.js
// (the owner's app).

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 1.5;

// Speed for the pass after `passes` completed loops: raise by `step` every
// `every` loops, counted from the last manual change (baseRate/basePasses).
export function trainerRate(t, passes) {
  const steps = Math.max(0, Math.floor((passes - t.basePasses) / Math.max(1, t.every)));
  const r = Math.min(Math.max(t.target, t.baseRate), t.baseRate + steps * t.step);
  return Math.round(r * 100) / 100;
}

export function fmtTime(t, tenths = true) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (!tenths) return m + ":" + String(Math.floor(s)).padStart(2, "0");
  const str = s.toFixed(1);
  return m + ":" + (s < 10 ? "0" : "") + str;
}

export function fmtSemis(st) {
  return (st > 0 ? "+" : st < 0 ? "−" : "") + Math.abs(st);
}

export function fmtCents(c) {
  return (c > 0 ? "+" : c < 0 ? "−" : "±") + Math.abs(c) + "¢";
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
