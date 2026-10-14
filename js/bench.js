// From speedy-pitcher's js/bench.js (the owner's app). On-device check of how
// fast Signalsmith Stretch runs: renders 10 s of a
// synthetic stereo mix at 75% speed, +2 semitones, offline, and returns how
// many times faster than real time that was. Real-time playback needs > 1×;
// several × leaves room for the phone to do other things.

import SignalsmithStretch from "../vendor/signalsmith-stretch/SignalsmithStretch.mjs";
import { STRETCH_CONFIG } from "./engine.js";

export async function benchmark(seconds = 10) {
  const sr = 48000, rate = 0.75;
  const n = seconds * sr;
  const L = new Float32Array(n), R = new Float32Array(n);
  const notes = [110, 164.8, 220, 277.2, 329.6];
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (let k = 0; k < notes.length; k++) v += Math.sin(2 * Math.PI * notes[k] * t * (1 + 0.002 * k)) * Math.exp(-((t * 2) % 1) * 3) * 0.15;
    const noise = rand() * 0.02;
    L[i] = v + noise; R[i] = v * 0.8 - noise;
  }
  const outLen = Math.ceil(n / rate);
  const oc = new OfflineAudioContext(2, outLen, sr);
  const node = await SignalsmithStretch(oc);
  await node.configure(STRETCH_CONFIG);
  node.connect(oc.destination);
  await node.addBuffers([L, R]);
  await node.schedule({ output: 0, outputTime: 0, input: 0, active: true, rate, semitones: 2 });
  const t0 = performance.now();
  await oc.startRendering();
  const ms = performance.now() - t0;
  return (outLen / sr) / (ms / 1000);
}
