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
