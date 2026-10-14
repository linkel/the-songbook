// The analysis host: decodes a recording to mono 44.1 kHz, runs
// analysis-worker.js (essentia.js) on it, and reports progress.
// The audio never leaves the device.

export const SR = 44100;

let worker = null;
let seq = 0;
const jobs = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./analysis-worker.js", import.meta.url));
    worker.onmessage = (e) => {
      const job = jobs.get(e.data.id);
      if (!job) return;
      if (e.data.type === "progress") job.onProgress && job.onProgress(e.data.step, e.data.p);
      else {
        jobs.delete(e.data.id);
        if (e.data.type === "result") job.resolve(e.data.result);
        else job.reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => {
      for (const job of jobs.values()) job.reject(new Error(e.message || "The analyser stopped"));
      jobs.clear();
      worker = null;
    };
  }
  return worker;
}

// File, Blob or ArrayBuffer -> { mono: Float32Array at 44.1 kHz, duration }.
export async function decodeToMono(input) {
  const data = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SR);
  let buf;
  try {
    buf = await ctx.decodeAudioData(data);
  } catch (e) {
    throw new Error("This file can't be decoded here (mp3, m4a/AAC, wav and flac work; files with DRM don't).");
  }
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  return { mono, duration: n / SR };
}

// mono -> the worker's raw result. The signal is copied, so the caller keeps it.
export function analyseSignal(mono, onProgress) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    const copy = mono.slice();
    getWorker().postMessage({ id, signal: copy }, [copy.buffer]);
  });
}
