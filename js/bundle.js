// Analysis bundles from the PC helper (helper/analysis.py): a stored zip with
// bundle.json (the manifest), chart.json (a detected chart in the app's own
// format, with per-beat chords so bar lines and tempo can still change),
// stems/*.m4a, timing.json (your lyric lines lined up with the vocals) when
// you sent lyrics, and part.json (the guitar part, detected) when you asked
// for it. audio.m4a is the recording itself when the PC downloaded it from a
// link. A "partsOnly" bundle (the part found again for an earlier analysis)
// has just part.json. Importing keeps it all on this device: the chart and
// parts in IndexedDB, the stems and recording in OPFS.
// checkManifest/checkChart are pure; node tests them.

import { readZip } from "./zip.js";
import { saveChart } from "./library.js";
import { saveStems, saveRecording, recordingMeta } from "./recordings.js";
import { saveTiming } from "./lyrics.js";
import { keepShippedFacts } from "./chartfile.js";
import { parseChord } from "./chords.js";
import { checkPart, loadParts, saveSectionPart } from "./part.js";

export const BUNDLE_VERSION = 1;
const STEM_NAMES = ["vocals", "guitar", "bass", "drums", "piano", "other"];

export function checkManifest(m) {
  if (!m || m.app !== "songbook" || m.kind !== "bundle") throw new Error("That zip isn't an analysis bundle from the PC helper.");
  if (!(m.version >= 1)) throw new Error("That bundle is from an unknown helper version.");
  if (m.version > BUNDLE_VERSION) throw new Error("That bundle is from a newer helper; update the app first.");
  if (!Array.isArray(m.files)) throw new Error("The bundle lists no files.");
  if (!m.partsOnly && !m.files.includes("chart.json")) throw new Error("The bundle has no chart.json.");
  const stems = Array.isArray(m.stems) ? m.stems : [];
  for (const s of stems) {
    if (!STEM_NAMES.includes(s.name) || !m.files.includes(s.file)) throw new Error(`The bundle's stem "${s.name}" is missing.`);
  }
  return m;
}

// A chart from the helper, made safe to store: detected, with bars that have
// times and chords the app can read. Throws if it isn't usable.
export function checkChart(c) {
  if (!c || !Array.isArray(c.sections) || !Array.isArray(c.bars) || !Array.isArray(c.beats)) throw new Error("The bundle's chart.json isn't a chart.");
  if (c.source !== "detected" || !c.detector) throw new Error("The bundle's chart should say it was detected, and by what.");
  const bars = c.bars.filter((b) => b && typeof b.t === "number" && Array.isArray(b.chords) && b.chords.length);
  if (!bars.length) throw new Error("The bundle's chart has no bars.");
  for (const b of bars) {
    if (b.chords.some((x) => { const p = parseChord(x); return !p || p.nc; })) throw new Error(`The bundle's chart has a chord the app can't read: ${b.chords.join(" ")}.`);
  }
  for (const s of c.sections) {
    if (typeof s.name !== "string" || typeof s.chords !== "string") throw new Error("The bundle's chart has a broken section.");
  }
  const out = structuredClone(c);
  out.bars = bars;
  out.form = (c.form || []).filter((n) => c.sections.some((s) => s.name === n));
  out.voicings = out.voicings || {};
  out.sources = [];
  return out;
}

async function json(files, name) {
  const f = files.get(name);
  if (!f) return null;
  try { return JSON.parse(await f.blob.text()); } catch (e) { throw new Error(`The bundle's ${name} isn't valid JSON.`); }
}

// Import a bundle for song `songId`. ctx: { title, artist, shipped (the
// shipped chart, if any), lyricCount (lines in your sheet) }.
// -> { chart, stems: n, timing: n, audio: bool, manifest }.
// part.json -> each section's detected part, kept on this device. A part of
// yours (written or checked) is never replaced by a detection. -> sections saved.
export async function importParts(doc, songId, sectionNames) {
  if (!doc || !doc.sections) return 0;
  const have = await loadParts(songId);
  let n = 0;
  for (const [name, part] of Object.entries(doc.sections)) {
    if (!sectionNames.includes(name) || checkPart(part).length) continue;
    if (have[name] && have[name].source !== "detected") continue;
    await saveSectionPart(songId, name, { ...part, tuning: doc.tuning, capo: doc.capo });
    n++;
  }
  return n;
}

export async function importBundle(blob, songId, ctx = {}) {
  const files = await readZip(blob);
  const manifest = checkManifest(await json(files, "bundle.json"));
  if (manifest.partsOnly) {
    const names = (ctx.chart && ctx.chart.sections || []).map((s) => s.name);
    const parts = manifest.files.includes("part.json") ? await importParts(await json(files, "part.json"), songId, names) : 0;
    return { chart: ctx.chart || null, stems: 0, timing: 0, audio: false, parts, manifest, partsOnly: true };
  }
  const chart = checkChart(await json(files, "chart.json"));
  Object.assign(chart, { id: songId, title: ctx.title || chart.title, artist: ctx.artist || chart.artist });
  keepShippedFacts(chart, ctx.shipped);
  chart.analysis = { ...(chart.analysis || {}), bundle: { created: manifest.created, job: manifest.job || null, stems: (manifest.stems || []).map((s) => s.name) } };

  // The recording itself, when the PC downloaded it (it's what the bar times fit).
  let audio = false;
  if (manifest.audio && files.has(manifest.audio)) {
    const name = ((manifest.source && manifest.source.name) || "Download").replace(/\.[^.]+$/, "") + ".m4a";
    const file = new File([files.get(manifest.audio).blob], name, { type: "audio/mp4" });
    await saveRecording(songId, file, { source: "helper", link: manifest.source && manifest.source.link });
    audio = true;
  } else if (manifest.source && manifest.source.name && !(await recordingMeta(songId))) {
    chart.notes = (chart.notes || "") + ` The bar times fit ${manifest.source.name}.`;
  }

  const stems = (manifest.stems || []).map((s) => ({ name: s.name, label: s.label, blob: new Blob([files.get(s.file).blob], { type: "audio/mp4" }) }));
  if (stems.length) await saveStems(songId, stems, { detector: manifest.detector, from: manifest.created, file: manifest.source && manifest.source.name });

  let timing = 0;
  const t = manifest.files.includes("timing.json") ? await json(files, "timing.json") : null;
  if (t && Array.isArray(t.lines) && t.lines.length) {
    const max = ctx.lyricCount ?? Infinity;
    const lines = t.lines.filter((x) => Number.isInteger(x.index) && x.index >= 0 && x.index < max && isFinite(x.t));
    if (lines.length) { await saveTiming(songId, lines, "aligned"); timing = lines.length; }
  }

  await saveChart(chart);
  const parts = manifest.files.includes("part.json") ? await importParts(await json(files, "part.json"), songId, chart.sections.map((s) => s.name)) : 0;
  return { chart, stems: stems.length, timing, audio, parts, manifest };
}
