// Copied from Pimapeggio (../pimapeggio/notation.js, same author) and converted to an
// ES module.
import { noteString, chordMidi } from "./patterns.js";

// Finger colours come from CSS tokens (--f-p etc.), as in Pimapeggio.
export const FINGER_COLORS = { p: "var(--f-p)", i: "var(--f-i)", m: "var(--f-m)", a: "var(--f-a)" };

/* ================= Tiny staff-notation renderer =================
   Draws one figure (pattern steps) on a treble staff in guitar notation
   (written an octave above sounding pitch), with right-hand fingering
   letters above. Beams group notes by beat; tuplets get a number. */

// Pitch class -> [letter index (C=0 .. B=6), accidental]
const SPELL = [[0, ""], [0, "♯"], [1, ""], [2, "♭"], [2, ""], [3, ""], [3, "♯"], [4, ""], [4, "♯"], [5, ""], [6, "♭"], [6, ""]];

const NT = {
  half: 4,          // half a staff space, px
  colW: 22,         // width per step
  beatGap: 7,       // extra space between beats
  clefW: 34,
  stem: 26,
  bottomLine: 30,   // diatonic number of E4, the bottom line
};

function diatonic(midiWritten) {
  const [letter, acc] = SPELL[midiWritten % 12];
  return { d: (Math.floor(midiWritten / 12) - 1) * 7 + letter, acc };
}

