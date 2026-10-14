import { chromium } from "playwright-core";
import { fixtureLibrary } from "./lib.mjs";
const b = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const lib = fixtureLibrary();
let slow = 0;
for (let i = 0; i < 40; i++) {
  const ctx = await b.newContext({ viewport: { width: 375, height: 752 }, isMobile: true, hasTouch: true });
  await ctx.route("**/private/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(lib) }));
  const p = await ctx.newPage();
  const logs = [];
  p.on("console", (m) => logs.push(m.type() + ": " + m.text()));
  p.on("pageerror", (e) => logs.push("pageerror: " + e.message));
  const t0 = Date.now();
  await p.goto("http://localhost:8320/");
  try { await p.waitForSelector("html[data-ready]", { timeout: 15000 }); }
  catch (e) {
    slow++;
    console.log("HANG", i, logs.slice(-8));
    console.log(await p.evaluate(() => ({ hash: location.hash, html: document.documentElement.outerHTML.length, sw: !!navigator.serviceWorker.controller, body: document.body.innerText.slice(0, 200) })));
  }
  if (Date.now() - t0 > 4000) console.log(i, "slow start", Date.now() - t0, "ms");
  await ctx.close();
}
console.log("hangs", slow);
await b.close();
