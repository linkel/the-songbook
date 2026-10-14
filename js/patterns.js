// Copied from Pimapeggio (../pimapeggio/patterns.js, same author) and converted to an
// ES module. Keep the two in step: pattern ids are shared with Pimapeggio links.

/* ================= Pattern library =================
   Each pattern is a space-separated list of steps; one step per subdivision.
   A step is one or more notes joined with "+" (played together).
   A note is a finger letter plus an optional string:
     p   alone  -> the chord's bass string
     pB / pA    -> bass / alternate bass of the chord (alternating thumb)
     i m a      -> the finger's home string (by default i=3, m=2, a=1)
     i4, p6 ... -> that exact string (used where fingers cross strings)
   npb = notes per click (beat) by default; bar = clicks per bar (default 4).
   Study references (Giuliani numbers etc.) live in suggestions.json. */

export const FAMILIES = [
  { id: "three",   name: "3-note" },
  { id: "pinch",   name: "Pinch" },
  { id: "four",    name: "4-note" },
  { id: "six",     name: "6-note" },
  { id: "alt",     name: "Alt. bass" },
  { id: "block",   name: "Block" },
  { id: "cross",   name: "Crossing" },
  { id: "tremolo", name: "Tremolo" },
];

export const PATTERN_DEFS = [
  // ---- 3-note: p then two different fingers ----
  { id: "pim", family: "three", steps: "p i m", npb: 3 },
  { id: "pmi", family: "three", steps: "p m i", npb: 3 },
  { id: "pia", family: "three", steps: "p i a", npb: 3 },
  { id: "pai", family: "three", steps: "p a i", npb: 3 },
  { id: "pma", family: "three", steps: "p m a", npb: 3 },
  { id: "pam", family: "three", steps: "p a m", npb: 3 },

  // ---- Pinch: thumb together with a finger, then the other two ----
  { id: "pi-m-a", family: "pinch", steps: "p+i m a", npb: 3 },
  { id: "pa-m-i", family: "pinch", steps: "p+a m i", npb: 3 },
  { id: "pm-i-a", family: "pinch", steps: "p+m i a", npb: 3 },
  { id: "pa-i-m", family: "pinch", steps: "p+a i m", npb: 3 },

  // ---- 4-note: p then three fingers, no finger twice in a row ----
  { id: "pima", family: "four", steps: "p i m a", npb: 4 },
  { id: "pami", family: "four", steps: "p a m i", npb: 4 },
  { id: "pimi", family: "four", steps: "p i m i", npb: 4 },
  { id: "pmim", family: "four", steps: "p m i m", npb: 4 },
  { id: "piai", family: "four", steps: "p i a i", npb: 4 },
  { id: "pama", family: "four", steps: "p a m a", npb: 4 },
  { id: "pmam", family: "four", steps: "p m a m", npb: 4 },
  { id: "paia", family: "four", steps: "p a i a", npb: 4 },
  { id: "piam", family: "four", steps: "p i a m", npb: 4 },
  { id: "paim", family: "four", steps: "p a i m", npb: 4 },
  { id: "pmia", family: "four", steps: "p m i a", npb: 4 },
  { id: "pmai", family: "four", steps: "p m a i", npb: 4 },

  // ---- 6-note ----
  { id: "pimami", family: "six", steps: "p i m a m i", npb: 3 },
  { id: "pamima", family: "six", steps: "p a m i m a", npb: 3 },
  { id: "pimiai", family: "six", steps: "p i m i a i", npb: 3 },
  { id: "piaimi", family: "six", steps: "p i a i m i", npb: 3 },
  { id: "pamami", family: "six", steps: "p a m a m i", npb: 3 },
  { id: "pimipi", family: "six", steps: "pB i m i pA i", npb: 3 },
  { id: "pmimpi", family: "six", steps: "pB m i m pA i", npb: 3 },
  { id: "pia-pim", family: "six", steps: "pB i a pA i m", npb: 3 },
  { id: "pai-pmi", family: "six", steps: "pB a i pA m i", npb: 3 },

  // ---- Alternating bass (thumb alternates between two bass strings) ----
  { id: "alt-thumb", family: "alt", name: "Alternating thumb", steps: "pB pA", npb: 1 },
  { id: "travis", family: "alt", name: "Travis: p-i-p-m", steps: "pB i pA m", npb: 2 },
  { id: "alt-pm-i", family: "alt", steps: "pB+m i pA i", npb: 2 },
  { id: "alt-im", family: "alt", steps: "pB i+m pA i", npb: 2 },
  { id: "alt-pam", family: "alt", steps: "pB i pA+m i", npb: 2 },
  { id: "alt-im2", family: "alt", steps: "pB i pA i+m", npb: 2 },
  { id: "travis-pinch", family: "alt", name: "Travis with pinch", steps: "pB+m i pA i pB i pA m", npb: 2 },

  // ---- Block chords with p ----
  { id: "blk-pim", family: "block", steps: "p+i+m", npb: 1 },
  { id: "blk-pima", family: "block", steps: "p+i+m+a", npb: 1 },
  { id: "waltz", family: "block", name: "Waltz: p, chord, chord", steps: "p i+m+a i+m+a", npb: 1, bar: 3 },
  { id: "blk3-1", family: "block", steps: "pB+m+a pA i", npb: 3 },
  { id: "blk3-2", family: "block", steps: "pB pA+m+a i", npb: 3 },
  { id: "blk3-3", family: "block", steps: "pB pA i+m+a", npb: 3 },
  { id: "blk4-1", family: "block", steps: "pB+m+a pA i pA", npb: 2 },
  { id: "blk4-2", family: "block", steps: "pB pA+m+a i pA", npb: 2 },
  { id: "blk4-3", family: "block", steps: "pB pA i+m+a pA", npb: 2 },
  { id: "blk4-4", family: "block", steps: "pB pA i pA+m+a", npb: 2 },
  { id: "pia-m", family: "block", name: "(p+i+a) m · (i+a) m", steps: "p+i+a m i+a m i+a m", npb: 2, bar: 3 },

  // ---- String crossing: fingers move to other strings ----
  { id: "x-pim", family: "cross", name: "p-i-m climbing", steps: "p5 i4 m3 p4 i3 m2 p3 i2 m1 p5 i2 m1", npb: 3 },
  { id: "x-pima", family: "cross", name: "p-i-m-a climbing", steps: "p6 i5 m4 a3 p5 i4 m3 a2 p4 i3 m2 a1 p5 i4 m3 a2", npb: 4 },
  { id: "x-amip", family: "cross", name: "a-m-i-p descending", steps: "a3 m4 i5 p6 a2 m3 i4 p5 a1 m2 i3 p4 a2 m3 i4 p5", npb: 4 },
  { id: "x-pi", family: "cross", name: "p-i walking up", steps: "p5 i3 p4 i2 p3 i1 p4 i2 p5 i3 p4 i2", npb: 3 },
  { id: "x-pmiami", family: "cross", name: "p-m-i-a-m-i, low set", steps: "p5 m3 i4 a2 m3 i4 p5 m3 i4 a1 m3 i4", npb: 3 },
  { id: "x-pima-low", family: "cross", name: "p-i-m-a on 4-3-2", steps: "p i4 m3 a2", npb: 4 },
  { id: "x-pimi-skip", family: "cross", name: "p-i-m-i, m skips to 1", steps: "p i3 m1 i3", npb: 4 },

  // ---- Tremolo ----
  { id: "trem-pami", family: "tremolo", name: "Tremolo p-a-m-i", steps: "p a1 m1 i1", npb: 4 },
  { id: "trem-pimi", family: "tremolo", name: "p-i-m-i on one string", steps: "p i1 m1 i1", npb: 4 },
];

