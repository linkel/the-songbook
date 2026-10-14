// The Songs tab: the library (your Spotify export, songs added by hand and
// the shipped charts), with search, a list picker, filter pills, status
// badges, and rows rendered in batches as you scroll.

import { loadLibrary, allSheets, deviceCharts, addManualSong } from "./library.js";
import { esc, sourceBadge, pickingLabel, patternName, artAccent, initial, ICONS, showPopover, closePopover, toast } from "./ui.js";

const FILTERS = [
  ["all", "All"],
  ["chords", "Has chords"],
  ["picked", "Fingerpicked"],
  ["need", "Needs audio"],
];
const BATCH = 60;

const state = { q: "", filter: "all", list: "" };
let ctx = null;       // { lib, sheets: Map, charts: Map }
let pending = [];     // items still to render
let observer = null;

// What we know about a song's chords: a chart of your own, a sheet, or a shipped chart.
function status(e) {
  const chart = ctx.charts.get(e.id);
  const sheet = ctx.sheets.get(e.id);
  const sh = e.shipped;
  if (chart) return { source: chart.source, hasChords: true, style: chart.style, sheet: !!sheet };
  if (sheet) return { source: sheet.source || "mine", hasChords: true, style: sh && sh.style, sheet: true };
  if (sh) return { source: sh.source, hasChords: sh.hasChords, style: sh.style, sheet: false };
  return { source: null, hasChords: false, style: null, sheet: false };
}

function matches(e) {
  const st = status(e);
  if (state.filter === "chords" && !st.hasChords) return false;
  if (state.filter === "picked" && st.style !== "fingerpicked") return false;
  if (state.filter === "need" && st.hasChords) return false;
  if (!state.q) return true;
  const hay = (e.title + " " + e.artist + " " + e.album).toLowerCase();
  return state.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function row(e) {
  const st = status(e);
  const facts = [sourceBadge(st)];
  if (st.sheet) facts.push("<span class='fact'>Sheet</span>");
  const sh = e.shipped;
  if (sh && sh.patterns && sh.patterns.length) {
    const lab = pickingLabel({ source: sh.pickingSource });
    facts.push(`<span class='badge pick' title='${esc(lab.text)}'>${esc(patternName(sh.patterns[0]))}</span>`);
  }
  if (sh && sh.capo) facts.push(`<span class='fact'>Capo ${sh.capo}</span>`);
  return `<a class='row' href='#/song/${encodeURIComponent(e.id)}' data-id='${esc(e.id)}'>
    <div class='art' style='--accent:${artAccent(e.title)}' aria-hidden='true'>${esc(initial(e.title))}</div>
    <div class='row-main'><div class='title'>${esc(e.title)}</div><div class='meta'>${esc(e.artist)}</div>
    <div class='facts'>${facts.join("")}</div></div></a>`;
}

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

// The items to show, as group headings and rows.
function items() {
  const { lib } = ctx;
  const out = [];
  if (state.list) {
    const list = lib.lists.find((l) => l.name === state.list);
    const rows = (list ? list.ids : []).map((id) => lib.entries.get(id)).filter(matches);
    if (rows.length) out.push({ h: state.list }, ...rows.map((e) => ({ e })));
    return out;
  }
  const all = [...lib.entries.values()].filter(matches);
  const charted = all.filter((e) => status(e).hasChords).sort(byTitle);
  const rest = all.filter((e) => !status(e).hasChords).sort(byTitle);
  if (charted.length) out.push({ h: "Charts and sheets" }, ...charted.map((e) => ({ e })));
  if (rest.length) out.push({ h: lib.meta ? "All songs" : "Shipped, no chords yet" }, ...rest.map((e) => ({ e })));
  return out;
}

export async function renderSongs(view, { refresh = false } = {}) {
  if (!view.dataset.built) {
    view.innerHTML = `<div class='view-inner'>
      <label class='search'>${ICONS.search}<span class='sr-only'>Search songs</span>
        <input id='song-search' type='search' autocomplete='off' placeholder='Search songs'></label>
      <div class='pills' role='group' aria-label='Filter'>
        <label class='pill select-pill'><span class='sr-only'>List</span><select id='song-list-pick'></select></label>
        ${FILTERS.map(([id, label]) => `<button class='pill' data-filter='${id}' aria-pressed='false'>${esc(label)}</button>`).join("")}
        <button class='pill' id='add-song'>+ Add song</button>
      </div>
      <div id='library-note'></div>
      <div id='song-groups'></div>
      <div id='song-sentinel' aria-hidden='true' style='height:1px'></div>
    </div>`;
    view.dataset.built = "1";
    const input = view.querySelector("#song-search");
    input.addEventListener("input", () => { state.q = input.value.trim(); fill(view); });
    view.querySelectorAll(".pill[data-filter]").forEach((b) => b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      fill(view);
    }));
    view.querySelector("#song-list-pick").addEventListener("change", (e) => {
      state.list = e.target.value;
      view.scrollTop = 0;
      fill(view);
    });
    view.querySelector("#add-song").addEventListener("click", openAddSong);
    observer = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) more(view); }, { root: view, rootMargin: "600px" });
    observer.observe(view.querySelector("#song-sentinel"));
  }
  if (refresh || !ctx) await loadCtx();
  await fill(view);
}

