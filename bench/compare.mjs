/**
 * Compare replay runs from different repositories.
 *
 * One repository's numbers say nothing about whether the thresholds and the
 * kind list generalise, since both were fitted to express. This prints the
 * same measurements side by side so the answer is visible rather than assumed.
 *
 *   node bench/compare.mjs express=a.json,b.json django=c.json
 */

import { readFileSync } from "node:fs";

const ALLOWED = new Set(["ours", "union", "merged_lines", "merged_tokens", "structural"]);

/** Wilson score interval, because most of these counts are small. */
function wilson(k, n) {
  if (!n) return [0, 0];
  const p = k / n;
  const z = 1.96;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

const pc = (x) => `${(x * 100).toFixed(0)}%`;

function load(spec) {
  const [name, files] = spec.split("=");
  const rows = files.split(",").flatMap((f) => JSON.parse(readFileSync(f, "utf8")));
  return { name, rows };
}

function summarise({ name, rows }) {
  const decided = rows.filter((r) => r.decided);
  const reachable = decided.filter((r) => r.reachable);
  const applied = rows.filter((r) => r.claimed && r.correct != null);
  const correct = applied.filter((r) => r.correct);
  const unwinnable = applied.filter((r) => !r.correct && !r.reachable);
  const [lo, hi] = wilson(correct.length, applied.length);

  const kinds = {};
  for (const r of applied) {
    const k = r.chosenKind ?? "?";
    kinds[k] ??= { n: 0, ok: 0 };
    kinds[k].n++;
    if (r.correct) kinds[k].ok++;
  }

  const exts = {};
  for (const r of applied) {
    const e = r.path.slice(r.path.lastIndexOf("."));
    exts[e] ??= { n: 0, ok: 0 };
    exts[e].n++;
    if (r.correct) exts[e].ok++;
  }

  // What the humans actually chose, over every region where we could tell.
  const truth = {};
  for (const r of reachable) truth[r.correctKind ?? "?"] = (truth[r.correctKind ?? "?"] ?? 0) + 1;

  return {
    name,
    regions: decided.length,
    reachable: reachable.length,
    applied: applied.length,
    correct: correct.length,
    unwinnable: unwinnable.length,
    precision: applied.length ? correct.length / applied.length : 0,
    ci: [lo, hi],
    recall: reachable.length ? correct.length / reachable.length : 0,
    kinds,
    exts,
    truth,
  };
}

const runs = process.argv.slice(2).map(load).map(summarise);
if (!runs.length) throw new Error("usage: compare.mjs name=file.json [name=file.json ...]");

const col = (s) => String(s).padStart(14);
const row = (label, pick) => console.log(label.padEnd(30) + runs.map((r) => col(pick(r))).join(""));

console.log("\n" + "=".repeat(30 + 14 * runs.length));
console.log("".padEnd(30) + runs.map((r) => col(r.name)).join(""));
console.log("=".repeat(30 + 14 * runs.length));
row("conflict regions scored", (r) => r.regions);
row("  answer was reachable", (r) => `${r.reachable} ${pc(r.reachable / r.regions)}`);
console.log("");
row("resolutions written", (r) => r.applied);
row("  correct", (r) => r.correct);
row("  PRECISION", (r) => pc(r.precision));
row("  95% CI", (r) => `${pc(r.ci[0])}-${pc(r.ci[1])}`);
row("  RECALL of reachable", (r) => pc(r.recall));
row("  errors that were unwinnable", (r) => `${r.unwinnable}/${r.applied - r.correct}`);

console.log("\nprecision by kind chosen");
const allKinds = [...new Set(runs.flatMap((r) => Object.keys(r.kinds)))];
for (const k of allKinds) {
  row(
    "  " + k,
    (r) => (r.kinds[k] ? `${r.kinds[k].ok}/${r.kinds[k].n} ${pc(r.kinds[k].ok / r.kinds[k].n)}` : "—")
  );
}

console.log("\nprecision by file type");
const allExts = [...new Set(runs.flatMap((r) => Object.keys(r.exts)))]
  .filter((e) => runs.some((r) => (r.exts[e]?.n ?? 0) >= 3))
  .sort();
for (const e of allExts) {
  row(
    "  " + e,
    (r) => (r.exts[e] ? `${r.exts[e].ok}/${r.exts[e].n} ${pc(r.exts[e].ok / r.exts[e].n)}` : "—")
  );
}

console.log("\nwhat the humans chose");
const allTruth = [...new Set(runs.flatMap((r) => Object.keys(r.truth)))];
for (const k of allTruth) {
  row("  " + k, (r) => (r.truth[k] ? `${r.truth[k]} ${pc(r.truth[k] / r.reachable)}` : "—"));
}

console.log("\n" + "=".repeat(30 + 14 * runs.length));
if (runs.length > 1) {
  const [a, b] = runs;
  const gap = Math.abs(a.precision - b.precision);
  const overlap = a.ci[0] <= b.ci[1] && b.ci[0] <= a.ci[1];
  console.log(
    `precision differs by ${pc(gap)}; the intervals ${overlap ? "overlap" : "do NOT overlap"}` +
      `, so the difference is ${overlap ? "not established by this data" : "unlikely to be noise"}.`
  );
}
