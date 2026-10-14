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

/* ---- Browser helpers shared by the browser test files ---- */

// Screenshots are for reviewing a phase by eye: SHOTS=1 takes them (npm run shots).
export const SHOTS = !!process.env.SHOTS;
export async function shot(page, path) {
  if (SHOTS) await page.screenshot({ path });
}

// A page of the app in a fresh browser context. library: the made-up export
// served as private/spotify-library.json, or null for none. Throws with the
// page's own errors if it doesn't start.
export async function newPage(browser, { w = 375, h = 752, scheme = "dark", library = fixtureLibrary(), audio404 = true } = {}) {
  const phone = w < 860;
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone, colorScheme: scheme });
  await context.route("**/private/**", (r) => (library
    ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(library) })
    : r.fulfill({ status: 404, body: "" })));
  // Late July's bundled clip (songs/audio/): absent unless a test serves a stand-in.
  if (audio404) await context.route("**/songs/audio/**", (r) => r.fulfill({ status: 404, body: "" }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Not errors: a missing file a test asked for, and a service-worker
  // registration cut short by a reload (the app catches it; Chrome still logs it).
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|error occurred when fetching the script/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  try {
    // Generous: a busy machine can be slow to start a page.
    await page.waitForSelector("html[data-ready]", { timeout: 60000 });
  } catch (e) {
    throw new Error("the app didn't start: " + (errors.join("; ") || e.message.split("\n")[0]));
  }
  return { context, page, errors };
}

// Run a block of checks; an exception fails the block instead of the run.
export async function section(name, fn) {
  if (process.env.DEBUG) console.log("section:", name);
  try { await fn(); } catch (e) { check(`${name}: ran to the end`, false, e.message.split("\n").slice(0, 3).join(" | ")); }
}

export async function show(page, hash, wait = 350) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(wait);
}

// Poll an async check in the page (waitForFunction would take its promise as true).
export async function until(page, fn, arg, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting: " + fn.toString().slice(0, 120));
    await page.waitForTimeout(200);
  }
}

// Layout of the whole page (not just what's on screen, so one phone height
// covers the others): no sideways overflow, tap targets >= 44 px, the
// transport on screen (transport: true), and every text passing WCAG AA in
// both flavours: checked as shown, then with the other flavour switched in.
export async function layout(page, label, { transport = false } = {}) {
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => {
    const vis = (el) => { const b = el.getBoundingClientRect(); return el.offsetParent !== null && b.width > 0 && b.height > 0; };
    const overflow = [document.documentElement.scrollWidth - innerWidth];
    for (const el of document.querySelectorAll(".view:not(.hidden), .song-scroll, .transport, .topbar, .toolbar, .popover, .popover .seg")) {
      if (el.offsetParent !== null || el.classList.contains("view")) overflow.push(el.scrollWidth - el.clientWidth);
    }
    const small = [...document.querySelectorAll("button, a[href], input, select, [role=tab]")]
      .filter((el) => vis(el) && !el.closest(".sources") && !el.closest(".hidden") && !el.closest(".pills"))
      .map((el) => { const b = (el.tagName === "INPUT" && el.closest("label") ? el.closest("label") : el).getBoundingClientRect(); return [(el.textContent || el.getAttribute("aria-label") || el.placeholder || "").trim().slice(0, 20), Math.round(b.width), Math.round(b.height)]; })
      .filter(([, w, h]) => w < 44 || h < 44);
    // Pills scroll sideways on purpose; they still need 44 px height.
    const pills = [...document.querySelectorAll(".pills .pill")].filter(vis).map((el) => Math.round(el.getBoundingClientRect().height)).filter((h) => h < 44);
    const tr = [...document.querySelectorAll(".transport")].find((t) => t.offsetParent !== null);
    return { overflow: Math.max(...overflow), small, pills, transportBottom: tr ? tr.getBoundingClientRect().bottom : null, h: innerHeight };
  });
  check(`${label}: no sideways overflow`, r.overflow <= 1, "by " + r.overflow);
  check(`${label}: tap targets >= 44px`, r.small.length === 0 && r.pills.length === 0, JSON.stringify([r.small.slice(0, 8), r.pills]));
  if (transport) check(`${label}: transport on screen`, r.transportBottom !== null && r.transportBottom <= r.h + 0.5, String(r.transportBottom));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const t of [theme, theme === "latte" ? "mocha" : "latte"]) {
    if (t !== theme) {
      await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, t);
      await page.waitForTimeout(220);
    }
    const bad = await page.evaluate(contrastProblems);
    check(`${label}: text contrast AA in ${t === "latte" ? "Latte" : "Mocha"}`, bad.length === 0, bad.slice(0, 6).join("; "));
  }
  await page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
}

// Runs in the page: every text that fails WCAG AA against what's behind it.
function contrastProblems() {
  const parse = (c) => {
    let m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = c.match(/color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return [0, 0, 0, 0];
  };
  const over = (top, bot) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bot[i] * (1 - a)).concat(1); };
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let bg = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : parse(getComputedStyle(document.body).backgroundColor);
    while (layers.length) bg = over(layers.pop(), bg);
    return bg;
  };
  const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bad = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue;
    const el = t.parentElement;
    if (!el || el.closest("svg, .hidden, [disabled], .sr-only, script, style, iframe")) continue;
    const b = el.getBoundingClientRect();
    if (el.offsetParent === null || b.width === 0) continue;
    const cs = getComputedStyle(el);
    if (+cs.opacity < 1 || (el.closest(".off") && el.closest(".ctl"))) continue;
    const bg = bgOf(el), fg = over(parse(cs.color), bg);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < need) bad.push(`"${t.textContent.trim().slice(0, 18)}" ${r.toFixed(2)}<${need}`);
  }
  return [...new Set(bad)];
}
