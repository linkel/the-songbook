// Browser checks with screenshots, in Mocha and Latte at 375x752, 375x630 and
// 1440x900. Serve the repo on 8320 first. node ui.test.mjs [shotsDir]
import { chromium } from "playwright-core";
import fs from "fs";
import { fileURLToPath } from "url";
import { BASE, check, eq, report, fixtureLibrary, EXAMPLE_SHEET } from "./lib.mjs";

const out = process.argv[2] || fileURLToPath(new URL("shots/ui", import.meta.url));
fs.mkdirSync(out, { recursive: true });

// Shipped charts: the counts below follow songs/index.json, so adding charts
// (tools/add-charts.mjs) doesn't break them.
const SHIPPED = JSON.parse(fs.readFileSync(new URL("../songs/index.json", import.meta.url), "utf8")).songs;
const WITH_CHORDS = SHIPPED.filter((x) => x.hasChords).map((x) => x.id).sort();
// The fixture library: 1,727 test songs plus 3 that match shipped charts.
const ALL_SONGS = `All songs (${1727 + SHIPPED.length})`;

const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const SIZES = [[375, 752], [375, 630], [1440, 900]];
const THEMES = [["mocha", "dark"], ["latte", "light"]];

// library: the made-up export served as private/spotify-library.json, or
// null for none (as on GitHub Pages). Tests never read the real file.
async function newPage(w, h, scheme, { library = fixtureLibrary(), ...opts } = {}) {
  const phone = w < 860;
  const context = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone,
    colorScheme: scheme, ...opts,
  });
  await context.route("**/private/**", (route) => library
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(library) })
    : route.fulfill({ status: 404, body: "" }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  // Generous: a busy machine (the whole suite at once) can be slow to start a page.
  await page.waitForSelector("html[data-ready]", { timeout: 90000 });
  return { context, page, errors };
}

// Run a block of checks; an exception fails the block instead of the run.
async function section(name, fn) {
  try { await fn(); } catch (e) { check(`${name}: ran to the end`, false, e.message.split("\n").slice(0, 3).join(" | ")); }
}

// Add the invented example song with its sheet; returns its id.
async function seedSheet(page, source = "mine") {
  return page.evaluate(async ([text, source]) => {
    const L = await import("/js/library.js");
    const S = await import("/js/chordpro.js");
    const { invalidateSongs } = await import("/js/songs.js");
    const id = await L.addManualSong("Example song", "Nobody");
    await L.saveSheet({ id, chordpro: S.importText(text, { title: "Example song", artist: "Nobody" }), source,
      sources: source === "web" ? [{ label: "example.com", url: "https://example.com/chords" }] : [] });
    invalidateSongs();
    return id;
  }, [EXAMPLE_SHEET, source]);
}

const state = (page) => page.evaluate(() => window.songbook.songState());

// A WAV of a made-up synth song (tests/gen-song.js), made in the page.
async function synthWav(page, opts) {
  return Buffer.from(await page.evaluate(async (o) => {
    const g = await import("/tests/gen-song.js");
    const { signal } = await g.renderSong(o);
    return Array.from(g.wavBytes(signal));
  }, opts));
}

// Pick a recording on the analyse screen and wait for the analysis.
async function analyse(page, buffer, name = "example.wav") {
  await page.setInputFiles("#rec-file", { name, mimeType: "audio/wav", buffer });
  await page.waitForFunction(() => { const b = document.querySelector("[data-act=save]"); return b && !b.disabled; }, null, { timeout: 90000 });
  await page.waitForTimeout(200);
}

let EXAMPLE_WAV = null;
const rows = (page) => page.$$eval("#song-groups .row", (r) => r.map((x) => x.dataset.id));

async function show(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(350);
}

// Layout: no sideways overflow, tap targets >= 44 px, transport on screen,
// and every visible text passes WCAG AA against what's behind it.
async function layoutChecks(page, label, { transport = false } = {}) {
  const r = await page.evaluate(() => {
    const vis = (el) => { const b = el.getBoundingClientRect(); return el.offsetParent !== null && b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight; };
    const overflow = [document.documentElement.scrollWidth - innerWidth];
    for (const el of document.querySelectorAll(".view:not(.hidden), .song-scroll, .transport, .topbar, .toolbar, .popover, .popover .seg")) {
      if (el.offsetParent !== null || el.classList.contains("view")) overflow.push(el.scrollWidth - el.clientWidth);
    }
    const small = [...document.querySelectorAll("button, a[href], input, [role=tab]")]
      .filter((el) => vis(el) && !el.closest(".sources") && !el.closest(".hidden"))
      .map((el) => { const b = (el.tagName === "INPUT" ? el.closest("label") || el : el).getBoundingClientRect(); return [(el.textContent || el.getAttribute("aria-label") || el.placeholder || "").trim().slice(0, 20), Math.round(b.width), Math.round(b.height)]; })
      .filter(([, w, h]) => w < 44 || h < 44);
    const tr = [...document.querySelectorAll(".transport")].find((t) => t.offsetParent !== null);
    return { overflow: Math.max(...overflow), small, transportBottom: tr ? tr.getBoundingClientRect().bottom : null };
  });
  check(`${label}: no sideways overflow`, r.overflow <= 1, "by " + r.overflow);
  check(`${label}: tap targets >= 44px`, r.small.length === 0, JSON.stringify(r.small));
  if (transport) check(`${label}: transport on screen`, r.transportBottom !== null && r.transportBottom <= (await page.evaluate(() => innerHeight)) + 0.5, String(r.transportBottom));
  const contrast = await page.evaluate(() => {
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
    let n = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || el.closest("svg, .hidden, [disabled], .sr-only, script, style")) continue;
      const b = el.getBoundingClientRect();
      if (el.offsetParent === null || b.width === 0 || b.bottom < 0 || b.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      if (+cs.opacity < 1) continue;
      const bg = bgOf(el);
      const fg = over(parse(cs.color), bg);
      const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const r = ratio(fg, bg);
      n++;
      if (r < need) bad.push(`"${t.textContent.trim().slice(0, 18)}" ${r.toFixed(2)}<${need}`);
    }
    return { n, bad: [...new Set(bad)] };
  });
  check(`${label}: text contrast AA (${contrast.n} texts)`, contrast.bad.length === 0, contrast.bad.slice(0, 6).join("; "));
}

