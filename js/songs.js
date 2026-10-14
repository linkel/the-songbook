// The Songs tab: search, filter pills, and the song list.
// Phase 0 lists the shipped charts; the saved library joins it in Phase 1.

import { shippedSongs } from "./library.js";
import { esc, sourceBadge, pickingLabel, patternName, artAccent, initial, ICONS } from "./ui.js";

const FILTERS = [
  ["all", "All"],
  ["chords", "Has chords"],
  ["picked", "Fingerpicked"],
  ["need", "Needs audio"],
];

const state = { q: "", filter: "all" };

function matches(s) {
  if (state.filter === "chords" && !s.hasChords) return false;
  if (state.filter === "picked" && s.style !== "fingerpicked") return false;
  if (state.filter === "need" && s.hasChords) return false;
  if (!state.q) return true;
  const hay = (s.title + " " + s.artist).toLowerCase();
  return state.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function row(s) {
  const pick = s.patterns && s.patterns.length ? pickingLabel({ source: s.pickingSource }) : null;
  const facts = [sourceBadge(s)];
  if (pick) facts.push(`<span class='badge pick' title='${esc(pick.text)}'>${esc(patternName(s.patterns[0]))}</span>`);
  if (s.capo) facts.push(`<span class='fact'>Capo ${s.capo}</span>`);
  return `<a class='row' href='#/song/${encodeURIComponent(s.id)}' data-id='${esc(s.id)}'>
    <div class='art' style='--accent:${artAccent(s.title)}' aria-hidden='true'>${esc(initial(s.title))}</div>
    <div class='row-main'><div class='title'>${esc(s.title)}</div><div class='meta'>${esc(s.artist)}</div>
    <div class='facts'>${facts.join("")}</div></div></a>`;
}

export async function renderSongs(view) {
  if (!view.dataset.built) {
    view.innerHTML = `<div class='view-inner'>
      <label class='search'>${ICONS.search}<span class='sr-only'>Search songs</span>
        <input id='song-search' type='search' autocomplete='off' placeholder='Search songs'></label>
      <div class='pills' role='group' aria-label='Filter'>${FILTERS.map(([id, label]) =>
        `<button class='pill' data-filter='${id}' aria-pressed='false'>${esc(label)}</button>`).join("")}</div>
      <div class='h2'>Shipped charts</div>
      <div id='song-list' class='card list'></div>
      <p class='note' style='padding:0 2px'>Your saved library joins this list in the next update.</p>
    </div>`;
    view.dataset.built = "1";
    const input = view.querySelector("#song-search");
    input.addEventListener("input", () => { state.q = input.value.trim(); fill(view); });
    view.querySelectorAll(".pill").forEach((b) => b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      fill(view);
    }));
  }
  await fill(view);
}

async function fill(view) {
  view.querySelectorAll(".pill").forEach((b) => {
    const on = b.dataset.filter === state.filter;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
  });
  const list = view.querySelector("#song-list");
  let songs;
  try {
    songs = await shippedSongs();
  } catch (e) {
    list.innerHTML = `<div class='empty'>Couldn't load the song list (${esc(e.message)}).</div>`;
    return;
  }
  const shown = songs.filter(matches).sort((a, b) => a.title.localeCompare(b.title));
  list.innerHTML = shown.length ? shown.map(row).join("") : "<div class='empty'>No songs match.</div>";
  const input = view.querySelector("#song-search");
  input.placeholder = `Search ${songs.length} songs`;
}
