// Your charts as shippable chords-only files: Settings → Export your charts
// downloads them, and tools/add-charts.mjs puts them in songs/ so the
// deployed app (your phone) has them. Only chords and timing go in: the bars
// with their times, beats, key, tempo and tuning. Your recording's name and
// its per-beat chroma (analysis of the recording) stay on the device.
// Pure: node imports it too.

const KEEP = ["id", "type", "title", "artist", "spotify", "key", "capo", "time", "tempo", "style", "strum", "voicings",
  "sections", "form", "source", "detector", "confidence", "sources", "notes", "picking", "tuning", "links", "checkedFrom"];
const r3 = (x) => Math.round(x * 1000) / 1000;

const hasChords = (c) => !!c && (c.sections || []).some((s) => s.chords && String(s.chords).trim());

// A chart from the device -> a chart for songs/<id>.json, or null if it has no chords.
export function shippableChart(c) {
  if (!hasChords(c) || !["detected", "mine", "verified", "web"].includes(c.source)) return null;
  const out = { type: "song", spotify: null, capo: 0, voicings: {}, sources: [], form: [] };
  for (const k of KEEP) if (c[k] !== undefined && c[k] !== null) out[k] = structuredClone(c[k]);
  for (const k of ["key", "time", "tempo", "style", "strum", "detector", "confidence"]) if (out[k] === undefined) out[k] = null;
  out.sections = c.sections.filter((s) => s.chords && String(s.chords).trim()).map((s) => {
    const x = { name: s.name, chords: s.chords };
    if (s.repeat > 1) x.repeat = s.repeat;
    if (s.picking) x.picking = s.picking;
    return x;
  });
  out.form = (c.form || []).filter((n) => out.sections.some((s) => s.name === n));
  if (Array.isArray(c.beats) && c.beats.length) out.beats = c.beats.map(r3);
  if (Array.isArray(c.bars) && c.bars.length && typeof c.bars[0].t === "number") {
    out.bars = c.bars.map((b) => ({ t: r3(b.t), n: b.n, chords: b.chords.slice(), ...(b.sure === false ? { sure: false } : {}) }));
  }
  const a = c.analysis;
  if (a) {
    out.analysis = {};
    for (const k of ["bpm", "bpb", "phase", "tuning", "profile", "duration"]) if (a[k] !== undefined && a[k] !== null) out.analysis[k] = typeof a[k] === "number" ? r3(a[k]) : a[k];
    if (a.keys) out.analysis.keys = Object.fromEntries(Object.entries(a.keys).map(([p, k]) => [p, { key: k.key, scale: k.scale }]));
  }
  if (out.source === "detected" && !out.detector) out.detector = "the Songbook's analyser";
  if (!out.confidence) out.confidence = out.source === "detected" ? "low" : "medium";
  return out;
}

// The export file: { app, kind, exported, charts }.
export function chartsFile(charts) {
  return { app: "songbook", kind: "charts", exported: new Date().toISOString(), charts: charts.map(shippableChart).filter(Boolean) };
}

// What a shipped chart knows besides chords (tuning, links, picking) carries
// over to your own chart of the same song.
export function keepShippedFacts(chart, shipped) {
  if (!shipped) return chart;
  for (const k of ["type", "style", "tuning", "links", "picking"]) if (shipped[k] && !chart[k]) chart[k] = shipped[k];
  return chart;
}
