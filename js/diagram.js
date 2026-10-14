// Fretting-hand chord boxes as SVG strings (the mockup's chordBox, extended
// with barres and a fret number for shapes up the neck).
// frets: low E to high E, null for unplayed.

export function chordBoxSvg(frets, { width = 76, label = "" } = {}) {
  const scale = width / 76;
  const W = 76, H = 90, left = 14, top = 18, sg = 10.4, fg = 15;
  const played = frets.filter((f) => f !== null && f > 0);
  const maxF = played.length ? Math.max(...played) : 0;
  const minF = played.length ? Math.min(...played) : 0;
  // Show frets 1-4 when the shape fits there; otherwise start at its lowest fret.
  const base = maxF <= 4 ? 1 : minF;
  let s = `<svg width="${Math.round(W * scale)}" height="${Math.round(H * scale)}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label || "chord diagram"}">`;
  if (base === 1) s += `<rect x="${left}" y="${top - 2.5}" width="${sg * 5}" height="3" fill="var(--text)"/>`;
  else s += `<text x="${left - 4}" y="${top + fg * 0.5 + 3.5}" font-size="9.5" font-weight="700" text-anchor="end" fill="var(--meta)">${base}</text>`;
  for (let i = 0; i < 6; i++) s += `<line x1="${left + i * sg}" y1="${top}" x2="${left + i * sg}" y2="${top + fg * 4}" stroke="var(--overlay0)" stroke-width="1"/>`;
  for (let j = 1; j <= 4; j++) s += `<line x1="${left}" y1="${top + j * fg}" x2="${left + sg * 5}" y2="${top + j * fg}" stroke="var(--overlay0)" stroke-width="1"/>`;

  // A barre: the lowest fret, held on two or more strings with nothing lower
  // fretted between them.
  if (played.length >= 4) {
    const at = frets.map((f, i) => (f === minF ? i : -1)).filter((i) => i >= 0);
    if (at.length >= 2) {
      const a = at[0], b = at[at.length - 1];
      const inside = frets.slice(a, b + 1);
      if (inside.every((f) => f !== null && f >= minF) && minF > 0) {
        const y = top + (minF - base + 0.5) * fg;
        s += `<rect x="${left + a * sg - 4.6}" y="${y - 4.6}" width="${(b - a) * sg + 9.2}" height="9.2" rx="4.6" fill="var(--mauve)"/>`;
      }
    }
  }
  frets.forEach((v, i) => {
    const x = left + i * sg;
    if (v === null) s += `<text x="${x}" y="${top - 6}" font-size="9" text-anchor="middle" fill="var(--meta)">×</text>`;
    else if (v === 0) s += `<circle cx="${x}" cy="${top - 8}" r="3" fill="none" stroke="var(--meta)" stroke-width="1.2"/>`;
    else s += `<circle cx="${x}" cy="${top + (v - base + 0.5) * fg}" r="4.6" fill="var(--mauve)"/>`;
  });
  return s + "</svg>";
}