async function loadCtx() {
  const [lib, sheets, charts] = await Promise.all([loadLibrary(), allSheets(), deviceCharts()]);
  ctx = { lib, sheets: new Map(sheets.map((s) => [s.id, s])), charts: new Map(charts.map((c) => [c.id, c])) };
}

export function invalidateSongs() { ctx = null; }

async function fill(view) {
  if (!ctx) await loadCtx();
  const { lib } = ctx;
  view.querySelectorAll(".pill[data-filter]").forEach((b) => {
    const on = b.dataset.filter === state.filter;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
  });
  const pick = view.querySelector("#song-list-pick");
  if (state.list && !lib.lists.some((l) => l.name === state.list)) state.list = "";
  pick.innerHTML = `<option value=''>All songs (${lib.entries.size})</option>` +
    lib.lists.map((l) => `<option value='${esc(l.name)}'>${esc(l.name)} (${l.ids.length})</option>`).join("");
  pick.value = state.list;
  pick.parentElement.classList.toggle("on", !!state.list);
  view.querySelector("#song-search").placeholder = `Search ${lib.entries.size.toLocaleString()} songs`;

  view.querySelector("#library-note").innerHTML = lib.meta ? "" :
    `<div class='card empty'><b>Your library isn't here yet.</b><br>Import the file that <code>tools/spotify-import.mjs</code> saves (Settings → Import library file), or add songs by hand.
      <div style='display:flex;gap:8px;margin-top:12px;flex-wrap:wrap'><a class='btn outline small' href='#/settings'>Import library file</a></div></div>`;

  const groups = view.querySelector("#song-groups");
  groups.innerHTML = "";
  pending = items();
  if (!pending.length) groups.innerHTML = "<div class='card empty'>No songs match.</div>";
  more(view);
}

// Render the next batch of rows (and any headings among them).
function more(view) {
  const groups = view.querySelector("#song-groups");
  let card = groups.lastElementChild && groups.lastElementChild.classList.contains("list") ? groups.lastElementChild : null;
  let html = "";
  let n = 0;
  const flush = () => { if (card && html) { card.insertAdjacentHTML("beforeend", html); html = ""; } };
  while (pending.length && n < BATCH) {
    const it = pending.shift();
    if (it.h) {
      flush();
      groups.insertAdjacentHTML("beforeend", `<div class='h2'>${esc(it.h)}</div><div class='card list'></div>`);
      card = groups.lastElementChild;
    } else {
      html += row(it.e);
      n++;
    }
  }
  flush();
}

function openAddSong() {
  const p = showPopover(`<div class='popover-head'><span class='popover-name' style='font-size:20px'>Add a song</span></div>
    <form id='add-form' style='display:flex;flex-direction:column;gap:10px'>
      <label class='field'><span>Title</span><input name='title' required autocomplete='off'></label>
      <label class='field'><span>Artist</span><input name='artist' autocomplete='off'></label>
      <div style='display:flex;gap:8px'><button type='button' class='btn outline' style='flex:1' data-close>Cancel</button>
      <button class='btn primary' style='flex:1'>Add</button></div>
    </form>`, "Add a song");
  const form = p.querySelector("#add-form");
  form.elements.title.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const id = await addManualSong(form.elements.title.value, form.elements.artist.value);
      closePopover();
      ctx = null;
      location.hash = "#/song/" + encodeURIComponent(id);
    } catch (err) {
      toast(err.message);
    }
  });
}
