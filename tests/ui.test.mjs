// Browser checks with screenshots, in Mocha and Latte at 375x752, 375x630 and
// 1440x900. Serve the repo on 8320 first. node ui.test.mjs [shotsDir]
import { chromium } from "playwright-core";
import fs from "fs";
import { fileURLToPath } from "url";
import { BASE, check, eq, report } from "./lib.mjs";

const out = process.argv[2] || fileURLToPath(new URL("shots/ui", import.meta.url));
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const SIZES = [[375, 752], [375, 630], [1440, 900]];
const THEMES = [["mocha", "dark"], ["latte", "light"]];

async function newPage(w, h, scheme, opts = {}) {
  const phone = w < 860;
  const context = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone,
    colorScheme: scheme, ...opts,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector("html[data-ready]");
  return { context, page, errors };
}

// Run a block of checks; an exception fails the block instead of the run.
async function section(name, fn) {
  try { await fn(); } catch (e) { check(`${name}: ran to the end`, false, e.message.split("\n")[0]); }
}

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
    const tag = `${w}x${h} ${theme}`;
    const { context, page, errors } = await newPage(w, h, scheme);
    eq(`${tag}: theme follows the system`, await page.evaluate(() => document.documentElement.dataset.theme), theme);
    const pages = [
      ["songs", "#/songs", false],
      ["landslide", "#/song/landslide", true],
      ["rising-sun", "#/song/the-house-of-the-rising-sun", true],
      ["boxer", "#/song/the-boxer", true],
      ["practice", "#/practice", false],
      ["settings", "#/settings", false],
    ];
    for (const [name, hash, transport] of pages) {
      await show(page, hash);
      await page.screenshot({ path: `${out}/${w}x${h}-${theme}-${name}.png` });
      await layoutChecks(page, `${tag} ${name}`, { transport });
    }
    // A chord popover and the capo sheet.
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
  }
}