export const FINGERS = ["p", "i", "m", "a"];

/* Step notation, shared with Pimapeggio. A step is notes joined with "+", or
   "-" for a rest (the strings ring on). A note:
     finger [string] [@fret] [technique target] [x]
     p i m a        the finger; p alone is the bass string, pB / pA bass / alternate bass
     1-6            an exact string (i4)
     @n             fret n instead of the shape's (m2@3)
     h5 o3 /7 \5    hammer-on, pull-off, slide up, slide down to that fret; the
                    second note sounds halfway through the step
     x              muted or percussive (px: a thumb slap)
   A parsed note is { f, s } plus fret, tech: { type: "h"|"o"|"/"|"\\", to } and
   mute when present; a rest is an empty step []. */
const NOTE_RE = /^([pima])([1-6]|B|A)?(?:@(\d{1,2}))?(?:([ho/\\])(\d{1,2}))?(x)?$/;

export function parseNote(tok) {
  const m = tok.match(NOTE_RE);
  if (!m) throw new Error("Bad pattern token: " + tok);
  const n = { f: m[1], s: m[2] ? (/\d/.test(m[2]) ? +m[2] : m[2]) : null };
  if (m[3] !== undefined) n.fret = +m[3];
  if (m[4]) n.tech = { type: m[4], to: +m[5] };
  if (m[6]) n.mute = true;
  return n;
}

