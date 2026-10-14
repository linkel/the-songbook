// Reads your Spotify Liked Songs and your own playlists into songs.json.
// PKCE login (no client secret). The token stays in memory and is never written.
// node tools/spotify-import.mjs <client id> [out.json]   (run from the-songbook)
// Output defaults to private/spotify-library.json (gitignored: it is your listening data).
import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const CLIENT_ID = process.argv[2];
if (!CLIENT_ID) { console.error("usage: node tools/spotify-import.mjs <client id> [out.json]"); process.exit(1); }
const PORT = 8319;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = "user-library-read playlist-read-private playlist-read-collaborative";
const OUT = process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "private", "spotify-library.json");

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(crypto.randomBytes(64));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const authUrl = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
  client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT,
  code_challenge_method: "S256", code_challenge: challenge, scope: SCOPES, state,
});

let token = null;

async function api(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url.startsWith("http") ? url : "https://api.spotify.com/v1" + url, {
      headers: { Authorization: "Bearer " + token },
    });
    if (res.status === 429) {
      const wait = (+res.headers.get("retry-after") || 2) * 1000;
      console.log(`rate limited, waiting ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(res.status + " " + (await res.text()).slice(0, 200));
    return res.json();
  }
  throw new Error("still rate limited: " + url);
}

async function all(url) {
  const items = [];
  while (url) {
    const page = await api(url);
    items.push(...(page.items || []));
    url = page.next;
  }
  return items;
}

const song = (t) => t && t.type !== "episode" && t.name
  ? { title: t.name, artist: (t.artists || []).map((a) => a.name).join(", "), album: t.album ? t.album.name : "",
      id: t.id, uri: t.uri, duration_ms: t.duration_ms }
  : null;

async function collect() {
  const me = await api("/me");
  console.log("logged in as", me.display_name || me.id);

  const liked = (await all("/me/tracks?limit=50"))
    .map((it) => { const s = song(it.track || it.item); return s && { ...s, added: it.added_at }; })
    .filter(Boolean);
  console.log("liked songs:", liked.length);

  const playlists = [];
  for (const pl of await all("/me/playlists?limit=50")) {
    const owned = pl.owner && pl.owner.id === me.id;
    const entry = { name: pl.name, owned, collaborative: !!pl.collaborative, songs: [] };
    if (owned || pl.collaborative) {
      try {
        entry.songs = (await all(`/playlists/${pl.id}/items?limit=50`))
          .map((it) => song(it.item || it.track)).filter(Boolean);
      } catch (e) {
        entry.error = e.message;
      }
    } else {
      entry.note = "followed playlist: Spotify only lists items for playlists you own or collaborate on";
    }
    console.log(`playlist "${pl.name}": ${entry.songs.length} songs${entry.note ? " (followed, not readable)" : ""}${entry.error ? " (error)" : ""}`);
    playlists.push(entry);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), liked, playlists }, null, 1));
  console.log("wrote", OUT);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
  const send = (msg) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<body style="font:18px system-ui;background:#12141c;color:#e8eaf2;padding:40px">${msg}</body>`); };
  if (u.searchParams.get("state") !== state) { send("State mismatch. Close this tab and run the import again."); return; }
  if (u.searchParams.get("error")) { send("Spotify said: " + u.searchParams.get("error")); console.error("auth error:", u.searchParams.get("error")); finish(1); return; }
  try {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: verifier }),
    });
    const j = await r.json();
    if (!j.access_token) throw new Error("token exchange failed: " + JSON.stringify(j));
    token = j.access_token;
    send("Logged in. Reading your songs now; you can close this tab and go back to Claude.");
    await collect();
    finish(0);
  } catch (e) {
    console.error(e.message);
    send("Something went wrong: " + e.message.replace(/</g, "&lt;"));
    finish(1);
  }
});

function finish(code) { server.close(); setTimeout(() => process.exit(code), 200); }

server.listen(PORT, "127.0.0.1", () => {
  console.log("Opening Spotify login. If no browser opens, visit:\n" + authUrl);
  spawn("rundll32", ["url.dll,FileProtocolHandler", authUrl.toString()], { detached: true, stdio: "ignore" }).unref();
});
setTimeout(() => { console.error("timed out waiting for login"); finish(1); }, 30 * 60 * 1000);
