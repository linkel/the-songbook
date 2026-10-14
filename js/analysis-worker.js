// Audio analysis off the main thread, with essentia.js (MTG/UPF, AGPL-3.0,
// vendor/essentia), loaded the first time it's needed.
// In: { id, signal } — mono Float32Array at 44.1 kHz.
// Out: progress messages, then { type: "result", id, result } with tempo and
// beats (RhythmExtractor2013), the key by three profiles (KeyExtractor), and
// a chord per beat (HPCP -> ChordsDetectionBeats), plus each beat's mean chroma.
/* global EssentiaWASM, Essentia */

const SR = 44100;
const FRAME = 4096, HOP = 2048;
const VENDOR = new URL("../vendor/essentia/", self.location.href).href;

// The web build of essentia.js expects a page: it reads document.currentScript
// to find its .wasm (we pass locateFile instead) and may set document.title.
self.document = self.document || { currentScript: null, title: "" };
importScripts(VENDOR + "essentia-wasm.web.js", VENDOR + "essentia.js-core.js");

let ess = null;
async function load() {
  if (!ess) {
    const mod = await EssentiaWASM({ locateFile: (p) => VENDOR + p });
    ess = new Essentia(mod);
  }
  return ess;
}

const free = (...vs) => { for (const v of vs) if (v && typeof v.delete === "function") v.delete(); };

function stringsOf(v) {
  if (Array.isArray(v)) return v;
  const out = [];
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  return out;
}

self.onmessage = async (e) => {
  const { id, signal } = e.data;
  const progress = (step, p) => self.postMessage({ type: "progress", id, step, p });
  try {
    progress("load", 0);
    const es = await load();
    progress("load", 1);
    const t0 = performance.now();

    // Tempo and beats.
    progress("tempo", 0);
    const sig = es.arrayToVector(signal);
    const rhythm = es.RhythmExtractor2013(sig, 208, "multifeature", 40);
    const ticks = Array.from(es.vectorToArray(rhythm.ticks));
    const bpm = rhythm.bpm, bpmConfidence = rhythm.confidence;
    free(rhythm.ticks, rhythm.estimates, rhythm.bpmIntervals);
    progress("tempo", 1);

    // Key, with three profiles to compare.
    progress("key", 0);
    const keys = {};
    for (const profile of ["edma", "bgate", "temperley"]) {
      const k = es.KeyExtractor(sig, true, 4096, 4096, 12, 3500, 60, 25, 0.2, profile, SR, 0.0001, 440, "cosine", "hann");
      keys[profile] = { key: k.key, scale: k.scale, strength: k.strength };
      progress("key", Object.keys(keys).length / 3);
    }
    free(sig);

    // Chroma (HPCP) frame by frame; frames are sliced here so the whole song
    // never sits in the WebAssembly heap as frames at once.
    const nFrames = Math.max(1, Math.floor((signal.length - FRAME) / HOP) + 1);
    const pcp = new es.module.VectorVectorFloat();
    const chroma = new Float32Array(nFrames * 12);
    for (let i = 0; i < nFrames; i++) {
      const frame = es.arrayToVector(signal.subarray(i * HOP, i * HOP + FRAME));
      const w = es.Windowing(frame, true, FRAME, "blackmanharris62", 0, true);
      const sp = es.Spectrum(w.frame, FRAME);
      const pk = es.SpectralPeaks(sp.spectrum, 0.00001, 5000, 100, 40, "magnitude", SR);
      const h = es.HPCP(pk.frequencies, pk.magnitudes, true, 500, 8, 5000, false, 40, false, "unitMax", 440, SR, 12, "cosine", 1);
      pcp.push_back(h.hpcp);
      chroma.set(es.vectorToArray(h.hpcp), i * 12);
      free(frame, w.frame, sp.spectrum, pk.frequencies, pk.magnitudes, h.hpcp);
      if (i % 200 === 0) progress("chords", 0.9 * i / nFrames);
    }

    // A chord per beat interval.
    const tv = es.arrayToVector(Float32Array.from(ticks));
    const cd = es.ChordsDetectionBeats(pcp, tv, "interbeat_median", HOP, SR);
    const chords = stringsOf(cd.chords);
    const strength = Array.from(es.vectorToArray(cd.strength));
    free(tv, cd.chords, cd.strength, pcp);

    // Mean chroma per beat interval (index 0 = A), for later checks.
    const beatChroma = [];
    for (let b = 0; b + 1 < ticks.length; b++) {
      const f0 = Math.floor(ticks[b] * SR / HOP), f1 = Math.max(f0 + 1, Math.floor(ticks[b + 1] * SR / HOP));
      const m = new Array(12).fill(0);
      let n = 0;
      for (let f = f0; f < f1 && f < nFrames; f++, n++) for (let k = 0; k < 12; k++) m[k] += chroma[f * 12 + k];
      beatChroma.push(m.map((x) => Math.round((n ? x / n : 0) * 1000) / 1000));
    }
    progress("chords", 1);

    self.postMessage({ type: "result", id, result: {
      duration: signal.length / SR, bpm, bpmConfidence, ticks, keys, chords, strength, beatChroma,
      version: es.version, ms: Math.round(performance.now() - t0),
    } });
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
  }
};
