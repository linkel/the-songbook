// Chroma for chord detection: a plain-JS take on NNLS Chroma (Matthias Mauch
// and Simon Dixon, 2010; the front end of Chordino). essentia.js has a port,
// but it rebuilds its tables on every call, which is far too slow on a phone.
//
//   signal (44.1 kHz) -> 11025 Hz -> 4096-point spectra every 46 ms
//   -> a log-frequency spectrum, 3 bins per semitone, A0..G#7
//   -> averaged over each beat -> tuning (from where energy sits inside each
//   semitone) -> one value per semitone, whitened -> note saliences by
//   non-negative least squares against notes with decaying harmonics
//   -> a bass chroma and a treble chroma per beat (index 0 = A).
//
// A classic script with no imports or exports: the analysis worker loads it
// with importScripts, and node tests import it for its side effect. Either
// way it sets globalThis.SongbookChroma.
(function () {
  const SR_IN = 44100, DOWN = 4, SR = SR_IN / DOWN;
  const N = 4096, HOP = 512;
  const BPS = 3, NOTES = 84, BINS = NOTES * BPS;
  const F0 = 27.5;   // A0

  // Low-pass (windowed sinc, cutoff 4.6 kHz) and keep every 4th sample.
  function decimate(x) {
    const TAPS = 63, mid = (TAPS - 1) / 2, fc = 4600 / SR_IN;
    const h = new Float32Array(TAPS);
    let sum = 0;
    for (let i = 0; i < TAPS; i++) {
      const n = i - mid;
      const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (TAPS - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (TAPS - 1));
      h[i] = sinc * w;
      sum += h[i];
    }
    for (let i = 0; i < TAPS; i++) h[i] /= sum;
    const out = new Float32Array(Math.floor(x.length / DOWN));
    for (let o = 0; o < out.length; o++) {
      const c = o * DOWN;
      let acc = 0;
      const lo = Math.max(0, c - mid), hi = Math.min(x.length - 1, c + mid);
      for (let j = lo; j <= hi; j++) acc += x[j] * h[j - c + mid];
      out[o] = acc;
    }
    return out;
  }

  // In-place radix-2 FFT of (re, im), length a power of two.
  function makeFFT(n) {
    const rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    return (re, im) => {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0; k < half; k++) {
            const wr = cos[k * step], wi = sin[k * step];
            const a = start + k, b = a + half;
            const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi;
            re[a] += xr; im[a] += xi;
          }
        }
      }
    };
  }

  // Where each log bin reads the linear spectrum: interpolated at its centre
  // when it's narrower than an FFT bin, else the largest FFT bin inside it.
  // Bin 3s+1 sits exactly on semitone s of the A440 grid.
  function logTable() {
    const df = SR / N;
    const t = [];
    for (let j = 0; j < BINS; j++) {
      const f = F0 * Math.pow(2, (j - 1) / 36);
      const lo = f * Math.pow(2, -1 / 72) / df, hi = f * Math.pow(2, 1 / 72) / df;
      if (hi - lo < 1) t.push({ at: f / df });
      else t.push({ from: Math.ceil(lo), to: Math.min(N / 2, Math.floor(hi)) });
    }
    return t;
  }

  // Spectrogram on the log axis: { frames: Float32Array(n * BINS), n, hopSec, winSec }.
  function logSpectrogram(x44, onProgress) {
    const x = decimate(x44);
    const n = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
    const fft = makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const table = logTable();
    const re = new Float64Array(N), im = new Float64Array(N), mag = new Float32Array(N / 2 + 1);
    const frames = new Float32Array(n * BINS);
    for (let f = 0; f < n; f++) {
      const off = f * HOP;
      for (let i = 0; i < N; i++) { re[i] = (x[off + i] || 0) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k <= N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
      const row = f * BINS;
      for (let j = 0; j < BINS; j++) {
        const e = table[j];
        let v;
        if (e.at !== undefined) {
          const k = Math.floor(e.at), fr = e.at - k;
          v = mag[k] * (1 - fr) + (mag[k + 1] || 0) * fr;
        } else {
          v = 0;
          for (let k = e.from; k <= e.to; k++) if (mag[k] > v) v = mag[k];
        }
        frames[row + j] = v;
      }
      if (onProgress && f % 400 === 0) onProgress(f / n);
    }
    return { frames, n, hopSec: HOP / SR, winSec: N / SR };
  }

  // Mean log spectrum per interval between consecutive times (seconds).
  function averageOver(spec, times) {
    const out = [];
    const centre = (f) => f * spec.hopSec + spec.winSec / 2;
    for (let b = 0; b + 1 < times.length; b++) {
      const acc = new Float32Array(BINS);
      let cnt = 0;
      let f0 = Math.max(0, Math.ceil((times[b] - spec.winSec / 2) / spec.hopSec));
      for (let f = f0; f < spec.n && centre(f) < times[b + 1]; f++) {
        const row = f * BINS;
        for (let j = 0; j < BINS; j++) acc[j] += spec.frames[row + j];
        cnt++;
      }
      // A beat shorter than a hop: use the nearest frame.
      if (!cnt) {
        const f = Math.min(spec.n - 1, Math.max(0, Math.round((times[b] - spec.winSec / 2) / spec.hopSec)));
        for (let j = 0; j < BINS; j++) acc[j] = spec.frames[f * BINS + j];
        cnt = 1;
      }
      for (let j = 0; j < BINS; j++) acc[j] /= cnt;
      out.push(acc);
    }
    return out;
  }

  // Tuning in cents from A440: where energy sits among each semitone's three bins.
  function tuning(rows) {
    let c = 0, s = 0;
    for (const r of rows) {
      for (let j = 0; j < BINS; j++) {
        const k = (j % 3) - 1;
        c += r[j] * Math.cos(2 * Math.PI * k / 3);
        s += r[j] * Math.sin(2 * Math.PI * k / 3);
      }
    }
    return Math.atan2(s, c) / (2 * Math.PI) * 100;
  }

  // NNLS dictionary: each note with harmonics decaying by 0.7, at semitone
  // resolution, columns normalised. Returns the Gram matrix's pieces.
  function dictionary(shape = 0.7) {
    const A = [];
    for (let n = 0; n < NOTES; n++) {
      const col = new Float64Array(NOTES);
      for (let h = 1; h <= 20; h++) {
        const pos = n + 12 * Math.log2(h);
        const lo = Math.floor(pos), fr = pos - lo;
        const amp = Math.pow(shape, h - 1);
        if (lo < NOTES) col[lo] += amp * (1 - fr);
        if (lo + 1 < NOTES) col[lo + 1] += amp * fr;
      }
      let norm = 0;
      for (const v of col) norm += v * v;
      norm = Math.sqrt(norm);
      for (let i = 0; i < NOTES; i++) col[i] /= norm;
      A.push(col);
    }
    const G = new Float64Array(NOTES * NOTES);
    for (let i = 0; i < NOTES; i++) for (let j = 0; j < NOTES; j++) {
      let v = 0;
      for (let k = 0; k < NOTES; k++) v += A[i][k] * A[j][k];
      G[i * NOTES + j] = v;
    }
    let L = 0;   // a bound on G's largest eigenvalue (max row sum)
    for (let i = 0; i < NOTES; i++) { let r = 0; for (let j = 0; j < NOTES; j++) r += Math.abs(G[i * NOTES + j]); L = Math.max(L, r); }
    return { A, G, L };
  }

  const DICTS = {};

  // min |A x - y| with x >= 0, by accelerated projected gradient.
  function nnls(y, iters = 80, shape = 0.7) {
    const DICT = DICTS[shape] = DICTS[shape] || dictionary(shape);
    const { A, G, L } = DICT;
    const b = new Float64Array(NOTES);
    for (let i = 0; i < NOTES; i++) { let v = 0; for (let k = 0; k < NOTES; k++) v += A[i][k] * y[k]; b[i] = v; }
    let x = new Float64Array(NOTES), z = new Float64Array(NOTES), xNew = new Float64Array(NOTES);
    let t = 1;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < NOTES; i++) {
        let g = -b[i];
        const row = i * NOTES;
        for (let j = 0; j < NOTES; j++) g += G[row + j] * z[j];
        xNew[i] = Math.max(0, z[i] - g / L);
      }
      const tNew = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
      for (let i = 0; i < NOTES; i++) z[i] = xNew[i] + ((t - 1) / tNew) * (xNew[i] - x[i]);
      [x, xNew] = [xNew, x];
      t = tNew;
    }
    return x;
  }

  // A raised-cosine weight over a MIDI range.
  const bell = (midi, lo, hi) => (midi <= lo || midi >= hi ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * (midi - lo) / (hi - lo)));

  // Per-interval rows -> { treble, bass, energy, notes } (each a list of 12-arrays, index 0 = A).
  // Whitening reach (semitones each side) and harmonic decay, chosen on test
  // songs; the treble and bass ranges (MIDI) are raised-cosine weights.
  const WHITEN = 24, SHAPE = 0.7, TREBLE = [44, 92], BASS = [26, 57];

  function chromaFromRows(rows, cents) {
    const shift = cents / 100 * 3;   // in log bins
    const treble = [], bass = [], energy = [];
    for (const r of rows) {
      const sem = new Float64Array(NOTES);
      let e = 0;
      for (let s = 0; s < NOTES; s++) {
        const p = 3 * s + 1 + shift, k = Math.floor(p), fr = p - k;
        sem[s] = (r[k] || 0) * (1 - fr) + (r[k + 1] || 0) * fr;
        e += sem[s] * sem[s];
      }
      // Whitening: subtract the running mean over four octaves, divide by
      // its spread, drop what's below the mean.
      const white = new Float64Array(NOTES);
      for (let s = 0; s < NOTES; s++) {
        let m = 0, cnt = 0;
        for (let q = Math.max(0, s - WHITEN); q <= Math.min(NOTES - 1, s + WHITEN); q++) { m += sem[q]; cnt++; }
        m /= cnt;
        let v = 0;
        for (let q = Math.max(0, s - WHITEN); q <= Math.min(NOTES - 1, s + WHITEN); q++) v += (sem[q] - m) ** 2;
        const sd = Math.sqrt(v / cnt) + 1e-9;
        white[s] = Math.max(0, (sem[s] - m) / sd);
      }
      const x = nnls(white, 80, SHAPE);
      const t = new Array(12).fill(0), bs = new Array(12).fill(0);
      for (let n = 0; n < NOTES; n++) {
        const midi = 21 + n;
        t[n % 12] += x[n] * bell(midi, TREBLE[0], TREBLE[1]);
        bs[n % 12] += x[n] * bell(midi, BASS[0], BASS[1]);
      }
      const r3 = (v) => Math.round(v * 1000) / 1000;
      treble.push(t.map(r3));
      bass.push(bs.map(r3));
      energy.push(r3(Math.sqrt(e / NOTES)));
    }
    return { treble, bass, energy };
  }

  // The whole thing: signal + beat times -> { tuning (cents), treble, bass, energy } per beat.
  function beatChroma(x44, times, onProgress) {
    const spec = logSpectrogram(x44, onProgress && ((p) => onProgress(0.8 * p)));
    const rows = averageOver(spec, times);
    const cents = tuning(rows);
    const out = chromaFromRows(rows, cents);
    if (onProgress) onProgress(1);
    return { tuning: Math.round(cents * 10) / 10, treble: out.treble, bass: out.bass, energy: out.energy };
  }

  globalThis.SongbookChroma = { SR, N, HOP, NOTES, decimate, makeFFT, logSpectrogram, averageOver, tuning, nnls, chromaFromRows, beatChroma };
})();
