// The sheet: chords over lyrics, Ultimate Guitar style. Each chord sits above
// the syllable it changes on. Lines are built from inline segments (a chord
// over its first word, then one segment per word) so they wrap cleanly on a
// narrow phone; segments inside one word are kept together.

import { parseChord, prettyChord } from "./chords.js";
import { esc } from "./ui.js";

// disp(name) -> the chord name to show (transposed, capo, simple).
export function sheetHtml(doc, disp) {
  let k = 0;
  const out = [];
  doc.sections.forEach((s, si) => {
    out.push(`<section class='sheet-sec' data-s='${si}'>`);
    if (s.name) out.push(`<span class='tag'>${esc(s.name.toUpperCase())}</span>`);
    if (!s.ref) {
      s.lines.forEach((line, li) => {
        if (line.type === "blank") out.push("<div class='gap'></div>");
        else if (line.type === "comment") out.push(`<div class='sheet-comment'>${esc(line.text)}</div>`);
        else if (line.type === "tab") out.push(`<pre class='tabline'>${esc(line.text)}</pre>`);
        else {
          const r = lineHtml(line, si, li, k, disp);
          k = r.k;
          out.push(r.html);
        }
      });
    }
    out.push("</section>");
  });
  return out.join("");
}

function lineHtml(line, si, li, k, disp) {
  // Split each segment's text into words; the chord goes over the first.
  const pieces = [];
  for (const seg of line.segs) {
    const words = seg.text ? seg.text.match(/\S+\s*|\s+/g) : [""];
    words.forEach((w, i) => pieces.push({ chord: i === 0 ? seg.chord : null, text: w }));
  }
  // Room for each chord: the characters of lyric before the next chord. When
  // the name fits in that room it overhangs to the right instead of pushing
  // the words apart.
  for (let i = 0; i < pieces.length; i++) {
    if (!pieces[i].chord) continue;
    let room = 0;
    for (let j = i; j < pieces.length && (j === i || !pieces[j].chord); j++) room += pieces[j].text.length;
    pieces[i].room = room;
  }
  const hasChord = pieces.some((p) => p.chord);
  const hasText = pieces.some((p) => p.text.trim());
  // A new group starts after a space: no wrapping inside a word.
  const groups = [];
  let g = [];
  for (const p of pieces) {
    g.push(p);
    if (/\s$/.test(p.text) || !p.text) { groups.push(g); g = []; }
  }
  if (g.length) groups.push(g);

  const cls = "line" + (!hasChord ? " lyrics-only" : !hasText ? " chords-only" : "");
  let html = `<div class='${cls}' data-s='${si}' data-l='${li}'>`;
  for (const grp of groups) {
    html += "<span class='grp'>";
    for (const p of grp) {
      let c = "";
      if (p.chord) {
        const parsed = parseChord(p.chord);
        if (parsed && !parsed.nc) {
          const d = disp(p.chord);
          const fits = p.text.length < p.room && d.length * 1.25 + 1 <= p.room;
          c = `<span class='c${fits ? " ov" : ""}' data-k='${k}' data-chord='${esc(d)}'><span>${esc(prettyChord(d))}</span></span>`;
          k++;
        } else {
          // Not a chord we know (or N.C.): shown as written, never transposed.
          c = `<span class='c odd'>${esc(p.chord)}</span>`;
        }
      } else if (hasChord) {
        c = "<span class='c'></span>";
      }
      html += `<span class='sw'>${c}<span class='w'>${p.text ? esc(p.text) : "&nbsp;"}</span></span>`;
    }
    html += "</span>";
  }
  return { html: html + "</div>", k };
}
