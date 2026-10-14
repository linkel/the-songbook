// Decoding for the recording player, plus a small mono "analysis copy" of the
// song (about 12 kHz) that drives the waveform and "Match my tuning". The
// full-rate audio goes to the audio thread and the main thread keeps only this
// copy (~3 MB per minute). From speedy-pitcher's js/analysis.js (the owner's app).

const ANALYSIS_RATE = 12000;
const PEAK_BUCKET = 32;          // analysis samples per stored peak
const MONO_ABOVE_SECONDS = 15 * 60;
const MAX_SECONDS = 60 * 60;

export async function decodeSong(blob, ctx) {
  let data = await blob.arrayBuffer();
  let buf;
  try {
    buf = await ctx.decodeAudioData(data);
  } catch (e) {
    throw new Error("Couldn't decode the audio in this file.");
  }
  data = null;
  if (buf.duration > MAX_SECONDS) throw new Error("This file is over an hour long — too big to load on a phone.");

  const analysis = makeAnalysis(buf);
  let channels;
  if (buf.numberOfChannels === 1) {
    channels = [buf.getChannelData(0)];
  } else if (buf.duration > MONO_ABOVE_SECONDS) {
    // Long files (lessons, live sets): mono halves the memory.
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    const m = new Float32Array(buf.length);
    for (let i = 0; i < m.length; i++) m[i] = 0.5 * (l[i] + r[i]);
    channels = [m];
  } else {
    channels = [buf.getChannelData(0), buf.getChannelData(1)];
  }
  return { channels, duration: buf.duration, sampleRate: buf.sampleRate, analysis };
}

// RBJ low-pass biquad coefficients.
function lowpass(fc, sr, q) {
  const w = 2 * Math.PI * fc / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 };
}

export function makeAnalysis(buf) {
  const sr = buf.sampleRate;
  const dec = Math.max(1, Math.round(sr / ANALYSIS_RATE));
  const outRate = sr / dec;
  const n = Math.floor(buf.length / dec);
  const out = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c));
  const g = 1 / chans.length;
  // 4th-order Butterworth anti-alias filter at 0.4 × the new rate.
  const f1 = lowpass(0.4 * outRate, sr, 0.5412), f2 = lowpass(0.4 * outRate, sr, 1.3066);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
  let j = 0, k = 0;
  const len = buf.length;
  for (let i = 0; i < len; i++) {
    let x = 0;
    for (let c = 0; c < chans.length; c++) x += chans[c][i];
    x *= g;
    const y = f1.b0 * x + f1.b1 * x1 + f1.b2 * x2 - f1.a1 * y1 - f1.a2 * y2;
    x2 = x1; x1 = x;
    const z = f2.b0 * y + f2.b1 * y1 + f2.b2 * y2 - f2.a1 * z1 - f2.a2 * z2;
    y2 = y1; y1 = y; z2 = z1; z1 = z;
    if (++k === dec) { k = 0; if (j < n) out[j++] = z; }
  }
  return { samples: out, rate: outRate, peaks: makePeaks(out) };
}

// Min/max per PEAK_BUCKET samples, for drawing zoomed-out views quickly.
function makePeaks(s) {
  const nb = Math.ceil(s.length / PEAK_BUCKET);
  const p = new Float32Array(nb * 2);
  for (let b = 0; b < nb; b++) {
    let lo = 0, hi = 0;
    const end = Math.min(s.length, (b + 1) * PEAK_BUCKET);
    for (let i = b * PEAK_BUCKET; i < end; i++) { const v = s[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    p[2 * b] = lo; p[2 * b + 1] = hi;
  }
  return { data: p, bucket: PEAK_BUCKET };
}

/* ---------- Tuning estimate ----------
   How far the recording sits from A440, in cents (-50..+50). Every strong
   spectral peak in a stretch of the song "votes" with its offset from the
   nearest equal-tempered note. Offsets are averaged on a circle (so +49 and
   -49 agree), which also makes octave and fifth confusions harmless — they
   don't change a note's offset. Works on full mixes, not just solo lines. */

export function estimateTuning(an, t0, t1) {
  const sr = an.rate, s = an.samples;
  const N = 8192, hop = 1024;
  const i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(s.length, Math.floor(t1 * sr));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2);
  const kLo = Math.ceil(120 * N / sr), kHi = Math.min(N / 2 - 3, Math.floor(3000 * N / sr));
  let C = 0, S = 0, W = 0, peaksUsed = 0;
  for (let off = i0; off + N <= i1; off += hop) {
    let energy = 0;
    for (let i = 0; i < N; i++) { const v = s[off + i]; re[i] = v * win[i]; im[i] = 0; energy += v * v; }
    if (energy / N < 1e-6) continue;          // silence
    fft(re, im);
    let top = 0;
    for (let k = kLo - 2; k <= kHi + 2; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > top) top = mag[k]; }
    const floor = top * 0.08;
    for (let k = kLo; k <= kHi; k++) {
      const m = mag[k];
      if (m < floor || m <= mag[k - 1] || m < mag[k + 1] || m <= mag[k - 2] || m < mag[k + 2]) continue;
      // Parabolic interpolation on log magnitude: sub-bin peak frequency.
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m), c = Math.log(mag[k + 1] + 1e-12);
      const d = a - 2 * b + c;
      const delta = d < 0 ? 0.5 * (a - c) / d : 0;
      const f = (k + delta) * sr / N;
      const cents = 1200 * Math.log2(f / 440);
      const ang = 2 * Math.PI * cents / 100;
      const w = m / top;
      C += w * Math.cos(ang); S += w * Math.sin(ang); W += w;
      peaksUsed++;
    }
  }
  if (peaksUsed < 20 || W === 0) return null;
  const cents = Math.atan2(S, C) / (2 * Math.PI) * 100;
  const confidence = Math.hypot(C, S) / W;   // 1 = every peak agrees
  return { cents, confidence, a4: 440 * Math.pow(2, cents / 1200), peaks: peaksUsed };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
