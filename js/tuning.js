// Tunings (plan §7, Tuning): a chart's `tuning` names the open strings from
// the low string to the high one, "D A D F# A D". Without octaves each string
// takes the octave nearest its standard pitch (D2 A2 D3 F#3 A3 D4 here);
// octaves may be written out ("D2 A2 ..."). No tuning means standard. Shapes,
// diagrams and every note the app plays use these strings, with the capo on top.
// Pure: node tests it.

const STD = [40, 45, 50, 55, 59, 64];   // E2 A2 D3 G3 B3 E4, low to high
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export const PRESETS = [
  { name: "Standard", notes: "E A D G B E" },
  { name: "Half step down", notes: "Eb Ab Db Gb Bb Eb" },
  { name: "Drop D", notes: "D A D G B E" },
  { name: "Open D", notes: "D A D F# A D" },
  { name: "Open G", notes: "D G D G B D" },
  { name: "DADGAD", notes: "D A D G A D" },
  { name: "Open C", notes: "C G C G C E" },
];

// "D A D F# A D" or "D2 A2 D3 F#3 A3 D4" -> MIDI notes, low string first.
// Throws with a readable message.
export function parseTuning(notes) {
  const toks = String(notes || "").trim().split(/[\s,]+/).filter(Boolean);
  if (toks.length !== 6) throw new Error("A tuning needs six notes, low string first, like D A D F# A D.");
  return toks.map((t, i) => {
    const m = t.match(/^([A-Ga-g])([#b♯♭]?)(-?\d)?$/);
    if (!m) throw new Error(`"${t}" isn't a note name.`);
    const pc = (PC[m[1].toUpperCase()] + (m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0) + 12) % 12;
    if (m[3] !== undefined) return (+m[3] + 1) * 12 + pc;
    // The octave nearest the string's standard pitch (a tie goes down: slacker strings).
    let best = null;
    for (let midi = STD[i] - 12; midi <= STD[i] + 12; midi++) {
      if (midi % 12 !== pc) continue;
      if (best === null || Math.abs(midi - STD[i]) < Math.abs(best - STD[i])) best = midi;
    }
    return best;
  });
}

export const STANDARD = { name: "Standard", notes: "E A D G B E", source: null, midi: STD.slice(), open: byString(STD), standard: true };

// MIDI notes low to high -> open strings indexed by string number (1 = the
// high string), the way Pimapeggio's OPEN_MIDI is.
function byString(midi) {
  return [null, midi[5], midi[4], midi[3], midi[2], midi[1], midi[0]];
}

// A tuning record ({ name, notes, source }) or null -> the tuning in full:
// { name, notes, source, midi (low to high), open (by string), standard }.
export function tuningFrom(t) {
  if (!t || !t.notes) return STANDARD;
  let midi;
  try { midi = parseTuning(t.notes); } catch (e) { return STANDARD; }
  const standard = midi.every((m, i) => m === STD[i]);
  return { name: t.name || nameFor(midi), notes: t.notes, source: t.source || null, midi, open: byString(midi), standard };
}

// The tuning a song is played in: yours (prefs.tuning), else the chart's.
export function songTuning(chart, prefs) {
  return tuningFrom((prefs && prefs.tuning) || (chart && chart.tuning) || null);
}

// A preset's name for these notes, or the notes themselves.
export function nameFor(midi) {
  for (const p of PRESETS) {
    const m = parseTuning(p.notes);
    if (m.every((x, i) => x === midi[i])) return p.name;
  }
  return midi.map((m) => NAMES[m % 12]).join(" ");
}

// Note names of the open strings, low to high ("D A D F# A D").
export function stringNames(t) {
  return t.midi.map((m) => NAMES[m % 12]);
}
