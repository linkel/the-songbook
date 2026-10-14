// Tiny check/report helpers shared by the test files.
export const BASE = process.env.BASE_URL || "http://localhost:8320/";

const results = [];
export function check(name, ok, extra = "") {
  results.push({ name, ok: !!ok, extra });
  return !!ok;
}

export function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  return check(name, ok, ok ? "" : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// Print PASS/FAIL lines and set the exit code. Returns the failure count.
export function report(title) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n== ${title}: ${results.length - failed.length}/${results.length} passed`);
  for (const r of results) if (!r.ok || process.env.VERBOSE) console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.extra ? "  " + r.extra : ""));
  if (failed.length) process.exitCode = 1;
  return failed.length;
}

// A made-up library in the import tool's format: 958 liked songs and playlists
// with about 830 entries, plus three songs that match shipped charts.
export function fixtureLibrary(fetched = "2026-01-01T00:00:00.000Z") {
  const song = (i) => ({ title: `Test Song ${String(i).padStart(4, "0")}`, artist: `Test Artist ${i % 37}`, album: `Test Album ${i % 50}` });
  const liked = [];
  for (let i = 1; i <= 955; i++) liked.push({ ...song(i), added: new Date(Date.UTC(2025, 0, 1) + i * 3600e3).toISOString() });
  liked.push({ title: "House Of The Rising Sun", artist: "The Animals", album: "Test", added: "2026-01-01T00:00:00Z" });
  liked.push({ title: "Landslide - 2004 Remaster", artist: "Fleetwood Mac", album: "Test", added: "2025-12-31T00:00:00Z" });
  liked.push({ title: "Dust in the Wind", artist: "Kansas", album: "Test", added: "2025-12-30T00:00:00Z" });
  const playlists = [{ name: "Guitar Selection", owned: true, collaborative: false,
    songs: [{ title: "House Of The Rising Sun", artist: "The Animals" }, { title: "Landslide - 2004 Remaster", artist: "Fleetwood Mac" }, song(3), song(5)] }];
  for (let p = 0; p < 6; p++) {
    const songs = [];
    for (let i = 0; i < 138; i++) songs.push(song(900 + p * 140 + i));   // some overlap Liked, some don't
    playlists.push({ name: `Test Playlist ${p + 1}`, owned: true, collaborative: false, songs });
  }
  playlists.push({ name: "Empty list", owned: false, collaborative: false, songs: [] });
  return { fetched, liked, playlists };
}

// An invented song for sheet tests (the mockup's example song, extended).
export const EXAMPLE_SHEET = `Capo: 3

[Intro]
G  Em7  C  D

[Verse 1]
G              Em7          C
Morning light on the kitchen floor,
G              Em7          C     D
coffee cooling by the open door
G              Em7               C
Every little thing I meant to say
G                Em7         C    D
drifting like a paper boat away

[Chorus]
C        D        Em7       G
Hold on, hold on, it's alright
C               D                 G
Hum it slow and sing it through the night

[Verse 2]
G              Em7              C
Sparrows argue on the garden wall
G                 Em7            C     D
nobody listens and nobody calls`;
