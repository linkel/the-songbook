// Drag and drop from the computer: a file dropped anywhere goes to the file
// picker on screen that takes it (a recording in Player or Analyse, a bundle
// or library export in Settings, songs for batch analysis), as if chosen with
// its button. With two that could take it, the one you drop it on wins. On a
// song with no picker showing, a recording opens in Player; a text file
// dropped on the sheet editor fills it. The browser never opens the file
// itself.

import { toast } from "./ui.js";

const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|mov)$/i;
const TEXT = /\.(txt|cho|chopro|chordpro|crd|pro)$/i;

// Does a file input's accept list take this file?
function takes(input, file) {
  const acc = (input.getAttribute("accept") || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!acc.length) return true;
  const name = file.name.toLowerCase(), type = (file.type || "").toLowerCase();
  return acc.some((a) => (a.startsWith(".") ? name.endsWith(a) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a));
}

const visible = (el) => !el.disabled && !el.closest(".hidden") && (el.closest("label, .set-row, .card") || el).getClientRects().length > 0;

function inputsFor(file) {
  const view = document.querySelector(".view:not(.hidden)") || document;
  const pop = document.querySelector(".popover");
  const scope = pop && pop.getClientRects().length ? pop : view;
  return [...scope.querySelectorAll("input[type=file]")].filter((i) => visible(i) && takes(i, file));
}

function give(input, files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

let overlay = null, depth = 0;
function showOverlay(on) {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "drop-overlay hidden";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = "<div>Drop to add it</div>";
    document.body.appendChild(overlay);
  }
  overlay.classList.toggle("hidden", !on);
}

const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");

// playerHash(): the open song's Player route, or null off a song.
export function initDrop({ playerHash }) {
  document.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; showOverlay(true); });
  document.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) showOverlay(false); });
  document.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  document.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    showOverlay(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const file = files[0];
    // A sheet as text, dropped while editing one.
    const editor = document.querySelector("#sheet-text");
    if (editor && visible(editor) && (TEXT.test(file.name) || (file.type || "").startsWith("text/"))) {
      editor.value = await file.text();
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      toast(`Read ${file.name} into the sheet.`);
      return;
    }
    let inputs = inputsFor(file);
    if (inputs.length > 1) {
      // The one under the drop.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const row = under && under.closest(".set-row, .card");
      const mine = row && inputs.filter((i) => row.contains(i));
      if (mine && mine.length) inputs = mine;
    }
    if (inputs.length) {
      const input = inputs[0];
      give(input, input.multiple ? files : [file]);
      return;
    }
    const hash = playerHash();
    if (hash && (AUDIO.test(file.name) || (file.type || "").startsWith("audio/"))) {
      // To the song's Player, then its file picker.
      location.hash = hash;
      for (let k = 0; k < 60; k++) {
        await new Promise((r) => setTimeout(r, 100));
        const inp = inputsFor(file)[0];
        if (inp) { give(inp, [file]); return; }
      }
      toast("Couldn't open the Player for that file; use Choose file there.", 4000);
      return;
    }
    toast(`Nothing here takes ${file.name}. Drop a recording on a song, or a bundle or library file in Settings.`, 4000);
  });
}