export function parseSteps(str) {
  return str.trim().split(/\s+/).map((step) => (step === "-" ? [] : step.split("+").map(parseNote)));
}

// Back to text: the inverse of parseSteps.
export function noteText(n) {
  return n.f + (n.s === null || n.s === undefined ? "" : n.s) + (n.fret !== undefined ? "@" + n.fret : "") +
    (n.tech ? n.tech.type + n.tech.to : "") + (n.mute ? "x" : "");
}
export function stepsText(steps) {
  return steps.map((st) => (st.length ? st.map(noteText).join("+") : "-")).join(" ");
}

// Frets, techniques or mutes taken from a recording: a transcription, which
// stays on the device (plan §7, Guitar part).
export function isTranscribed(str) {
  return /@|[pima1-6AB][ho/\\]\d|\\/.test(String(str));
}

// Default display name: finger letters joined with dashes, chords in brackets.
export function defaultName(steps) {
  return steps.map((st) => (!st.length ? "·" : st.length > 1 ? "(" + st.map((n) => n.f).join("+") + ")" : st[0].f)).join("-");
}

export const PATTERNS = PATTERN_DEFS.map((d) => {
  const steps = parseSteps(d.steps);
  return { ...d, steps, name: d.name || defaultName(steps), letters: defaultName(steps), bar: d.bar || 4 };
});

export const PATTERN_BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));

/* ================= Chords =================
   frets: string 6 -> 1; null = not played. ext marks strings that are not
   part of the usual shape but give the thumb a chord tone (e.g. G on the
   6th string for C), so crossing patterns always have a note to play. */

export const CHORDS = [
  { id: "C",  frets: [3, 3, 2, 0, 1, 0], ext: [6],    bass: 5, alt: 4 },
  { id: "Am", frets: [0, 0, 2, 2, 1, 0], ext: [6],    bass: 5, alt: 4 },
  { id: "G",  frets: [3, 2, 0, 0, 0, 3], ext: [],     bass: 6, alt: 4 },
  { id: "G7", frets: [3, 2, 0, 0, 0, 1], ext: [],     bass: 6, alt: 4 },
  { id: "E",  frets: [0, 2, 2, 1, 0, 0], ext: [],     bass: 6, alt: 4 },
  { id: "Em", frets: [0, 2, 2, 0, 0, 0], ext: [],     bass: 6, alt: 4 },
  { id: "Dm", frets: [1, 0, 0, 2, 3, 1], ext: [6, 5], bass: 4, alt: 5 },
  { id: "D",  frets: [2, 0, 0, 2, 3, 2], ext: [6, 5], bass: 4, alt: 5 },
  { id: "A",  frets: [0, 0, 2, 2, 2, 0], ext: [6],    bass: 5, alt: 4 },
];

export const CHORD_BY_ID = new Map(CHORDS.map((c) => [c.id, c]));

// Open-string MIDI notes, indexed by string number (1 = high E): standard tuning.
export const OPEN_MIDI = [null, 64, 59, 55, 50, 45, 40];

export function chordFret(chord, string) {
  return chord.frets[6 - string];
}

