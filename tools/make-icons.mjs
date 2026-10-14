// Renders icon-180.png and icon-512.png from the SVG below with Chrome.
// cd tests && npm install, then from the repo root: node tools/make-icons.mjs
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "tests", "package.json"));
const { chromium } = require("playwright-core");

// A chord box (C shape) in Catppuccin Mocha: mauve dots, a peach "now playing" nut.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#1e1e2e"/>
  <rect x="96" y="96" width="320" height="22" rx="6" fill="#fab387"/>
  ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${104 + i * 60}" y="118" width="8" height="300" fill="#585b70"/>`).join("")}
  ${[1, 2, 3, 4].map((j) => `<rect x="104" y="${114 + j * 75}" width="308" height="8" fill="#585b70"/>`).join("")}
  <circle cx="168" cy="305" r="28" fill="#cba6f7"/>
  <circle cx="228" cy="230" r="28" fill="#cba6f7"/>
  <circle cx="348" cy="155" r="28" fill="#cba6f7"/>
</svg>`;

const browser = await chromium.launch({ channel: "chrome" });
for (const size of [180, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(root, `icon-${size}.png`) });
  await page.close();
}
await browser.close();
console.log("wrote icon-180.png and icon-512.png");