/* ---- Behaviour, on the phone size ---- */
await section("behaviour", async () => {
  const { context, page, errors } = await newPage(375, 752, "dark");
  await page.evaluate(() => indexedDB.deleteDatabase("songbook"));

  // Search and filters.
  await show(page, "#/songs");
  const rows = () => page.$$eval("#song-list .row", (r) => r.map((x) => x.dataset.id));
  check("library lists the shipped charts", (await rows()).length === 13, String((await rows()).length));
  await page.fill("#song-search", "dust");
  await page.waitForTimeout(100);
  eq("search finds a song", await rows(), ["dust-in-the-wind"]);
  await page.fill("#song-search", "");
  await page.click(".pill[data-filter=chords]");
  eq("Has chords filter", (await rows()).sort(), ["dust-in-the-wind", "landslide", "the-house-of-the-rising-sun"]);
  await page.click(".pill[data-filter=need]");
  check("Needs audio filter", (await rows()).length === 10);
  await page.click(".pill[data-filter=all]");

  // Transpose, simplify and capo change what's shown and what sounds.
  await page.click("#song-list .row[data-id=landslide]");
  await page.waitForTimeout(400);
  const bars = () => page.$$eval(".bars .bar", (b) => b.map((x) => x.textContent.trim()));
  eq("Landslide as charted", await bars(), ["C", "G/B", "Am7", "G/B"]);
  await page.click("[data-act='tr+']");
  await page.click("[data-act='tr+']");
  eq("transpose +2", await bars(), ["D", "A/C♯", "Bm7", "A/C♯"]);
  check("key chip follows", (await page.textContent(".head .chips")).includes("D shapes"), await page.textContent(".head .chips"));
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
  eq("tempo 120", await page.evaluate(() => window.songbook.songState().prefs.tempo), 120);
  await page.click(".transport.mobile .play");
  await page.waitForTimeout(1500);
  const run = await page.evaluate(() => {
    const p = window.songbook.getPlayer();
    return { playing: p.playing, log: p.log.slice(0, 12) };
  });
  check("Play starts", run.playing);
  const gaps = run.log.slice(1).map((e, i) => e.time - run.log[i].time);
  check("notes evenly spaced on the audio clock (Travis, 2 per beat at 120)", gaps.length >= 4 && gaps.every((g) => Math.abs(g - 0.25) < 1e-6), gaps.map((g) => g.toFixed(4)).join(","));
  check("plays the shown chord (D shape)", run.log[0].chord === "D", run.log[0].chord);
  // Capo 3 + D shape sounds F: every note is F, A or C.
  check("sounds F major at capo 3", run.log.filter((e) => e.chord === "D").every((e) => e.midis.every((m) => [5, 9, 0].includes(m % 12))), JSON.stringify(run.log[0].midis));
  // The lit bar follows the audio clock.
  const sync = await page.evaluate(async () => {
    const { audioContext } = await import("/js/audio.js");
    const p = window.songbook.getPlayer();
    const out = [];
    for (let k = 0; k < 8; k++) {
      const c = audioContext();
      const now = c.currentTime - (c.outputLatency || 0);
      const past = p.log.filter((e) => e.time <= now - 0.02);
      const exp = past.length ? past[past.length - 1].bar : -1;
      const lit = document.querySelector(".bar.on");
      const b = p.session && p.session.bars[exp];
      out.push([exp, b && lit ? +lit.dataset.bar === b.bar && +lit.dataset.sec === b.sec : false]);
      await new Promise((r) => setTimeout(r, 140));
    }
    return out;
  });
  check("lit bar matches the audio clock", sync.filter(([, ok]) => ok).length >= 7, JSON.stringify(sync));
  // Tempo change while playing.
  await page.click(".transport.mobile [data-act='bpm-']");
  await page.waitForTimeout(900);
  const gaps2 = await page.evaluate(() => { const l = window.songbook.getPlayer().log.slice(-3); return l.slice(1).map((e, i) => e.time - l[i].time); });
  check("tempo change applies while playing", gaps2.every((g) => Math.abs(g - 60 / 119 / 2) < 1e-6), gaps2.map((g) => g.toFixed(4)).join(","));
  await page.click(".transport.mobile .play");
  await page.waitForTimeout(200);
  check("Stop stops", !(await page.evaluate(() => window.songbook.getPlayer().playing)));
  await page.screenshot({ path: `${out}/behaviour-landslide.png` });

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
  const sGaps = sl.slice(1, 5).map((e, i) => +(e[0] - sl[i][0]).toFixed(4));
  eq("strum timing (eighths at 120)", sGaps, [0.5, 0.25, 0.5, 0.25]);
  check("upstrokes play the top four strings", sl.filter((e) => e[1] === "U").every((e) => e[3] === 4));
  check("muting the guitar track silences it", strumRun.muted < 0.01 && strumRun.unmuted > 0.9, `${strumRun.muted} / ${strumRun.unmuted}`);
  check("other tracks are untouched", strumRun.clickGain > 0.5 || !strumRun.tracks.includes("click"));
  check("mixer has a guitar track", strumRun.tracks.includes("guitar"), strumRun.tracks.join(","));

  // Rising Sun picks p-i-m-a-m-i in 6/8: six notes a bar.
  await show(page, "#/song/the-house-of-the-rising-sun");
  await page.click(".transport.mobile .play");
  await page.waitForTimeout(2500);
  const rs = await page.evaluate(() => { const p = window.songbook.getPlayer(); const l = p.log.slice(); p.stop(); return l; });
  const perBar = rs.filter((e) => e.bar === 0).length;
  eq("6/8 picking: six steps in the first bar", perBar, 6);
  check("first bar is Am", rs.filter((e) => e.bar === 0).every((e) => e.chord === "Am" && e.midis.every((m) => [9, 0, 4].includes(m % 12))));

  // A chord popover: choosing a shape saves it for the song.
  await show(page, "#/song/landslide");
  await page.click(".box[data-chord='Bm7']");
  await page.waitForTimeout(200);
  const specs = await page.$$eval(".popover .box[data-spec]", (b) => b.map((x) => x.dataset.spec));
  check("popover lists alternate shapes", specs.length >= 2, specs.join(" "));
  await page.click(`.popover .box[data-spec='${specs[1]}']`);
  await page.keyboard.press("Escape");
  eq("chosen shape saved", await page.evaluate(() => window.songbook.songState().prefs.voicings.Bm7), specs[1]);

  // A song with no chords says so and can't play.
  await show(page, "#/song/the-boxer");
  check("no-chords song: Play disabled", await page.$eval(".transport.mobile .play", (b) => b.disabled));
  check("no-chords song: says nothing is invented", (await page.textContent(".song-scroll")).includes("Nothing here is invented"));

  // Theme switch persists.
  await show(page, "#/settings");
  await page.click("[data-theme-pref=latte]");
  eq("Latte chosen", await page.evaluate(() => document.documentElement.dataset.theme), "latte");
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  eq("theme survives a reload", await page.evaluate(() => document.documentElement.dataset.theme), "latte");
  await show(page, "#/settings");
  await page.click("[data-theme-pref=auto]");
  eq("Auto follows the system again", await page.evaluate(() => document.documentElement.dataset.theme), "mocha");

  // The back button returns to the list.
  await show(page, "#/song/landslide");
  await page.click(".topbar .back");
  await page.waitForTimeout(300);
  check("back goes to Songs", await page.evaluate(() => location.hash === "#/songs" && !document.getElementById("view-songs").classList.contains("hidden")));
  check("behaviour: no page errors", errors.length === 0, errors.join("; "));
  await context.close();
});

/* ---- Desktop shortcuts ---- */
await section("desktop", async () => {
  const { context, page, errors } = await newPage(1440, 900, "dark");
  await page.evaluate(() => indexedDB.deleteDatabase("songbook"));
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await show(page, "#/song/dust-in-the-wind");
  const side = await page.evaluate(() => { const m = document.querySelector(".song-main-col").getBoundingClientRect(), s = document.querySelector(".song-side").getBoundingClientRect(); return [m.right <= s.left, s.right <= innerWidth]; });
  check("desktop: side panel beside the chart", side[0] && side[1], JSON.stringify(side));
  await page.keyboard.press("ArrowRight");
  eq("desktop: → transposes", await page.evaluate(() => window.songbook.songState().prefs.transpose), 1);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  eq("desktop: ↑ tempo", await page.evaluate(() => window.songbook.songState().prefs.tempo), 81);
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  check("desktop: Space plays", await page.evaluate(() => window.songbook.getPlayer().playing));
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  check("desktop: Space stops", !(await page.evaluate(() => window.songbook.getPlayer().playing)));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("desktop: Esc goes back", await page.evaluate(() => location.hash === "#/songs"));
  check("desktop: no page errors", errors.length === 0, errors.join("; "));
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
  check("song list offline", (await page.$$("#song-list .row")).length === 13);
  await context.close();
});

await browser.close();
report("ui");