// Sounding MIDI note on a string (capo = semitones). A string the voicing
// doesn't use falls back to the bass note, so crossing patterns still sound
// a chord tone. open: the tuning's open strings, indexed like OPEN_MIDI.
export function chordMidi(chord, string, capo = 0, open = OPEN_MIDI) {
  if (chordFret(chord, string) === null) string = chord.bass;
  return open[string] + chordFret(chord, string) + capo;
}

// A note of a step as played: its string, the fret (the note's own @fret, or
// the shape's), and the MIDI note, plus the technique's second note if any.
// -> { string, fret, midi, to: { fret, midi, type } | null, mute }
export function noteSound(note, chord, home, capo = 0, open = OPEN_MIDI) {
  let string = noteString(note, chord, home);
  let fret = note.fret ?? chordFret(chord, string);
  if (fret === null || fret === undefined) { string = chord.bass; fret = chordFret(chord, string) ?? 0; }
  const midi = open[string] + fret + capo;
  const to = note.tech ? { type: note.tech.type, fret: note.tech.to, midi: open[string] + note.tech.to + capo } : null;
  return { string, fret, midi, to, mute: !!note.mute };
}

/* ---- More shapes, used by progressions (not in the chord buttons) ----
   Written low string to high, "x" for strings not played, e.g. G/B = x20033.
   suggestions.json can override or add voicings per progression. */

export const EXTRA_VOICINGS = {
  "G/B": "x20033",
  "Am7": "x02010",
  "Cmaj7": "x32000",
  "Cadd9": "x32030",
  "Asus2": "x02200",
  "Asus4": "x02230",
  "F": "133211",
  "E7": "020100",
  "A7": "x02020",
  "B7": "x21202",
  "D7": "xx0212",
  "Em7": "022030",
  "Fmaj7": "xx3210",
};

export function parseVoicing(id, spec) {
  const parts = /[-,\s]/.test(spec.trim()) ? spec.trim().split(/[-,\s]+/) : spec.trim().split("");
  if (parts.length !== 6) throw new Error("Voicing needs 6 strings: " + id + " " + spec);
  const frets = parts.map((p) => (/^[xX]$/.test(p) ? null : +p));
  if (frets.some((f) => f !== null && !(f >= 0 && f <= 20))) throw new Error("Bad voicing: " + id + " " + spec);
  let bass = 6;
  while (bass > 1 && frets[6 - bass] === null) bass--;
  const alt = bass >= 5 ? 4 : 3;
  const ext = [6, 5, 4, 3, 2, 1].filter((s) => frets[6 - s] === null);
  return { id, frets, ext, bass, alt };
}

const voicingCache = new Map();

// A chord by name; voicings (optional) override the built-in shapes.
export function resolveChord(name, voicings) {
  const spec = voicings && voicings[name];
  if (!spec && CHORD_BY_ID.has(name)) return CHORD_BY_ID.get(name);
  const s = spec || EXTRA_VOICINGS[name];
  if (!s) return null;
  const key = name + "@" + s;
  if (!voicingCache.has(key)) voicingCache.set(key, parseVoicing(name, s));
  return voicingCache.get(key);
}

// "C | G/B | Am7 G/B" -> bars of chords (two chords in a bar split it evenly).
export function parseProgression(str, voicings) {
  return str.split("|").map((bar) => bar.trim()).filter(Boolean).map((bar) =>
    bar.split(/\s+/).map((name) => {
      const c = resolveChord(name, voicings);
      if (!c) throw new Error("Unknown chord " + name + " (add it under voicings)");
      return c;
    })
  );
}

// General-purpose progressions to try any pattern over.
export const BUILTIN_PROGRESSIONS = [
  { id: "c-am-dm-g7",  chords: "C | Am | Dm | G7" },
  { id: "am-dm-e-am",  chords: "Am | Dm | E | Am" },
  { id: "g-em-c-d",    chords: "G | Em | C | D" },
  { id: "em-am-b7-em", chords: "Em | Am | B7 | Em" },
  { id: "c-g7",        chords: "C | G7" },
];

// Resolve a pattern note to a string number for a chord and finger mapping.
export function noteString(note, chord, home) {
  if (typeof note.s === "number") return note.s;
  if (note.f === "p") return note.s === "A" ? chord.alt : chord.bass;
  return home[note.f];
}
