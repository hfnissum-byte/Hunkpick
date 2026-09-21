/**
 * Offline tests. No git, no API. Everything here is the logic that decides
 * what gets written to someone's file, so it runs before anything else.
 *
 *   node test/run.mjs
 */

import { parseConflicts, render, contextAround } from "../lib/conflicts.mjs";
import { diffStat, enumerate, threeWay, tokenize } from "../lib/candidates.mjs";
import { validate } from "../lib/validate.mjs";
import { structuredMerge } from "../lib/structured.mjs";

let failed = 0;
let ran = 0;

function check(name, fn) {
  ran++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const eq = (got, want, what = "") => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${what}\n       got  ${a}\n       want ${b}`);
};

const conflict = (ours, base, theirs) =>
  ["<<<<<<< ours", ...ours, "||||||| base", ...base, "=======", ...theirs, ">>>>>>> theirs"].join("\n");

const kinds = (hunk) => enumerate(hunk).map((c) => c.kind);
const byKind = (hunk, kind) => enumerate(hunk).filter((c) => c.kind === kind).map((c) => c.lines);

console.log("\nparser");

check("splits stable text from a conflict", () => {
  const parts = parseConflicts(["before", conflict(["a"], ["b"], ["c"]), "after"].join("\n"));
  eq(parts.map((p) => p.type), ["stable", "conflict", "stable"]);
  eq(parts[1].ours, ["a"]);
  eq(parts[1].base, ["b"]);
  eq(parts[1].theirs, ["c"]);
  eq(parts[1].hasBase, true);
});

check("handles a conflict with no base section", () => {
  const text = ["<<<<<<< ours", "a", "=======", "c", ">>>>>>> theirs"].join("\n");
  const parts = parseConflicts(text);
  eq(parts[0].hasBase, false);
  eq(parts[0].base, []);
});

check("numbers several conflicts and records their lines", () => {
  const text = [conflict(["a"], ["b"], ["c"]), "mid", conflict(["d"], ["e"], ["f"])].join("\n");
  const hunks = parseConflicts(text).filter((p) => p.type === "conflict");
  eq(hunks.map((h) => h.id), ["h0", "h1"]);
  eq(hunks.map((h) => h.line), [1, 9]);
});

check("rejects an unterminated conflict", () => {
  let threw = false;
  try {
    parseConflicts(["<<<<<<< ours", "a", "=======", "c"].join("\n"));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected a throw on a missing >>>>>>>");
});

check("rejects nested markers", () => {
  let threw = false;
  try {
    parseConflicts(["<<<<<<< ours", "<<<<<<< ours", "=======", ">>>>>>> theirs"].join("\n"));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected a throw on nesting");
});

check("does not mistake a line of equals signs for a separator", () => {
  // ======= exactly is a marker; a longer rule inside a comment is not.
  const parts = parseConflicts(["stable", "// =========", "more"].join("\n"));
  eq(parts.length, 1);
  eq(parts[0].type, "stable");
});

console.log("\nrender");

check("round-trips an unresolved conflict byte for byte", () => {
  const text = ["before", conflict(["a", "b"], ["z"], ["c"]), "after"].join("\n");
  eq(render(parseConflicts(text), {}), text);
});

check("substitutes a resolution", () => {
  const text = ["before", conflict(["a"], ["z"], ["c"]), "after"].join("\n");
  const parts = parseConflicts(text);
  eq(render(parts, { h0: ["RESOLVED"] }), "before\nRESOLVED\nafter");
});

check("resolves one conflict and leaves the other alone", () => {
  const text = [conflict(["a"], ["b"], ["c"]), "mid", conflict(["d"], ["e"], ["f"])].join("\n");
  const parts = parseConflicts(text);
  const out = render(parts, { h0: ["X"] });
  eq(out.split("\n")[0], "X");
  if (!out.includes("<<<<<<< ours")) throw new Error("second conflict lost its markers");
});

check("an empty resolution deletes the region", () => {
  const text = ["before", conflict(["a"], ["z"], ["c"]), "after"].join("\n");
  eq(render(parseConflicts(text), { h0: [] }), "before\nafter");
});

check("gathers surrounding context", () => {
  const text = ["l1", "l2", conflict(["a"], ["b"], ["c"]), "l3", "l4"].join("\n");
  const parts = parseConflicts(text);
  const ctx = contextAround(parts, 1, 2);
  eq(ctx.before, ["l1", "l2"]);
  eq(ctx.after, ["l3", "l4"]);
});

console.log("\nthree-way merge");

check("takes the only side that changed", () => {
  eq(threeWay(["a", "b", "c"], ["a", "B", "c"], ["a", "b", "c"]), [["a", "B", "c"]]);
});

check("combines edits to different regions", () => {
  eq(threeWay(["a", "b", "c"], ["A", "b", "c"], ["a", "b", "C"]), [["A", "b", "C"]]);
});

check("collapses identical edits on both sides", () => {
  eq(threeWay(["a", "b"], ["a", "X"], ["a", "X"]), [["a", "X"]]);
});

check("refuses a genuine overlap", () => {
  eq(threeWay(["a", "b", "c"], ["a", "X", "c"], ["a", "Y", "c"]), []);
});

check("offers both orders for two insertions at one point", () => {
  const got = threeWay(["a", "z"], ["a", "OURS", "z"], ["a", "THEIRS", "z"]);
  eq(got.length, 2, "expected two orderings");
  eq(got[0], ["a", "OURS", "THEIRS", "z"]);
  eq(got[1], ["a", "THEIRS", "OURS", "z"]);
});

console.log("\ndiff stat");

check("counts a pure deletion", () => {
  eq(diffStat(["a", "b", "c"], []), { removed: 3, added: 0, unchanged: 0 });
});

check("counts a pure addition", () => {
  eq(diffStat(["a"], ["a", "b"]), { removed: 0, added: 1, unchanged: 1 });
});

check("counts a one-line edit inside a block", () => {
  // The case the model kept getting wrong: a small edit inside a region the
  // other side deleted outright.
  const base = ["a", "b", "c", "d"];
  eq(diffStat(base, ["a", "b", "X", "d"]), { removed: 1, added: 1, unchanged: 3 });
});

check("reports no change when the sides match", () => {
  eq(diffStat(["a", "b"], ["a", "b"]), { removed: 0, added: 0, unchanged: 2 });
});

console.log("\ntokenizer");

check("round-trips a line exactly", () => {
  const line = "  for (const it of items) sum += it.price * (1 + TAX);";
  eq(tokenize(line).join(""), line);
});

check("keeps indentation as its own token", () => {
  eq(tokenize("  x")[0], "  ");
});

console.log("\ncandidates");

check("always offers both sides", () => {
  const k = kinds({ ours: ["a"], base: ["b"], theirs: ["c"], hasBase: true });
  if (!k.includes("ours") || !k.includes("theirs")) throw new Error(`missing a side: ${k}`);
});

check("merges compatible edits to one line at token level", () => {
  const hunk = {
    ours: ["  sum += it.price * it.qty;"],
    base: ["  sum += it.price;"],
    theirs: ["  sum += it.price * (1 + TAX);"],
    hasBase: true,
  };
  const merged = byKind(hunk, "merged_tokens").map((l) => l[0]);
  if (!merged.length) throw new Error("no token merge produced");
  const wanted = merged.some((l) => l.includes("it.qty") && l.includes("TAX"));
  if (!wanted) throw new Error(`token merge dropped a side: ${JSON.stringify(merged)}`);
});

check("offers no token merge when the sides truly collide", () => {
  const hunk = {
    ours: ["const timeout = 30;"],
    base: ["const timeout = 10;"],
    theirs: ["const timeout = 60;"],
    hasBase: true,
  };
  eq(byKind(hunk, "merged_tokens"), []);
});

check("de-duplicates candidates that come out identical", () => {
  const cands = enumerate({ ours: ["x"], base: ["x"], theirs: ["x"], hasBase: true });
  const texts = cands.map((c) => c.lines.join("\n"));
  eq(new Set(texts).size, texts.length, "duplicate candidate text");
});

check("does not offer deletion when both sides have content", () => {
  const cands = enumerate({ ours: ["a"], base: ["b"], theirs: ["c"], hasBase: true });
  if (cands.some((c) => c.lines.length === 0)) throw new Error("offered an empty resolution");
});

check("does offer deletion when a side deleted", () => {
  const cands = enumerate({ ours: [], base: ["b"], theirs: ["c"], hasBase: true });
  if (!cands.some((c) => c.lines.length === 0)) throw new Error("deletion not offered");
});

check("gives every candidate a unique id", () => {
  const ids = enumerate({ ours: ["a"], base: ["b"], theirs: ["c"], hasBase: true }).map((c) => c.id);
  eq(new Set(ids).size, ids.length);
});

console.log("\nvalidators");

check("accepts valid javascript", () => {
  eq(validate("x.js", "const a = 1;\n").ok, true);
});

check("rejects javascript that does not parse", () => {
  eq(validate("x.js", "function ( {\n").ok, false);
});

check("rejects a leftover conflict marker in any file type", () => {
  eq(validate("notes.txt", "a\n<<<<<<< ours\nb\n").ok, false);
});

check("rejects broken ESM in a .js file", () => {
  // Regression: `node --check x.js` exits 0 for this, because the CommonJS
  // parse fails and the module retry loses the error. Checking it as .mjs is
  // what catches it. If this ever passes, the validator is not validating.
  eq(validate("m.js", 'import fs from "fs";\nfunction ( {\n').ok, false);
});

check("accepts valid ESM in a .js file", () => {
  eq(validate("m.js", 'import fs from "fs";\nexport const a = 1;\n').ok, true);
});

check("accepts CommonJS-only syntax in a .js file", () => {
  // Valid as .cjs, a syntax error as .mjs. The fallback has to cover it.
  eq(validate("c.js", "const o = {};\nwith (o) { }\n").ok, true);
});

check("accepts a file type it has no parser for", () => {
  eq(validate("x.someext", "anything at all\n").ok, true);
});

check("rejects malformed json", () => {
  eq(validate("p.json", '{"a": 1,}').ok, false);
});

check("accepts well-formed json", () => {
  eq(validate("p.json", '{"a": 1}').ok, true);
});

console.log("\nstructural merge");

const json = (o, indent = 2) => JSON.stringify(o, null, indent) + "\n";

check("combines a key added on each side", () => {
  const got = structuredMerge(
    ".json",
    json({ name: "d", port: 1 }),
    json({ name: "d", port: 1, verbose: true }),
    json({ name: "d", port: 1, retries: 3 })
  );
  eq(JSON.parse(got.text), { name: "d", port: 1, verbose: true, retries: 3 });
  eq(got.added, ["retries"]);
});

check("refuses two different values for one key", () => {
  const got = structuredMerge(
    ".json",
    json({ timeout: 10 }),
    json({ timeout: 30 }),
    json({ timeout: 60 })
  );
  eq(got, null);
});

check("declines when the result is one side verbatim", () => {
  // Structure contributed nothing: the answer is just "take theirs", which is
  // a choice, and the line-level path puts choices to a Choice question.
  const got = structuredMerge(
    ".json",
    json({ a: 1, b: 2 }),
    json({ a: 1, b: 2 }),
    json({ a: 1, b: 9 })
  );
  eq(got, null);
});

check("merges nested objects", () => {
  const got = structuredMerge(
    ".json",
    json({ deps: { x: "1" } }),
    json({ deps: { x: "1", y: "2" } }),
    json({ deps: { x: "1", z: "3" } })
  );
  eq(JSON.parse(got.text).deps, { x: "1", y: "2", z: "3" });
  eq(got.added, ["deps.z"]);
});

check("honours a key one side deleted", () => {
  const got = structuredMerge(
    ".json",
    json({ a: 1, old: true }),
    json({ a: 1 }),
    json({ a: 1, old: true, fresh: 2 })
  );
  eq(JSON.parse(got.text), { a: 1, fresh: 2 });
});

check("refuses when one side deletes what the other edited", () => {
  const got = structuredMerge(
    ".json",
    json({ a: 1, k: "old" }),
    json({ a: 1 }),
    json({ a: 1, k: "new" })
  );
  eq(got, null);
});

check("returns null when the merge gains nothing", () => {
  const same = json({ a: 1 });
  eq(structuredMerge(".json", same, same, same), null);
});

check("keeps four-space indentation", () => {
  const got = structuredMerge(
    ".json",
    json({ a: 1 }, 4),
    json({ a: 1, b: 2 }, 4),
    json({ a: 1, c: 3 }, 4)
  );
  if (!got.text.includes('\n    "b"')) throw new Error(`indent not preserved:\n${got.text}`);
});

check("merges an append on each side of an array", () => {
  const got = structuredMerge(
    ".json",
    json({ list: ["a"] }),
    json({ list: ["a", "ours"] }),
    json({ list: ["a", "theirs"] })
  );
  // Two appends at one point is an order question, which structure will not
  // answer on its own.
  eq(got, null);
});

check("merges array edits at different positions", () => {
  const got = structuredMerge(
    ".json",
    json({ list: ["a", "b", "c"] }),
    json({ list: ["A", "b", "c"] }),
    json({ list: ["a", "b", "C"] })
  );
  eq(JSON.parse(got.text).list, ["A", "b", "C"]);
});

check("declines a file type it does not understand", () => {
  eq(structuredMerge(".yaml", "a: 1", "a: 2", "a: 3"), null);
});

check("declines when a stage is not valid json", () => {
  eq(structuredMerge(".json", "{", json({ a: 1 }), json({ a: 2 })), null);
});

console.log(`\n${ran - failed}/${ran} passed\n`);
process.exit(failed ? 1 : 0);