// steps: parsed pattern steps; chord/home as in patterns.js; npb: notes per beat.
export function notationSvg(steps, chord, home, npb) {
  // Fill whole beats so beams come out right.
  let figure = steps;
  while (figure.length % npb !== 0) figure = figure.concat(steps);

  const H = NT.half;
  const yOf = (d) => 100 - (d - NT.bottomLine) * H; // bottom line at y=100
  const cols = figure.map((st, i) => {
    const beat = Math.floor(i / npb);
    const x = NT.clefW + 10 + i * NT.colW + beat * NT.beatGap;
    const notes = st.map((n) => {
      const s = noteString(n, chord, home);
      const { d, acc } = diatonic(chordMidi(chord, s) + 12);
      return { f: n.f, d, acc, y: yOf(d) };
    }).sort((a, b) => b.d - a.d); // highest first
    return { x, notes, beat };
  });

  let body = "";
  // Room for the clef's top loop and its tail with the small 8.
  let minY = yOf(38) - 20, maxY = yOf(30) + 18;
  const track = (y) => { minY = Math.min(minY, y); maxY = Math.max(maxY, y); };

  // Noteheads, accidentals, ledger lines
  for (const c of cols) {
    for (const n of c.notes) {
      for (let d = 28; d >= n.d; d -= 2) body += ledger(c.x, yOf(d));
      for (let d = 40; d <= n.d; d += 2) body += ledger(c.x, yOf(d));
      body += "<ellipse cx='" + c.x + "' cy='" + n.y + "' rx='4.7' ry='3.4' transform='rotate(-20 " + c.x + " " + n.y + ")' class='nt-head'/>";
      if (n.acc) body += "<text x='" + (c.x - 12) + "' y='" + (n.y + 4) + "' class='nt-acc'>" + n.acc + "</text>";
      track(n.y);
    }
  }

  // Stems and beams, one group per beat
  const beats = [];
  cols.forEach((c) => { (beats[c.beat] = beats[c.beat] || []).push(c); });
  const beamCount = npb >= 4 ? 2 : npb >= 2 ? 1 : 0;
  for (const g of beats) {
    const all = g.flatMap((c) => c.notes);
    const avg = all.reduce((s, n) => s + n.d, 0) / all.length;
    const up = avg < 34; // below the middle line: stems up
    const sx = (c) => c.x + (up ? 4.3 : -4.3);
    if (beamCount === 0) {
      for (const c of g) {
        const lo = c.notes[c.notes.length - 1].y, hi = c.notes[0].y;
        const y1 = up ? lo : hi, y2 = up ? hi - NT.stem : lo + NT.stem;
        body += line(sx(c), y1, sx(c), y2, "nt-stem");
        track(y2);
      }
      continue;
    }
    // Flat beam beyond the most extreme note in the group
    const beamY = up ? Math.min(...all.map((n) => n.y)) - NT.stem : Math.max(...all.map((n) => n.y)) + NT.stem;
    for (const c of g) {
      const anchor = up ? c.notes[c.notes.length - 1].y : c.notes[0].y;
      body += line(sx(c), anchor, sx(c), beamY, "nt-stem");
    }
    const x1 = sx(g[0]), x2 = sx(g[g.length - 1]);
    for (let b = 0; b < beamCount; b++) {
      const y = beamY + (up ? b * 5 : -b * 5);
      const x2b = g.length > 1 ? x2 : x1 + 8; // lone note: a short stub reads as a flag
      body += "<rect x='" + Math.min(x1, x2b) + "' y='" + (up ? y : y - 3.4) + "' width='" + Math.abs(x2b - x1 + (g.length > 1 ? 0.8 : 0)) + "' height='3.4' class='nt-beam'/>";
    }
    track(beamY);
    if (npb === 3 || npb === 6) {
      const ty = up ? beamY - 5 : beamY + 13;
      body += "<text x='" + ((x1 + x2) / 2) + "' y='" + ty + "' class='nt-tuplet'>" + npb + "</text>";
      track(up ? ty - 9 : ty);
    }
  }

  // Fingering letters above everything, stacked for notes played together
  const maxNotes = Math.max(...cols.map((c) => c.notes.length));
  const lettersBottom = minY - 5;
  for (const c of cols) {
    c.notes.forEach((n, k) => {
      const y = lettersBottom - (c.notes.length - 1 - k) * 10;
      body += "<text x='" + c.x + "' y='" + y + "' class='nt-finger' fill='" + FINGER_COLORS[n.f] + "'>" + n.f + "</text>";
    });
  }
  const top = lettersBottom - maxNotes * 10 - 2;
  const bottom = maxY + 6;
  const width = cols[cols.length - 1].x + 16;

  // Staff, clef, and the small 8 that marks guitar's octave transposition
  let staff = "";
  for (let d = 30; d <= 38; d += 2) staff += line(0, yOf(d), width, yOf(d), "nt-line");
  staff += line(0.5, yOf(38), 0.5, yOf(30), "nt-line");
  staff += TREBLE_CLEF;

  const h = bottom - top;
  return "<svg class='notation' viewBox='0 " + top + " " + width + " " + h + "' style='width:" +
    Math.round(width * 1.05) + "px' role='img' aria-label='Notation preview'>" + staff + body + "</svg>";
}

// Treble clef drawn as a path (font glyphs for it vary too much between
// devices), placed for a staff whose lines sit at y = 68..100, with the
// small 8 below for guitar.
const TREBLE_CLEF =
  "<path class='nt-clef' d='M 12.5 106 C 13 110 8 111.5 6.5 108.5 " +
  "M 12.5 106 L 11.6 70 C 11 62 13 54 17 51 C 19.5 49.5 20.5 53 19 57.5 C 17 63 9 70 6 77 " +
  "C 2.5 84 4 94 12 94.5 C 18 95 20 90 18.5 86.5 C 17 83 12.5 82.5 10.5 85.5 C 9 88 10.5 90.5 12.5 90.5'/>" +
  "<circle cx='7.6' cy='108' r='2.1' class='nt-head'/>" +
  "<text x='9.4' y='117' class='nt-eight'>8</text>";

function line(x1, y1, x2, y2, cls) {
  return "<line x1='" + x1 + "' y1='" + y1 + "' x2='" + x2 + "' y2='" + y2 + "' class='" + cls + "'/>";
}

function ledger(x, y) {
  return line(x - 8, y, x + 8, y, "nt-line");
}
