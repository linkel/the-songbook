// Audio analysis off the main thread, with essentia.js (MTG/UPF, AGPL-3.0,
// vendor/essentia), loaded the first time it's needed.
// In: { id, signal } — mono Float32Array at 44.1 kHz.
// Out: progress messages, then { type: "result", id, result } with tempo and
// beats (RhythmExtractor2013), the key by three profiles (KeyExtractor), and
// per beat a bass and a treble chroma plus the tuning (js/chroma.js). Chords
// are named from the chroma on the page (js/chordrec.js), so changing the
// tempo or bar lines never needs the audio again.
/* global EssentiaWASM, Essentia */

const SR = 44100;
const VENDOR = new URL("../vendor/essentia/", self.location.href).href;

// The web build of essentia.js expects a page: it reads document.currentScript
// to find its .wasm (we pass locateFile instead) and may set document.title.
self.document = self.document || { currentScript: null, title: "" };
importScripts(VENDOR + "essentia-wasm.web.js", VENDOR + "essentia.js-core.js", new URL("./chroma.js", self.location.href).href);

let ess = null;
async function load() {
  if (!ess) {
    const mod = await EssentiaWASM({ locateFile: (p) => VENDOR + p });
    ess = new Essentia(mod);
  }
  return ess;
}

const free = (...vs) => { for (const v of vs) if (v && typeof v.delete === "function") v.delete(); };

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

    // Bass and treble chroma per beat, and the tuning (js/chroma.js).
    progress("chords", 0);
    const ch = self.SongbookChroma.beatChroma(signal, ticks, (p) => progress("chords", p));
    progress("chords", 1);

    // Key, with three profiles to compare, at the recording's tuning.
    progress("key", 0);
    const keys = {};
    for (const profile of ["edma", "bgate", "temperley"]) {
      const k = es.KeyExtractor(sig, true, 4096, 4096, 12, 3500, 60, 25, 0.2, profile, SR, 0.0001, 440 * Math.pow(2, ch.tuning / 1200), "cosine", "hann");
      keys[profile] = { key: k.key, scale: k.scale, strength: k.strength };
      progress("key", Object.keys(keys).length / 3);
    }
    free(sig);

    self.postMessage({ type: "result", id, result: {
      duration: signal.length / SR, bpm, bpmConfidence, ticks, keys, chroma: ch,
      version: es.version, ms: Math.round(performance.now() - t0),
    } });
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
  }
};
