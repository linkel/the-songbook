// Small shared UI helpers: escaping, toasts, provenance labels.

import { PATTERN_BY_ID } from "./patterns.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
export function toast(text, ms = 2500) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}
export function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById("toast").classList.add("hidden");
}

// Where a chart's chords came from. Every chart is one of these, or has no
// chords yet.
export const SOURCE_LABEL = {
  verified: ["Verified", "verified"],
  mine: ["Mine", "mine"],
  web: ["Web · cited", "web"],
  detected: ["Detected · check", "detected"],
};

export function sourceBadge(chartOrEntry) {
  const hasChords = chartOrEntry.hasChords ?? (chartOrEntry.sections || []).some((s) => s.chords);
  if (!hasChords || !chartOrEntry.source) return "<span class='badge need'>Needs audio</span>";
  const [text, cls] = SOURCE_LABEL[chartOrEntry.source] || [chartOrEntry.source, "need"];
  return `<span class='badge ${cls}'>${esc(text)}</span>`;
}

export function sourceSentence(chart) {
  const conf = chart.confidence ? `, ${chart.confidence} confidence` : "";
  switch (chart.source) {
    case "web": return `From cited chord charts${conf}. Sources below.`;
    case "detected": return `Detected by ${chart.detector || "an analyser"}${conf}. Check by ear.`;
    case "mine": return "Entered or confirmed by you.";
    case "verified": return "Verified: two sources agree, or you confirmed it by ear.";
    default: return "No chords yet.";
  }
}

// A picking pattern is sourced, described by the owner, or a suggestion.
export function pickingLabel(picking) {
  if (!picking) return null;
  const text = picking.source === "mine" ? "your description"
    : picking.source === "web" ? "sourced"
    : "suggested · verify by ear";
  return { text, cls: "pick" };
}

export function patternName(id) {
  const p = PATTERN_BY_ID.get(id);
  return p ? p.name : id;
}

// A stable accent for a song's art square.
const ACCENTS = ["peach", "blue", "green", "pink", "lavender", "mauve", "teal", "sky", "yellow"];
export function artAccent(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return "var(--" + ACCENTS[h % ACCENTS.length] + ")";
}

export function initial(title) {
  const t = String(title || "?").replace(/^(the|a|an)\s+/i, "");
  return (t.match(/[\p{L}\p{N}]/u) || ["?"])[0].toUpperCase();
}

export const ICONS = {
  back: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='m15 18-6-6 6-6'/></svg>",
  search: "<svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linecap='round' aria-hidden='true'><circle cx='11' cy='11' r='7'/><path d='m20 20-3.5-3.5'/></svg>",
};

/* ---- Bottom-sheet popovers (one at a time) ---- */

let pop = null;
let popOnClose = null;

export function closePopover() {
  if (pop) {
    pop.remove();
    pop = null;
    const fn = popOnClose;
    popOnClose = null;
    if (fn) fn();
  }
}

export function popoverOpen() { return !!pop; }

// html goes inside the sheet; [data-close] buttons close it.
export function showPopover(html, label, onClose = null) {
  closePopover();
  pop = document.createElement("div");
  pop.className = "popover-scrim";
  pop.innerHTML = `<div class='popover' role='dialog' aria-modal='true' aria-label='${esc(label)}'>${html}</div>`;
  pop.addEventListener("click", (e) => { if (e.target === pop) closePopover(); });
  document.body.appendChild(pop);
  pop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closePopover));
  popOnClose = onClose;
  return pop;
}

/* ---- Toggles slide ----
   A switch or a segmented control is usually drawn again with its new state,
   so its CSS transition has nothing to run from. A click notes where it was;
   once the new one is up, it slides from there. */

const reduceMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

// How to find the same control after the view is drawn again.
function toggleKey(el) {
  if (el.id) return "#" + CSS.escape(el.id);
  const attr = [...el.attributes].find((a) => a.name.startsWith("data-") || a.name === "aria-label");
  return attr ? `[${attr.name}="${CSS.escape(attr.value)}"]` : null;
}

// The control now on screen: the same element, else the nearest one with the same key.
function findAgain(el, sel, near) {
  if (el.isConnected) return el;
  let best = null, bestD = Infinity;
  for (const x of document.querySelectorAll(sel)) {
    const r = x.getBoundingClientRect();
    if (!r.width) continue;
    const d = Math.abs(r.left - near.left) + Math.abs(r.top - near.top);
    if (d < bestD) { best = x; bestD = d; }
  }
  return best;
}

// Check over the next few frames (a mode change draws the view a little later).
function watch(test, frames = 24) {
  const step = () => { if (!test() && --frames > 0) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

function slideSwitch(sw) {
  const key = toggleKey(sw);
  if (!key) return;
  const was = sw.classList.contains("on"), at = sw.getBoundingClientRect();
  watch(() => {
    const now = findAgain(sw, ".switch" + key, at);
    if (!now || now.classList.contains("on") === was) return false;
    // Flipped in place: its own transition runs.
    if (now === sw) return true;
    now.classList.add(was ? "was-on" : "was-off");
    getComputedStyle(now, "::after").transform;
    requestAnimationFrame(() => now.classList.remove("was-on", "was-off"));
    return true;
  });
}

function slideSeg(seg) {
  const from = seg.querySelector(":scope > button.on");
  const key = toggleKey(seg);
  if (!from || !key) return;
  const box = seg.getBoundingClientRect(), r0 = from.getBoundingClientRect();
  const old = { left: r0.left - box.left, top: r0.top - box.top, width: r0.width, height: r0.height, label: from.textContent };
  watch(() => {
    const g = findAgain(seg, ".seg" + key, box);
    const to = g && g.querySelector(":scope > button.on");
    if (!to) return false;
    const b = g.getBoundingClientRect(), r = to.getBoundingClientRect();
    const now = { left: r.left - b.left, top: r.top - b.top, width: r.width, height: r.height };
    if (Math.abs(now.left - old.left) < 1 && Math.abs(now.top - old.top) < 1) return g !== seg || to.textContent !== old.label;
    const glide = document.createElement("span");
    glide.className = "seg-glide";
    g.prepend(glide);
    g.classList.add("gliding");
    const px = (o) => ({ left: o.left + "px", top: o.top + "px", width: o.width + "px", height: o.height + "px" });
    const anim = glide.animate([px(old), px(now)], { duration: 220, easing: "cubic-bezier(.3,.7,.4,1)", fill: "forwards" });
    const done = () => { glide.remove(); g.classList.remove("gliding"); };
    anim.onfinish = done;
    anim.oncancel = done;
    return true;
  });
}

if (typeof document !== "undefined") document.addEventListener("click", (e) => {
  if (reduceMotion() || !e.target.closest) return;
  const sw = e.target.closest(".switch");
  if (sw) { slideSwitch(sw); return; }
  const b = e.target.closest(".seg > button");
  if (b && !b.disabled && !b.classList.contains("on")) slideSeg(b.parentElement);
}, true);