/* ---- Every size, both flavours: layout and screenshots ---- */

for (const [w, h] of SIZES) {
  for (const [theme, scheme] of THEMES) {
    await section(`${w}x${h} ${theme}`, async () => {
      const tag = `${w}x${h} ${theme}`;
      const { context, page, errors } = await newPage(w, h, scheme);
      eq(`${tag}: theme follows the system`, await page.evaluate(() => document.documentElement.dataset.theme), theme);
      const id = await seedSheet(page);
      const pages = [
        ["songs", "#/songs", false],
        ["sheet", `#/song/${id}/sheet`, true],
        ["editor", `#/song/${id}/edit`, false],
        ["landslide", "#/song/landslide", true],
        ["rising-sun", "#/song/the-house-of-the-rising-sun", true],
        ["boxer", "#/song/the-boxer", true],
        ["picking", "#/song/landslide/picking", true],
        ["picking-six", "#/song/the-house-of-the-rising-sun/picking", true],
        ["practice", "#/practice", false],
        ["settings", "#/settings", false],
      ];
      for (const [name, hash, transport] of pages) {
        await show(page, hash);
        await page.screenshot({ path: `${out}/${w}x${h}-${theme}-${name}.png` });
        await layoutChecks(page, `${tag} ${name}`, { transport });
      }
      // A playlist picked in the list.
      await show(page, "#/songs");
      await page.selectOption("#song-list-pick", "Guitar Selection");
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-songs-playlist.png` });
      await layoutChecks(page, `${tag} songs, one playlist`);
      await page.selectOption("#song-list-pick", "");
      await page.click("#add-song");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-add-song.png` });
      await layoutChecks(page, `${tag} add-song form`);
      await page.keyboard.press("Escape");

      // The sheet wraps inside its column, chords above their words.
      await show(page, `#/song/${id}/sheet`);
      const wrap = await page.evaluate(() => {
        const sheet = document.querySelector(".sheet").getBoundingClientRect();
        const lines = [...document.querySelectorAll(".sheet .line")];
        const wide = lines.filter((l) => l.getBoundingClientRect().right > sheet.right + 1).length;
        const words = [...document.querySelectorAll(".sheet .sw .w")].filter((x) => x.getBoundingClientRect().right > sheet.right + 1).length;
        return { wide, words, lines: lines.length };
      });
      check(`${tag}: sheet lines wrap inside the column`, wrap.wide === 0 && wrap.words === 0 && wrap.lines > 8, JSON.stringify(wrap));
      for (const [act, name] of [["transpose", "transpose"], ["font", "text-size"], ["capo", "sheet-capo"]]) {
        await page.click(`[data-act=${act}]`);
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${out}/${w}x${h}-${theme}-${name}.png` });
        await layoutChecks(page, `${tag} ${name} sheet`);
        await page.keyboard.press("Escape");
      }
      await page.click(".sheet .c[data-k='5'] > span");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-sheet-chord.png` });
      await layoutChecks(page, `${tag} chord from the sheet`);
      await page.keyboard.press("Escape");

      // Chords from audio: the review screen, its chord picker, the saved chart.
      if (!EXAMPLE_WAV) EXAMPLE_WAV = await synthWav(page, { bpm: 96, bars: ["D", "Bm", "G", "A"], repeat: 2 });
      await show(page, "#/song/late-july/analyse");
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-analyse-empty.png` });
      await layoutChecks(page, `${tag} analyse, no recording`, { transport: true });
      await analyse(page, EXAMPLE_WAV);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-analyse.png` });
      await layoutChecks(page, `${tag} analyse`, { transport: true });
      await page.$eval("#song-scroll", (s) => { s.scrollTop = s.scrollHeight; });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-analyse-bars.png` });
      await layoutChecks(page, `${tag} analyse, bars`, { transport: true });
      await page.click(".bar[data-bar='1']");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-chord-picker.png` });
      await layoutChecks(page, `${tag} chord picker`);
      await page.keyboard.press("Escape");
      await page.click("[data-act=save]");
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-detected.png` });
      await layoutChecks(page, `${tag} detected chart`, { transport: true });
      await show(page, "#/settings");
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-settings-storage.png` });
      await layoutChecks(page, `${tag} settings with a recording`);
      await show(page, "#/analyse");
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-batch.png` });
      await layoutChecks(page, `${tag} batch`, { transport: true });

      // Chord popover and capo sheet on a chart.
      await show(page, "#/song/landslide");
      await page.click(".box[data-chord]:visible");
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-popover.png` });
      await layoutChecks(page, `${tag} chord popover`);
      await page.keyboard.press("Escape");
      await page.click("[data-act=capo]");
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-capo.png` });
      await layoutChecks(page, `${tag} capo sheet`);
      await page.keyboard.press("Escape");
      check(`${tag}: no page errors`, errors.length === 0, errors.join("; "));
      await context.close();
    });
  }
}

/* ---- The library ---- */
await section("library", async () => {
  const { context, page, errors } = await newPage(375, 752, "dark");
  await show(page, "#/songs");
  // 1,727 test songs, 3 that match shipped charts, and the other shipped charts.
  eq("all songs counted once", await page.$eval("#song-list-pick option", (o) => o.textContent), ALL_SONGS);
  eq("lists: liked, playlists, no empty ones", await page.$$eval("#song-list-pick option", (o) => o.slice(1, 4).map((x) => x.textContent)),
    ["Liked songs (958)", "Guitar Selection (4)", "Test Playlist 1 (138)"]);
  check("empty playlists left out", !(await page.$$eval("#song-list-pick option", (o) => o.map((x) => x.textContent))).some((t) => t.startsWith("Empty list")));
  eq("charted songs first", await page.$$eval("#song-groups .h2", (h) => h.map((x) => x.textContent)), ["Charts and sheets", "All songs"]);
  const charted = (await rows(page)).slice(0, WITH_CHORDS.length);
  check("library songs match shipped charts", ["dust-in-the-wind", "landslide", "the-house-of-the-rising-sun"].every((id) => charted.includes(id)), JSON.stringify(charted));
  const n0 = (await rows(page)).length;
  check("rows render in batches", n0 <= 63, String(n0));
  for (let i = 0; i < 4; i++) { await page.evaluate(() => { const v = document.getElementById("view-songs"); v.scrollTop = v.scrollHeight; }); await page.waitForTimeout(250); }
  const n1 = (await rows(page)).length;
  check("more rows load while scrolling", n1 >= n0 + 180, `${n0} -> ${n1}`);
  await page.fill("#song-search", "song 1234");
  await page.waitForTimeout(100);
  eq("search the whole library", (await rows(page)).length, 1);
  await page.fill("#song-search", "landslide");
  await page.waitForTimeout(100);
  eq("search finds the remastered title as the shipped chart", await rows(page), ["landslide"]);
  await page.fill("#song-search", "");
  await page.click(".pill[data-filter=chords]");
  eq("Has chords filter", (await rows(page)).sort(), WITH_CHORDS);
  await page.click(".pill[data-filter=all]");
  await page.selectOption("#song-list-pick", "Guitar Selection");
  await page.waitForTimeout(150);
  const gs = await rows(page);
  eq("a playlist in its own order", [gs.length, gs[0], gs[1]], [4, "the-house-of-the-rising-sun", "landslide"]);
  await page.selectOption("#song-list-pick", "");

  // Add a song by hand.
  await page.click("#add-song");
  await page.fill(".popover input[name=title]", "My Own Tune");
  await page.fill(".popover input[name=artist]", "Me");
  await page.click(".popover button.primary");
  await page.waitForTimeout(500);
  check("adding a song opens it", /^#\/song\/s[0-9a-z]+/.test(await page.evaluate(() => location.hash)));
  eq("its title", await page.textContent(".topbar .t"), "My Own Tune");
  check("no chords yet, Paste a sheet offered", (await page.$$("a.btn[href$='/edit']")).length >= 1);
  await show(page, "#/songs");
  check("Added by hand list", (await page.$$eval("#song-list-pick option", (o) => o.map((x) => x.textContent))).includes("Added by hand (1)"));
  check("library: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Sheets: paste, view, transpose, scroll, play ---- */
await section("sheet", async () => {
  const { context, page, errors } = await newPage(375, 752, "dark");
  await page.evaluate(async () => {
    const L = await import("/js/library.js");
    await L.addManualSong("Example song", "Nobody");
  });
  const id = await page.evaluate(async () => (await import("/js/library.js")).songIdFor("Example song", "Nobody"));
  await show(page, `#/song/${id}`);
  await page.click("a.btn[href$='/edit']");
  await page.waitForTimeout(300);
  eq("editor opens", await page.textContent(".topbar .t"), "Paste a sheet");
  await page.fill("#sheet-text", EXAMPLE_SHEET);
  await page.click("[data-act=save]");
  await page.waitForTimeout(500);
  eq("saved sheet opens in Sheet mode", (await state(page)).mode, "sheet");
  eq("section tags", await page.$$eval(".sheet .tag", (t) => t.map((x) => x.textContent)), ["INTRO", "VERSE 1", "CHORUS", "VERSE 2"]);
  const above = await page.$$eval(".sheet .c[data-k]", (cs) => cs.slice(0, 7).map((c) => [c.textContent, c.parentElement.querySelector(".w").textContent.replace(/ /g, " ").trim()]));
  eq("chords sit above their syllables", above, [["G", ""], ["Em7", ""], ["C", ""], ["D", ""], ["G", "Morning"], ["Em7", "n"], ["C", "floor,"]]);
  eq("written for capo 3", (await state(page)).displayed.slice(0, 4), ["G", "Em7", "C", "D"]);
  check("info line: key and sounding key", (await page.textContent(".sheet-info")).includes("Key G (sounds B♭)"), await page.textContent(".sheet-info"));
  eq("badge says Mine", await page.textContent(".topbar .badge"), "Mine");

  // Transpose, capo, simple rename the chords.
  await page.click("[data-act=transpose]");
  await page.click(".popover [data-step='1']");
  await page.click(".popover [data-step='1']");
  await page.keyboard.press("Escape");
  eq("transpose +2 in the sheet", await page.$$eval(".sheet .c[data-k]", (c) => c.slice(0, 4).map((x) => x.textContent)), ["A", "F♯m7", "D", "E"]);
  await page.click("[data-act=transpose]");
  await page.click(".popover [data-reset]");
  await page.keyboard.press("Escape");
  await page.click("[data-act=capo]");
  await page.click(".popover [data-capo='0']");
  await page.keyboard.press("Escape");
  eq("capo 0: sounding chords", await page.$$eval(".sheet .c[data-k]", (c) => c.slice(0, 4).map((x) => x.textContent)), ["B♭", "Gm7", "E♭", "F"]);
  await page.click("[data-act=capo]");
  await page.click(".popover [data-capo='3']");
  await page.keyboard.press("Escape");
  await page.click("[data-act=simple]");
  eq("simple: Em7 becomes Em", await page.$$eval(".sheet .c[data-k]", (c) => c.slice(0, 2).map((x) => x.textContent)), ["G", "Em"]);
  await page.click("[data-act=simple]");

  // Aa: text size, kept for the song.
  const fs0 = await page.$eval(".sheet .sw .w", (w) => parseFloat(getComputedStyle(w).fontSize));
  await page.click("[data-act=font]");
  await page.click(".popover [data-step='1']");
  await page.click(".popover [data-step='1']");
  await page.keyboard.press("Escape");
  const fs1 = await page.$eval(".sheet .sw .w", (w) => parseFloat(getComputedStyle(w).fontSize));
  check("Aa makes the lyrics bigger", fs1 > fs0 * 1.2, `${fs0} -> ${fs1}`);
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await page.waitForTimeout(400);
  const fs2 = await page.$eval(".sheet .sw .w", (w) => parseFloat(getComputedStyle(w).fontSize));
  eq("text size and sheet survive a reload", fs2, fs1);
  await page.click("[data-act=font]");
  await page.click(".popover [data-reset]");
  await page.keyboard.press("Escape");

  // Auto-scroll by speed.
  const top0 = await page.$eval("#song-scroll", (s) => s.scrollTop);
  await page.click(".transport.mobile [data-act=scroll]");
  await page.waitForTimeout(300);
  check("scroll speed controls appear", await page.$eval(".scroll-ctl", (c) => !c.classList.contains("hidden")));
  await page.click("[data-act='speed+']");
  eq("faster scroll", (await state(page)).speed, 1.25);
  await page.waitForTimeout(1200);
  const top1 = await page.$eval("#song-scroll", (s) => s.scrollTop);
  check("the sheet scrolls by itself", top1 > top0 + 20, `${top0} -> ${top1}`);
  await page.click(".transport.mobile [data-act=scroll]");
  check("scrolling stops", !(await state(page)).scrolling);
  await page.$eval("#song-scroll", (s) => { s.scrollTop = 0; });

  // Play song: each sheet chord is one bar, strummed once per beat, lit as it plays.
  await page.click(".transport.mobile [data-act=tempo]");
  const plus = await page.$(".popover [data-step='1']");
  for (let i = 0; i < 40; i++) await plus.click();
  await page.keyboard.press("Escape");
  eq("tempo 120", (await state(page)).prefs.tempo, 120);
  await page.click(".transport.mobile .play");
  await page.waitForTimeout(2600);
  const log = await page.evaluate(() => window.songbook.getPlayer().log.slice(0, 8));
  eq("plays the sheet's chords, one bar each", log.slice(0, 6).map((e) => e.chord), ["G", "G", "G", "G", "Em7", "Em7"]);
  check("plain strum at 120: half a second apart", log.slice(1).every((e, i) => Math.abs(e.time - log[i].time - 0.5) < 1e-6));
  check("G shape at capo 3 sounds B♭", log.filter((e) => e.chord === "G").every((e) => e.midis.every((m) => [10, 2, 5].includes(m % 12))));
  const sync = await page.evaluate(async () => {
    const { audioContext } = await import("/js/audio.js");
    const p = window.songbook.getPlayer();
    const outp = [];
    for (let k = 0; k < 6; k++) {
      const c = audioContext();
      const now = c.currentTime - (c.outputLatency || 0);
      const past = p.log.filter((e) => e.time <= now - 0.02);
      const bar = past.length ? past[past.length - 1].bar : -1;
      const lit = document.querySelector(".sheet .c.now");
      const line = document.querySelector(".sheet .line.now");
      outp.push([bar, !!lit && +lit.dataset.k === p.session.bars[bar].k && !!line && line.contains(lit)]);
      await new Promise((r) => setTimeout(r, 300));
    }
    return outp;
  });
  check("the lit chord and line follow the audio clock", sync.filter(([, ok]) => ok).length >= 5, JSON.stringify(sync));
  await page.screenshot({ path: `${out}/behaviour-sheet-playing.png` });
  await page.click(".transport.mobile .play");

  // The Chords view of a sheet.
  await page.click(".seg [data-mode=chords]");
  await page.waitForTimeout(300);
  eq("chords view from the sheet", await page.$$eval(".section .sec-name", (s) => s.map((x) => x.textContent)), ["Intro", "Verse 1", "Chorus", "Verse 2"]);
  eq("first section's bars", await page.$$eval(".section", (s) => [...s[0].querySelectorAll(".bar")].map((x) => x.textContent.trim())), ["G", "Em7", "C", "D"]);
  check("says where they came from", (await page.textContent(".sources")).includes("From your sheet"));

  // A web source needs its link.
  await show(page, `#/song/${id}/edit`);
  await page.click("[data-src=web]");
  await page.click("[data-act=save]");
  await page.waitForTimeout(200);
  check("web sheet without a link isn't saved", (await state(page)).mode === "edit" && (await page.textContent("#toast")).includes("link"));
  await page.fill("#src-url", "https://example.com/some-chords");
  await page.click("[data-act=save]");
  await page.waitForTimeout(500);
  eq("web sheet badge", await page.textContent(".topbar .badge"), "Web · cited");
  check("web sheet cites its link", (await page.$$eval(".sources a", (a) => a.map((x) => x.href))).includes("https://example.com/some-chords"));

  // In the list, with a Sheet badge.
  await show(page, "#/songs");
  check("sheet song is listed with charts", (await rows(page)).slice(0, 4).includes(id));

  // Delete the sheet, then the song.
  await show(page, `#/song/${id}/edit`);
  await page.click("[data-act=delete-sheet]");
  await page.click("[data-act=delete-sheet]");
  await page.waitForTimeout(500);
  eq("deleting the sheet goes to Chords", (await state(page)).mode, "chords");
  await page.click(".seg [data-mode=sheet]");
  await page.waitForTimeout(300);
  check("no sheet any more", (await page.textContent(".song-scroll")).includes("No sheet yet"));
  await page.click(".seg [data-mode=chords]");
  await page.waitForTimeout(200);
  await page.click("[data-act=remove-song]");
  await page.click("[data-act=remove-song]");
  await page.waitForTimeout(400);
  check("removed song is gone", (await page.evaluate(() => location.hash)) === "#/songs" &&
    !(await page.$$eval("#song-list-pick option", (o) => o.map((x) => x.textContent))).some((t) => t.startsWith("Added by hand")));
  check("sheet: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Charts, playing, mixer (from Phase 0) ---- */
await section("charts", async () => {
  const { context, page, errors } = await newPage(375, 752, "dark");
  await show(page, "#/song/landslide");
  const bars = () => page.$$eval(".bars .bar", (b) => b.map((x) => x.textContent.trim()));
  eq("Landslide as charted", await bars(), ["C", "G/B", "Am7", "G/B"]);
  await page.click("[data-act=transpose]");
  await page.click(".popover [data-step='1']");
  await page.click(".popover [data-step='1']");
  await page.keyboard.press("Escape");
  eq("transpose +2", await bars(), ["D", "A/C♯", "Bm7", "A/C♯"]);
  check("key chip follows", (await page.textContent(".head .chips")).includes("Key D (sounds F)"), await page.textContent(".head .chips"));
  await page.click("[data-act=simple]");
  eq("simple", await bars(), ["D", "A", "Bm", "A"]);
  await page.click("[data-act=simple]");
  await page.click("[data-act=capo]");
  await page.click(".popover [data-capo='0']");
  await page.keyboard.press("Escape");
  eq("capo 0 shows sounding chords", await bars(), ["F", "C/E", "Dm7", "C/E"]);
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await page.waitForTimeout(300);
  eq("song settings survive a reload", await bars(), ["F", "C/E", "Dm7", "C/E"]);
  await page.click("[data-act=capo]");
  await page.click(".popover [data-capo='3']");
  await page.keyboard.press("Escape");
  eq("back to capo 3", await bars(), ["D", "A/C♯", "Bm7", "A/C♯"]);

  // Play: Landslide picks its Travis pattern at the set tempo.
  for (let i = 0; i < 40; i++) await page.click(".transport.mobile [data-act='bpm+']");
  eq("tempo 120", (await state(page)).prefs.tempo, 120);
  await page.click(".transport.mobile .play");
  await page.waitForTimeout(1500);
  const run = await page.evaluate(() => { const p = window.songbook.getPlayer(); return { playing: p.playing, log: p.log.slice(0, 12) }; });
  check("Play starts", run.playing);
  const gaps = run.log.slice(1).map((e, i) => e.time - run.log[i].time);
  check("notes evenly spaced on the audio clock (Travis, 2 per beat at 120)", gaps.length >= 4 && gaps.every((g) => Math.abs(g - 0.25) < 1e-6), gaps.map((g) => g.toFixed(4)).join(","));
  check("plays the shown chord (D shape)", run.log[0].chord === "D", run.log[0].chord);
  check("sounds F major at capo 3", run.log.filter((e) => e.chord === "D").every((e) => e.midis.every((m) => [5, 9, 0].includes(m % 12))), JSON.stringify(run.log[0].midis));
  const sync = await page.evaluate(async () => {
    const { audioContext } = await import("/js/audio.js");
    const p = window.songbook.getPlayer();
    const outp = [];
    for (let k = 0; k < 8; k++) {
      const c = audioContext();
      const now = c.currentTime - (c.outputLatency || 0);
      const past = p.log.filter((e) => e.time <= now - 0.02);
      const exp = past.length ? past[past.length - 1].bar : -1;
      const lit = document.querySelector(".bar.on");
      const b = p.session && p.session.bars[exp];
      outp.push([exp, b && lit ? +lit.dataset.bar === b.bar && +lit.dataset.sec === b.sec : false]);
      await new Promise((r) => setTimeout(r, 140));
    }
    return outp;
  });
  check("lit bar matches the audio clock", sync.filter(([, ok]) => ok).length >= 7, JSON.stringify(sync));
  await page.click(".transport.mobile [data-act='bpm-']");
  await page.waitForTimeout(900);
  const gaps2 = await page.evaluate(() => { const l = window.songbook.getPlayer().log.slice(-3); return l.slice(1).map((e, i) => e.time - l[i].time); });
  check("tempo change applies while playing", gaps2.every((g) => Math.abs(g - 60 / 119 / 2) < 1e-6), gaps2.map((g) => g.toFixed(4)).join(","));
  await page.click(".transport.mobile .play");
  await page.waitForTimeout(200);
  check("Stop stops", !(await page.evaluate(() => window.songbook.getPlayer().playing)));

  // A strum pattern, through the mixer's guitar track.
  const strumRun = await page.evaluate(async () => {
    const audio = await import("/js/audio.js");
    const p = window.songbook.getPlayer();
    await p.start({ bars: [{ chords: [{ name: "G", frets: [3, 2, 0, 0, 0, 3] }] }, { chords: [{ name: "C", frets: [null, 3, 2, 0, 1, 0] }] }],
      bpm: 120, time: "4/4", strum: "D - D U - U D U", loop: true });
    await new Promise((r) => setTimeout(r, 1300));
    const g = audio.track("guitar");
    g.setMuted(true);
    await new Promise((r) => setTimeout(r, 200));
    const muted = g.gain.gain.value;
    g.setMuted(false);
    await new Promise((r) => setTimeout(r, 200));
    const unmuted = g.gain.gain.value;
    const clickGain = audio.track("click").gain.gain.value;
    p.stop();
    return { log: p.log.map((e) => [e.time, e.dir, e.chord, e.midis.length]), muted, unmuted, clickGain, tracks: audio.tracks().map((t) => t.name) };
  });
  const sl = strumRun.log;
  eq("strum directions follow the pattern", sl.slice(0, 5).map((e) => e[1]), ["D", "D", "U", "U", "D"]);
  eq("strum timing (eighths at 120)", sl.slice(1, 5).map((e, i) => +(e[0] - sl[i][0]).toFixed(4)), [0.5, 0.25, 0.5, 0.25]);
  check("upstrokes play the top four strings", sl.filter((e) => e[1] === "U").every((e) => e[3] === 4));
  check("muting the guitar track silences it", strumRun.muted < 0.01 && strumRun.unmuted > 0.9, `${strumRun.muted} / ${strumRun.unmuted}`);
  check("other tracks are untouched", strumRun.clickGain > 0.5 || !strumRun.tracks.includes("click"));

  // Rising Sun picks p-i-m-a-m-i in 6/8: six notes a bar.
  await show(page, "#/song/the-house-of-the-rising-sun");
  await page.click(".transport.mobile .play");
  await page.waitForTimeout(2500);
  const rs = await page.evaluate(() => { const p = window.songbook.getPlayer(); const l = p.log.slice(); p.stop(); return l; });
  eq("6/8 picking: six steps in the first bar", rs.filter((e) => e.bar === 0).length, 6);
  check("first bar is Am", rs.filter((e) => e.bar === 0).every((e) => e.chord === "Am" && e.midis.every((m) => [9, 0, 4].includes(m % 12))));

  // A chord popover: choosing a shape saves it for the song.
  await show(page, "#/song/landslide");
  await page.click(".box[data-chord='Bm7']");
  await page.waitForTimeout(200);
  const specs = await page.$$eval(".popover .box[data-spec]", (b) => b.map((x) => x.dataset.spec));
  check("popover lists alternate shapes", specs.length >= 2, specs.join(" "));
  await page.click(`.popover .box[data-spec='${specs[1]}']`);
  await page.keyboard.press("Escape");
  eq("chosen shape saved", (await state(page)).prefs.voicings.Bm7, specs[1]);

  await show(page, "#/song/the-boxer");
  check("no-chords song: Play disabled", await page.$eval(".transport.mobile .play", (b) => b.disabled));
  check("no-chords song: says nothing is invented", (await page.textContent(".song-scroll")).includes("Nothing here is invented"));

  await show(page, "#/settings");
  await page.click("[data-theme-pref=latte]");
  eq("Latte chosen", await page.evaluate(() => document.documentElement.dataset.theme), "latte");
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  eq("theme survives a reload", await page.evaluate(() => document.documentElement.dataset.theme), "latte");
  await show(page, "#/settings");
  await page.click("[data-theme-pref=auto]");
  eq("Auto follows the system again", await page.evaluate(() => document.documentElement.dataset.theme), "mocha");

  await show(page, "#/song/landslide");
  await page.click(".topbar .back");
  await page.waitForTimeout(300);
  check("back goes to Songs", await page.evaluate(() => location.hash === "#/songs" && !document.getElementById("view-songs").classList.contains("hidden")));
  check("charts: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- On GitHub Pages: no private file, import it in Settings ---- */
await section("import", async () => {
  const { context, page, errors } = await newPage(375, 752, "light", { library: null });
  await show(page, "#/songs");
  check("without a library: says how to import it", (await page.textContent("#library-note")).includes("Import library file"));
  eq("without a library: the shipped charts", (await rows(page)).length, SHIPPED.length);
  await page.screenshot({ path: `${out}/import-before.png` });
  await show(page, "#/settings");
  await page.setInputFiles("#lib-file", { name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{nope") });
  await page.waitForTimeout(300);
  check("a broken file is refused", (await page.textContent("#toast")).includes("isn't valid JSON"));
  await page.setInputFiles("#lib-file", { name: "library.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixtureLibrary("2026-02-02T00:00:00Z"))) });
  await page.waitForTimeout(600);
  check("import confirms", (await page.textContent("#toast")).includes("Imported 958 liked songs"), await page.textContent("#toast"));
  check("settings shows the library", (await page.textContent("#lib-status")).includes("958 liked songs and 8 playlists"), await page.textContent("#lib-status"));
  await page.screenshot({ path: `${out}/import-settings.png` });
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, "#/songs");
  eq("imported library survives a reload", await page.$eval("#song-list-pick option", (o) => o.textContent), ALL_SONGS);
  check("import: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Chords from audio: Late July ---- */
await section("analyse", async () => {
  const { context, page, errors } = await newPage(375, 752, "dark");
  await show(page, "#/song/late-july");
  check("Late July: tuning shown", (await page.textContent(".head .chips")).includes("Open D"));
  check("Late July: tutorial link", (await page.$$eval(".sources a", (a) => a.map((x) => x.href))).includes("https://www.youtube.com/watch?v=H_p4siY3Zc4"));
  // Its shipped chords came from the owner's recording, and say so.
  eq("Late July: shipped chords labelled detected", await page.textContent(".topbar .badge"), "Detected · check");
  await page.click("a.btn[href$='/analyse']");
  await page.waitForTimeout(300);
  eq("analyse screen opens", (await state(page)).mode, "analyse");
  const wav = await synthWav(page, { bpm: 96, bars: ["D", "Bm", "G", "A"], repeat: 4 });
  await analyse(page, wav, "late-july-take.wav");
  const steps = await page.textContent(".steps");
  check("tempo found", steps.includes("96 bpm"), steps);
  check("key found", steps.includes("D major"), steps);
  check("no capo suggestion in open D tuning", (await page.$$(".suggest")).length === 0);
  const barsNow = () => page.$$eval(".bar[data-bar]", (b) => b.map((x) => x.textContent.replace("?", "").trim()));
  eq("detected bars", (await barsNow()).slice(0, 8), ["D", "Bm", "G", "A", "D", "Bm", "G", "A"]);
  await page.screenshot({ path: `${out}/behaviour-analyse.png` });

  // Edit a bar with the picker: chords in the key come first.
  await page.click(".bar[data-bar='1']");
  const inKey = await page.$$eval(".popover [data-pick]", (b) => b.map((x) => x.textContent));
  eq("picker: chords in D first", inKey.slice(0, 6), ["D", "Em", "F♯m", "G", "A", "Bm"]);
  await page.click(".popover [data-pick='Em']");
  eq("bar changed", (await barsNow())[1], "Em");
  check("edited bar is marked", await page.$eval(".bar[data-bar='1']", (b) => b.classList.contains("edited")));
  // Any chord: root + quality.
  await page.click(".bar[data-bar='4']");
  await page.click(".popover [data-root='C']");
  await page.click(".popover [data-qual='maj7']");
  await page.click(".popover [data-use]");
  eq("any chord from root and quality", (await barsNow())[4], "Cmaj7");
  // Press and hold to split a bar, then pick the second half.
  const b2 = await page.$(".bar[data-bar='2']");
  const box = await b2.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(200);
  check("holding a bar splits it and opens the second half", (await page.textContent(".popover")).includes("Second half"));
  await page.click(".popover [data-pick='D']");
  eq("split bar", (await barsNow())[2], "GD");

  // Bar lines and tempo.
  const before = await barsNow();
  await page.click("[data-act='phase+']");
  check("moving beat 1 regroups the bars", JSON.stringify(await barsNow()) !== JSON.stringify(before));
  await page.click("[data-act='phase-']");
  await page.click("[data-act=double]");
  check("×2 tempo", (await page.textContent(".steps")).includes("192 bpm"));
  await page.click("[data-act=double]");
  check("back to 96", (await page.textContent(".steps")).includes("96 bpm"));

  // Play along with the strum layer.
  await page.click("[data-act=strum]");
  check("strum along on", await page.$eval("[data-act=strum]", (b) => b.getAttribute("aria-checked") === "true"));
  await page.click("[data-act=playalong]");
  await page.waitForTimeout(2200);
  const pl = await page.evaluate(async () => {
    const R = await import("/js/review.js");
    const p = R.playAlong();
    return { playing: p.playing, pos: p.position, lit: document.querySelectorAll(".bar.on").length, beat1: !!document.getElementById("beat1") };
  });
  check("play along plays the recording", pl.playing && pl.pos > 1, JSON.stringify(pl));
  check("a bar is lit, and Beat 1 offered", pl.lit === 1 && pl.beat1, JSON.stringify(pl));
  await page.click("[data-act=playalong]");

  // Save, then mark as checked.
  await page.click("[data-act=save]");
  await page.waitForTimeout(700);
  eq("saved: back in Chords", (await state(page)).mode, "chords");
  eq("badge: detected", await page.textContent(".topbar .badge"), "Detected · check");
  check("detector named", (await page.textContent(".sources")).includes("essentia.js"));
  check("tuning and link kept on your chart", (await page.textContent(".head .chips")).includes("Open D") &&
    (await page.$$eval(".sources a", (a) => a.map((x) => x.href))).includes("https://www.youtube.com/watch?v=H_p4siY3Zc4"));
  check("recording card", (await page.textContent(".song-scroll")).includes("late-july-take.wav"));
  check("edits saved", (await state(page)).displayed.includes("Cmaj7"));
  await page.click("a.btn[href$='/analyse']");
  await page.waitForTimeout(400);
  await page.click("[data-act=checked]");
  await page.waitForTimeout(700);
  eq("marked as checked: Mine", await page.textContent(".topbar .badge"), "Mine");
  check("says it was detected, then checked", (await page.textContent(".sources")).includes("then checked by ear"));
  await show(page, "#/songs");
  await page.fill("#song-search", "late july");
  await page.waitForTimeout(150);
  check("listed as Mine", (await page.textContent("#song-groups")).includes("Mine"));

  // Delete your chart: back to the shipped one.
  await show(page, "#/song/late-july/chords");
  await page.click("[data-act=delete-chart]");
  await page.click("[data-act=delete-chart]");
  await page.waitForTimeout(500);
  check("your chart deleted: back to the shipped one", (await page.textContent(".song-scroll")).includes("spoken intro"));
  check("analyse: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Agreement with a cited chart (Landslide) ---- */
await section("compare", async () => {
  const { context, page, errors } = await newPage(375, 752, "dark");
  // Landslide's cited chords at sounding pitch (capo 3 shapes C G/B Am7 G/B).
  const wav = await synthWav(page, { bpm: 80, bars: ["Eb", "Bb/D", "Cm7", "Bb/D"], repeat: 4 });
  await show(page, "#/song/landslide/analyse");
  await analyse(page, wav);
  const cmp = await page.textContent(".song-scroll");
  const m = cmp.match(/agrees on (\d+) of (\d+) bars/);
  check("compares with the cited chart", !!m && +m[1] / +m[2] >= 0.85, m ? m[0] : "no comparison");
  check("capo suggestion offered", (await page.$$(".suggest")).length === 1 && (await page.textContent(".suggest")).includes("capo 3"));
  await page.click("[data-act=capo]");
  // Slash chords and 7ths come out by name.
  eq("capo 3: shapes, slash chords and 7ths included", (await page.$$eval(".bar[data-bar]", (b) => b.slice(0, 4).map((x) => x.textContent.replace("?", "").trim()))), ["C", "G/B", "Am7", "G/B"]);
  await page.click("[data-act=save]");
  await page.waitForTimeout(600);
  check("your chart and the cited chart, side by side", (await page.$$("[data-which]")).length === 2);
  await page.click("[data-which=cited]");
  eq("cited chart still there", await page.$$eval(".bars .bar", (b) => b.slice(0, 4).map((x) => x.textContent.trim())), ["C", "G/B", "Am7", "G/B"]);
  check("compare: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Many recordings at once ---- */
await section("batch", async () => {
  const { context, page, errors } = await newPage(375, 752, "light");
  const wav = await synthWav(page, { bpm: 110, bars: ["A", "E", "F#m", "D"], repeat: 2 });
  await show(page, "#/settings");
  await page.click("a[href='#/analyse']");
  await page.waitForTimeout(300);
  await page.setInputFiles("#batch-files", [
    { name: "Test Artist 3 - Test Song 0003.wav", mimeType: "audio/wav", buffer: wav },
    { name: "Kansas - Dust in the Wind.wav", mimeType: "audio/wav", buffer: wav },
    { name: "Nobody - Brand New Tune.wav", mimeType: "audio/wav", buffer: wav },
  ]);
  await page.waitForTimeout(500);
  eq("files matched by name", await page.$$eval(".batch-row .badge", (b) => b.map((x) => x.textContent)), ["matched", "matched", "no match"]);
  eq("unmatched file becomes a new song", await page.$eval("select[data-row='2']", (s) => s.value), "new");
  await page.screenshot({ path: `${out}/behaviour-batch.png` });
  await page.click("[data-act=start]");
  await page.waitForFunction(() => document.querySelectorAll(".batch-status a").length === 3, null, { timeout: 120000 });
  eq("all three analysed", await page.$$eval(".batch-status", (s) => s.map((x) => x.textContent.trim())), ["Done ✓ review", "Done ✓ review", "Done ✓ review"]);
  const dust = await page.evaluate(async () => (await import("/js/library.js")).get("charts", "dust-in-the-wind"));
  check("chart saved as detected, picking kept", dust && dust.source === "detected" && dust.picking && dust.picking.patterns[0] === "travis");
  await show(page, "#/songs");
  check("new song added by hand", (await page.$$eval("#song-list-pick option", (o) => o.map((x) => x.textContent))).includes("Added by hand (1)"));

  // Storage: three recordings listed; delete one.
  await show(page, "#/settings");
  eq("recordings listed", (await page.$$("[data-del-rec]")).length, 3);
  check("storage meter", (await page.$$(".meter[role=meter]")).length === 1 && (await page.textContent("#storage-text")).includes("Recordings"));
  await page.screenshot({ path: `${out}/behaviour-storage.png` });
  await page.click("[data-del-rec='dust-in-the-wind']");
  await page.click("[data-del-rec='dust-in-the-wind']");
  await page.waitForTimeout(400);
  eq("recording deleted", (await page.$$("[data-del-rec]")).length, 2);
  await show(page, "#/song/dust-in-the-wind/chords");
  check("chords stay after the recording is deleted", (await state(page)).displayed.length > 0 && (await page.textContent(".song-scroll")).includes("None yet"));
  check("batch: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Desktop shortcuts ---- */
await section("desktop", async () => {
  const { context, page, errors } = await newPage(1440, 900, "dark");
  await show(page, "#/song/dust-in-the-wind");
  const side = await page.evaluate(() => { const m = document.querySelector(".song-main-col").getBoundingClientRect(), s = document.querySelector(".song-side").getBoundingClientRect(); return [m.right <= s.left, s.right <= innerWidth]; });
  check("desktop: side panel beside the chart", side[0] && side[1], JSON.stringify(side));
  await page.keyboard.press("ArrowRight");
  eq("desktop: → transposes", (await state(page)).prefs.transpose, 1);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  eq("desktop: ↑ tempo", (await state(page)).prefs.tempo, 81);
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  check("desktop: Space plays", await page.evaluate(() => window.songbook.getPlayer().playing));
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  check("desktop: Space stops", !(await page.evaluate(() => window.songbook.getPlayer().playing)));
  const id = await seedSheet(page);
  await show(page, `#/song/${id}/sheet`);
  await page.keyboard.press("s");
  check("desktop: S starts auto-scroll", (await state(page)).scrolling);
  await page.keyboard.press("s");
  check("desktop: S stops it", !(await state(page)).scrolling);
  await page.screenshot({ path: `${out}/desktop-sheet.png` });
  await show(page, `#/song/${id}/edit`);
  await page.click(".topbar-title");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  eq("desktop: Esc leaves the editor", (await state(page)).mode, "sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("desktop: Esc goes back", await page.evaluate(() => location.hash === "#/songs"));
  check("desktop: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Picking mode ---- */
await section("picking", async () => {
  const { context, page, errors } = await newPage(375, 752, "dark");
  await show(page, "#/song/landslide/picking");
  eq("picking: Travis for Landslide, labelled as your description", [await page.$$eval(".fcell", (c) => c.map((x) => x.textContent).join("")), await page.textContent(".pick-card .badge")], ["pipm", "your description"]);
  check("picking: diagram and notation drawn", (await page.$$(".pick-stage svg circle")).length === 4 && (await page.$$(".pick-notation svg")).length === 1);
  eq("picking: the section's bars", await page.$$eval(".pick-card .bar", (b) => b.map((x) => x.textContent.trim())), ["C", "G/B", "Am7", "G/B"]);
  await page.click(".transport.mobile .play");
  await page.waitForTimeout(1800);
  const run = await page.evaluate(() => {
    const p = window.songbook.getPlayer();
    const steps = p.log.filter((e) => e.type === "step");
    return { steps: steps.length, order: steps.slice(0, 4).map((e) => e.step), chord: steps[0] && steps[0].chord, lit: !!document.querySelector(".fcell.cur"), bar: document.querySelector(".pick-card .bar.on") && document.querySelector(".pick-card .bar.on").textContent.trim(), loop: p.session && p.session.loop };
  });
  check("picking: plays the pattern step by step, lit", run.steps >= 4 && run.order.join() === "0,1,2,3" && run.lit && run.bar === "C" && run.loop, JSON.stringify(run));
  // Shapes under capo 3: the notes are C shapes up three frets.
  const midis = await page.evaluate(() => window.songbook.getPlayer().log.find((e) => e.type === "step").midis);
  eq("picking: thumb on the C shape's bass, capo 3", midis, [51]);
  await page.click(".transport.mobile .play");
  // Choose another pattern: labelled as your pick, kept after a reload.
  await page.click("[data-act=pick-pattern]");
  await page.click("[data-pattern='pima']");
  await page.waitForTimeout(200);
  eq("picking: your pick shown and labelled", [await page.$$eval(".fcell", (c) => c.map((x) => x.textContent).join("")), await page.textContent(".pick-card .badge")], ["pima", "your pick"]);
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, "#/song/landslide/picking");
  eq("picking: your pick kept", await page.textContent(".pick-card .badge"), "your pick");
  await page.click("[data-act=pick-reset]");
  eq("picking: back to the song's pattern", await page.textContent(".pick-card .badge"), "your description");
  // A song with no picking pattern: nothing guessed.
  await show(page, "#/song/ssrignr/picking");
  check("picking: none for a strummed song, nothing guessed", (await page.textContent(".song-scroll")).includes("No picking pattern for this song"));
  await page.screenshot({ path: `${out}/behaviour-picking-none.png` });
  // Pimapeggio: a link when it's reachable, a note when it isn't.
  await show(page, "#/song/landslide/picking");
  await page.waitForTimeout(500);
  const pl = await page.evaluate(() => { const a = document.querySelector("#pima-link"); return { href: a.getAttribute("href"), text: a.textContent }; });
  check("picking: Pimapeggio link with the pattern and section, or a not-online note", (pl.href && /pattern=travis/.test(pl.href) && /chords=C\+%7C\+G%2FB/.test(pl.href) && /capo=3/.test(pl.href)) || pl.text === "Not online yet", JSON.stringify(pl));
  check("picking: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Offline after the first load ---- */
await section("offline", async () => {
  const { context, page } = await newPage(375, 752, "dark");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();   // now under the service worker's control
  await page.waitForSelector("html[data-ready]");
  await show(page, "#/song/landslide");
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector("html[data-ready]", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  const offline = await page.evaluate(() => [document.querySelectorAll(".bars .bar").length, !!navigator.serviceWorker.controller]);
  check("works offline after the first load", offline[0] === 4 && offline[1], JSON.stringify(offline));
  await show(page, "#/songs");
  eq("library offline", await page.$eval("#song-list-pick option", (o) => o.textContent), ALL_SONGS);
  await context.close();
});

await browser.close();
report("ui");
