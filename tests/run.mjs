// npm test: the whole suite: unit and data checks, then the browser checks
// (needs the app served on 8320: python -m http.server 8320 --bind 127.0.0.1).
// For everyday iteration: npm run quick, plus the file for the area you
// changed (npm run ui / player / pc / part / analysis). npm run shots does the
// whole suite with screenshots at every size and flavour, for reviewing a phase;
// npm run test:helper adds the GPU checks against the running PC helper.
import { spawnSync } from "child_process";
import { BASE } from "./lib.mjs";

if (process.argv.includes("--shots")) process.env.SHOTS = "1";
let failed = 0;
const run = (file) => {
  const r = spawnSync(process.execPath, [file], { stdio: "inherit", cwd: import.meta.dirname });
  if (r.status !== 0) failed++;
};

run("unit.test.mjs");
run("data.test.mjs");
run("sheet.test.mjs");
run("detect.test.mjs");
run("lyrics.test.mjs");
try {
  const res = await fetch(BASE + "index.html");
  if (!res.ok) throw new Error(res.status);
  run("analysis.test.mjs");
  run("ui.test.mjs");
  run("player.test.mjs");
  run("pc.test.mjs");
  run("part.test.mjs");
} catch (e) {
  console.log(`\nFAIL browser checks skipped: nothing at ${BASE} (${e.message}). Serve the repo on 8320 first.`);
  failed++;
}
console.log(failed ? `\n${failed} test file(s) failed` : "\nAll tests passed");
process.exit(failed ? 1 : 0);
