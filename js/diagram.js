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

/* ---- A fret grid to tap your own shape on (plan Phase 5b: your own fingering) ----
   Six columns (strings, low to high), a row for open / not played, and five
   frets from `base`; ▲ ▼ move the window up and down the neck. */

const fpState = new WeakMap();

function fpInner(frets, base) {
  const top = frets.map((f, i) => `<button type='button' class='fp-top' data-s='${i}' aria-label='String ${6 - i}: ${f === null ? "not played" : f === 0 ? "open" : "fret " + f}, tap for ${f === null ? "open" : "not played"}'>${f === null ? "×" : f === 0 ? "○" : ""}</button>`).join("");
  let grid = "";
  for (let r = 0; r < 5; r++) {
    const fret = base + r;
    grid += `<span class='fp-num' aria-hidden='true'>${fret}</span>` + frets.map((f, i) =>
      `<button type='button' class='fp-cell${f === fret ? " on" : ""}' data-s='${i}' data-f='${fret}' aria-pressed='${f === fret}' aria-label='String ${6 - i}, fret ${fret}'></button>`).join("");
  }
  return `<div class='fp-row'><span class='fp-num'></span>${top}</div><div class='fp-grid'>${grid}</div>
    <div class='fp-nav'><button type='button' class='btn outline small' data-move='-1' ${base <= 1 ? "disabled" : ""} aria-label='Lower frets'>▲</button>
      <span class='meta'>frets ${base}–${base + 4}</span>
      <button type='button' class='btn outline small' data-move='1' ${base >= 15 ? "disabled" : ""} aria-label='Higher frets'>▼</button></div>`;
}

export function fretPickerHtml(frets, { name = "" } = {}) {
  const played = frets.filter((f) => f !== null && f > 0);
  const base = played.length && Math.max(...played) > 5 ? Math.min(...played) : 1;
  return `<div class='fret-picker' data-name='${String(name).replace(/'/g, "&#39;")}' data-frets='${JSON.stringify(frets)}' data-base='${base}' role='group' aria-label='Tap the frets of your shape'>${fpInner(frets, base)}</div>`;
}

// onChange(frets) after every tap.
export function wireFretPicker(el, onChange) {
  const st = { frets: JSON.parse(el.dataset.frets), base: +el.dataset.base };
  fpState.set(el, st);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !el.contains(b)) return;
    if (b.dataset.move) st.base = Math.max(1, Math.min(15, st.base + +b.dataset.move));
    else if (b.classList.contains("fp-top")) { const i = +b.dataset.s; st.frets[i] = st.frets[i] === null ? 0 : null; onChange(st.frets.slice()); }
    else if (b.classList.contains("fp-cell")) { const i = +b.dataset.s, f = +b.dataset.f; st.frets[i] = st.frets[i] === f ? 0 : f; onChange(st.frets.slice()); }
    el.innerHTML = fpInner(st.frets, st.base);
  });
}
