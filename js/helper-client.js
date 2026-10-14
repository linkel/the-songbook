// The PC helper (helper/songbook_helper.py): it downloads a link's audio with
// yt-dlp over the home connection, and the phone reaches it over Tailscale.
// Same endpoints as speedy-pitcher's yt_helper.py: GET /ping and
// GET /audio?url=<link>. Its address is kept on this device.

const KEY = "songbook-helper-url";

export function helperUrl() {
  try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; }
}

export function setHelperUrl(url) {
  try { localStorage.setItem(KEY, String(url || "").trim()); } catch (e) { /* blocked */ }
}

const base = (url) => String(url || helperUrl()).trim().replace(/\/+$/, "");

// -> { ok, yt_dlp } or throws with a readable message.
export async function pingHelper(url) {
  const b = base(url);
  if (!b) throw new Error("Enter the helper's address first.");
  let r;
  try {
    r = await fetch(b + "/ping", { cache: "no-store" });
  } catch (e) {
    throw new Error("Couldn't reach the helper. Is it running, and is the address right? (On the phone it needs the https://…ts.net address from tailscale serve.)");
  }
  if (!r.ok) throw new Error("The helper answered with error " + r.status + ".");
  return r.json();
}

// Download a link's audio. onProgress(fraction or null). -> { blob, title, duration, sourceId }.
export async function downloadAudio(link, onProgress) {
  const b = base();
  if (!b) throw new Error("Set up the PC helper in Settings first.");
  let r;
  try {
    r = await fetch(b + "/audio?url=" + encodeURIComponent(link));
  } catch (e) {
    throw new Error("Couldn't reach the helper. Is it running, and is the address in Settings right?");
  }
  if (!r.ok) {
    let msg = "Helper error " + r.status;
    try { msg = (await r.json()).error || msg; } catch (e) { /* not JSON */ }
    throw new Error(msg);
  }
  const total = +r.headers.get("Content-Length") || 0;
  let blob;
  if (r.body && r.body.getReader && onProgress) {
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress(total ? got / total : null);
    }
    blob = new Blob(parts, { type: r.headers.get("Content-Type") || "audio/mp4" });
  } else {
    blob = await r.blob();
  }
  const dec = (h) => { try { return decodeURIComponent(r.headers.get(h) || ""); } catch (e) { return r.headers.get(h) || ""; } };
  return { blob, title: dec("X-Title"), duration: +r.headers.get("X-Duration") || null, sourceId: dec("X-Source-Id") };
}
