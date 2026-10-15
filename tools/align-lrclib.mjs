// Lines a song's LRCLIB lyrics up with its recording on the PC helper, so
// the phone can show them in time with the song you analysed (a live take, a
// clip) without the PC: the helper writes the times into the song's bundle
// (timing.json), and tools/ship-bundle.mjs ships them, times only, keyed to
// LRCLIB's lines. On the phone, Sheet → Find on LRCLIB gets the words and
// uses these times.
//   node tools/align-lrclib.mjs <song id> "<title>" "<artist>" [helper url] [--id <LRCLIB id>]
// (the helper running, with an analysis of the song in private/songs/).
import { parseLrc } from "../js/lyrics.js";

const [song, title, artist, helper = "http://127.0.0.1:8765"] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--id");
if (!song || !title) {
  console.log('Usage: node tools/align-lrclib.mjs <song id> "<title>" "<artist>" [helper url]');
  process.exit(1);
}
const UA = { "User-Agent": "the-songbook (personal songbook; github.com/linkel/the-songbook)" };
const q = new URLSearchParams({ track_name: title, artist_name: artist || "" });
// --id <n>: that LRCLIB record (there can be many versions of a song).
const idArg = process.argv.indexOf("--id");
let rec = await fetch(idArg > 0 ? `https://lrclib.net/api/get/${process.argv[idArg + 1]}` : "https://lrclib.net/api/get?" + q, { headers: UA })
  .then((r) => (r.ok ? r.json() : (console.log("LRCLIB said", r.status), null))).catch((e) => (console.log(e.message), null));
if (!rec || !rec.syncedLyrics) {
  const list = await fetch("https://lrclib.net/api/search?" + q, { headers: UA }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  rec = (list || []).find((x) => x.syncedLyrics) || null;
}
if (!rec) { console.log("LRCLIB has no synced lyrics for that."); process.exit(1); }
// LRCLIB's lines with words, in order: j is the number the app uses too (js/lyrics.js retime).
const lines = parseLrc(rec.syncedLyrics).filter((x) => x.text).map((x) => x.text);
console.log(`LRCLIB #${rec.id}: ${rec.trackName} · ${rec.artistName} (${rec.albumName || "?"}), ${lines.length} lines`);
const fd = new FormData();
fd.append("align", "lyrics");
fd.append("song", song);
fd.append("lyrics", JSON.stringify(lines.map((text, index) => ({ index, text }))));
fd.append("from", JSON.stringify({ lrclib: { id: rec.id, track: rec.trackName, artist: rec.artistName } }));
let job = await fetch(helper + "/analyze", { method: "POST", body: fd }).then((r) => r.json());
if (job.error) { console.log(job.error); process.exit(1); }
while (job.state !== "done") {
  if (job.state === "failed" || job.state === "cancelled") { console.log("failed:", job.error); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2000));
  job = await fetch(`${helper}/jobs/${job.id}`).then((r) => r.json());
}
const t = job.timing.lines;
console.log(`lined up ${t.length} of ${lines.length} lines in private/songs/${job.slug}/timing.json; first at ${t[0] && t[0].t}s, last at ${t.length && t[t.length - 1].t}s`);
console.log(`now: node tools/ship-bundle.mjs private/songs/${job.slug}`);
