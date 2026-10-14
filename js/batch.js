// Analyse many recordings (#/analyse): pick files, match each to a song in
// your library by its tags (or file name), confirm the uncertain ones, then
// analyse them one at a time. Each result is a detected chart, and each file
// is kept as that song's recording.

import { esc, toast, ICONS } from "./ui.js";
import { loadLibrary, songKey, normTitle, addManualSong, saveChart, get, shippedChart } from "./library.js";
import { readTags } from "./tags.js";
import { saveRecording, fmtBytes } from "./recordings.js";
import { analyseFile, chartFromRaw, keepShippedFacts } from "./review.js";
import { invalidateSongs } from "./songs.js";

// rows: [{ file, tags, match: { id, sure } | null, choice: id | "new" | "skip", status, p, error, done }]
let rows = [];
let running = false;

export function batchState() { return { running, rows: rows.map((r) => ({ name: r.file.name, choice: r.choice, sure: r.match && r.match.sure, status: r.status })) }; }

async function matchFile(file, lib) {
  const tags = await readTags(file);
  const key = songKey(tags.title, tags.artist);
  const exact = [...lib.entries.values()].filter((e) => songKey(e.title, e.artist) === key);
  if (exact.length) return { tags, match: { id: exact[0].id, sure: true }, candidates: exact };
  const nt = normTitle(tags.title);
  const sameTitle = nt ? [...lib.entries.values()].filter((e) => normTitle(e.title) === nt) : [];
  return { tags, match: sameTitle.length ? { id: sameTitle[0].id, sure: false } : null, candidates: sameTitle.slice(0, 12) };
}

export async function renderBatch(view) {
  const lib = await loadLibrary();
  const name = (id) => { const e = lib.entries.get(id); return e ? `${e.title} · ${e.artist}` : id; };
  const ready = rows.filter((r) => r.choice !== "skip" && !r.done).length;
  view.innerHTML = `
    <div class='topbar'>
      <a class='back' href='#/settings' aria-label='Back to settings'>${ICONS.back}</a>
      <div class='topbar-title'><div class='t'>Analyse many recordings</div><div class='meta'>One at a time, on this device</div></div>
    </div>
    <div class='song-body'><div class='song-scroll' id='batch-scroll'><div class='song-main-col'>
      <label class='drop' for='batch-files'><span class='icon'><svg width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' aria-hidden='true'><path d='M12 16V4M6 10l6-6 6 6M4 20h16'/></svg></span>
        <span><b>Choose recordings</b><span class='meta' style='display:block'>Each is matched to a song by its tags. Nothing is uploaded.</span></span>
        <input type='file' id='batch-files' multiple accept='audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg' class='sr-only' ${running ? "disabled" : ""}></label>
      ${rows.length ? `<div class='card list' id='batch-rows'>${rows.map((r, i) => rowHtml(r, i, name)).join("")}</div>` : ""}
      ${rows.some((r) => r.match && !r.match.sure) ? "<p class='note'>Matches marked “check” only agree on the title: make sure they're the right song.</p>" : ""}
    </div></div></div>
    <div class='transport always'>
      <button class='btn outline' data-act='clear' ${rows.length && !running ? "" : "disabled"}>Clear</button>
      <button class='btn primary' data-act='start' style='flex:1' ${ready && !running ? "" : "disabled"}>${running ? "Analysing…" : `Analyse ${ready || ""}`.trim()}</button>
    </div>`;
  view.querySelector("#batch-files").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    for (const f of files) {
      const m = await matchFile(f, lib);
      rows.push({ file: f, ...m, choice: m.match ? m.match.id : "new", status: "waiting", p: 0 });
    }
    renderBatch(view);
  });
  view.querySelectorAll("select[data-row]").forEach((s) => s.addEventListener("change", () => { rows[+s.dataset.row].choice = s.value; renderBatch(view); }));
  view.querySelector("[data-act=clear]").addEventListener("click", () => { rows = []; renderBatch(view); });
  view.querySelector("[data-act=start]").addEventListener("click", () => start(view));
}

function rowHtml(r, i, name) {
  const t = r.tags;
  const status = r.status === "done" ? `<a href='#/song/${encodeURIComponent(r.doneId)}/analyse'>Done ✓ review</a>`
    : r.status === "error" ? `<span class='err'>${esc(r.error)}</span>`
    : r.status === "running" ? `${Math.round(r.p * 100)}%` : r.choice === "skip" ? "Skipped" : "Waiting";
  const opts = [];
  for (const c of r.candidates || []) opts.push(`<option value='${esc(c.id)}' ${r.choice === c.id ? "selected" : ""}>${esc(name(c.id))}${r.match && r.match.id === c.id && !r.match.sure ? " (check)" : ""}</option>`);
  opts.push(`<option value='new' ${r.choice === "new" ? "selected" : ""}>Add as a new song: ${esc(t.title || r.file.name)}</option>`);
  opts.push(`<option value='skip' ${r.choice === "skip" ? "selected" : ""}>Skip this file</option>`);
  return `<div class='row batch-row'>
    <div class='row-main'>
      <div class='title'>${esc(t.title || r.file.name)}</div>
      <div class='meta'>${esc(t.artist || "artist unknown")} · ${fmtBytes(r.file.size)} · from ${esc(t.from)}</div>
      <label class='field' style='margin-top:8px'><span class='sr-only'>Song for ${esc(r.file.name)}</span>
        <select data-row='${i}' ${running || r.done ? "disabled" : ""}>${opts.join("")}</select></label>
      <div class='facts'>${r.match ? `<span class='badge ${r.match.sure ? "verified" : "detected"}'>${r.match.sure ? "matched" : "check"}</span>` : "<span class='badge need'>no match</span>"}
        <span class='fact batch-status'>${status}</span></div>
    </div></div>`;
}

async function start(view) {
  running = true;
  renderBatch(view);
  for (const r of rows) {
    if (r.choice === "skip" || r.done) continue;
    r.status = "running";
    r.p = 0;
    renderBatch(view);
    try {
      const id = r.choice === "new" ? await addManualSong(r.tags.title || r.file.name.replace(/\.[^.]+$/, ""), r.tags.artist || "") : r.choice;
      const lib = await loadLibrary();
      const e = lib.entries.get(id);
      await saveRecording(id, r.file);
      const { raw } = await analyseFile(r.file, (step, p) => {
        const w = { decode: [0, 0.1], load: [0.1, 0.15], tempo: [0.15, 0.4], key: [0.4, 0.5], chords: [0.5, 1] }[step] || [0, 1];
        r.p = w[0] + (w[1] - w[0]) * p;
        const el = view.querySelectorAll(".batch-status")[rows.indexOf(r)];
        if (el) el.textContent = Math.round(r.p * 100) + "%";
      });
      const existing = await get("charts", id).catch(() => null);
      if (existing && existing.source === "mine") {
        r.note = "kept your checked chart";
      } else {
        const chart = chartFromRaw(raw, { id, title: e ? e.title : r.tags.title, artist: e ? e.artist : r.tags.artist, file: r.file.name });
        keepShippedFacts(chart, await shippedChart(id).catch(() => null));
        await saveChart(chart);
      }
      r.status = "done";
      r.done = true;
      r.doneId = id;
    } catch (err) {
      r.status = "error";
      r.error = err.message;
    }
    renderBatch(view);
  }
  running = false;
  invalidateSongs();
  renderBatch(view);
  const n = rows.filter((r) => r.status === "done").length;
  toast(`${n} recording${n === 1 ? "" : "s"} analysed. Each chart is a draft: review it by ear.`, 3500);
}
