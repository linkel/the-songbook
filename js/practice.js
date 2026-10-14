// The Practice tab: the loops you've saved in the Player, across songs, with
// speed-trainer progress. Tap one to open the song's Player on that loop.

import { getAll, del } from "./library.js";
import { fmtTime } from "./trainer.js";
import { esc, toast, artAccent, initial } from "./ui.js";

export async function renderPractice(view) {
  const loops = await getAll("loops").catch(() => []);
  const bySong = new Map();
  for (const l of loops) {
    if (!bySong.has(l.songId)) bySong.set(l.songId, []);
    bySong.get(l.songId).push(l);
  }
  // Most recently practised (or saved) songs first.
  const recent = (ls) => Math.max(...ls.map((l) => (l.practice && l.practice.at) || l.createdAt || 0));
  const songs = [...bySong.entries()].sort((a, b) => recent(b[1]) - recent(a[1]));
  view.innerHTML = `<div class='view-inner'>
    <h1 class='page-title'>Practice</h1>
    ${songs.length ? songs.map(([id, ls]) => songCard(id, ls)).join("") : `<div class='card empty'><b>Nothing saved yet.</b><br>
      In a song's Player, set a loop (a section, a few bars, or A and B) and tap <b>+ Save loop</b>. Saved loops collect here, with how far the speed trainer got.</div>`}
    <p class='note' style='padding:0 2px'>Picking patterns to practise arrive with the Picking mode.</p>
  </div>`;
  view.querySelectorAll("[data-del-loop]").forEach((b) => b.addEventListener("click", async () => {
    if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Tap again"; return; }
    await del("loops", b.dataset.delLoop);
    toast("Loop deleted.");
    renderPractice(view);
  }));
}

function songCard(id, ls) {
  const first = ls[0];
  const title = first.title || id, artist = first.artist || "";
  ls.sort((a, b) => a.a - b.a);
  return `<div class='card practice-song'>
    <div class='ps-head'><span class='art' style='background:${artAccent(title)}' aria-hidden='true'>${esc(initial(title))}</span>
      <div style='min-width:0;flex:1'><div class='set-label ellipsis'>${esc(title)}</div><div class='meta ellipsis'>${esc(artist)}</div></div>
      <a class='btn outline small' href='#/song/${encodeURIComponent(id)}/player'>Player</a></div>
    ${ls.map((l) => {
      const p = l.practice;
      const prog = p ? `best ${Math.round(p.best * 100)}% · ${p.passes} loop${p.passes === 1 ? "" : "s"}` : "not practised yet";
      return `<div class='loop-row'>
        <a class='loop-link' href='#/song/${encodeURIComponent(id)}/player/${encodeURIComponent(l.id)}'>
          <span class='set-label ellipsis'>${esc(l.name)}</span>
          <span class='meta ellipsis'>${esc(l.bars || "")} · ${fmtTime(l.a, false)}–${fmtTime(l.b, false)} · ${prog}</span></a>
        <button class='btn outline small' data-del-loop='${esc(l.id)}' aria-label='Delete ${esc(l.name)}'>Delete</button></div>`;
    }).join("")}
  </div>`;
}
