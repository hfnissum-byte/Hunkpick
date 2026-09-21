/**
 * Show one replayed conflict in full: both sides, every candidate, and what
 * the humans committed. For checking the harness itself — a benchmark you have
 * not eyeballed is a benchmark you do not believe.
 *
 *   node bench/inspect.mjs --repo <path> --merge <sha> [--path <file>]
 */

import { execFileSync } from "node:child_process";
import { extname } from "node:path";

import { diff3Text, stages } from "../lib/git.mjs";
import { parseConflicts, render } from "../lib/conflicts.mjs";
import { enumerate } from "../lib/candidates.mjs";
import { validateInFile } from "../lib/validate.mjs";
import { canMergeStructurally, structuredMerge } from "../lib/structured.mjs";

const args = process.argv.slice(2);
const get = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? null : args[i + 1];
};
const repo = get("--repo");
const merge = get("--merge");
const only = get("--path");

const git = (a, ok = false) => {
  try {
    return execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    if (ok) return err.stdout ?? "";
    throw err;
  }
};

const normLine = (l) => l.replace(/\r$/, "").replace(/\s+$/, "");
const toLines = (t) => t.replace(/\r\n/g, "\n").split("\n").map(normLine);

const ANCHOR = 4;
const before = (parts, i) => {
  const o = [];
  for (let k = i - 1; k >= 0 && o.length < ANCHOR; k--)
    if (parts[k].type === "stable") o.unshift(...parts[k].lines.slice(-ANCHOR));
  return o.slice(-ANCHOR).map(normLine);
};
const after = (parts, i) => {
  const o = [];
  for (let k = i + 1; k < parts.length && o.length < ANCHOR; k++)
    if (parts[k].type === "stable") o.push(...parts[k].lines.slice(0, ANCHOR));
  return o.slice(0, ANCHOR).map(normLine);
};
function occurrences(hay, needle, from = 0) {
  const hits = [];
  for (let i = from; i + needle.length <= hay.length; i++) {
    if (needle.every((n, j) => hay[i + j] === n)) hits.push(i);
  }
  return hits;
}

const p1 = git(["rev-parse", `${merge}^1`]).trim();
const p2 = git(["rev-parse", `${merge}^2`]).trim();
git(["checkout", "-qf", "--detach", p1], true);
git(["merge", "--no-commit", "--no-ff", p2], true);

const paths = git(["diff", "--name-only", "--diff-filter=U"], true).split("\n").filter(Boolean);

for (const path of paths) {
  if (only && path !== only) continue;
  const truth = git(["show", `${merge}:${path}`], true);
  const truthLines = toLines(truth);

  console.log(`\n${"=".repeat(70)}\n${path}\n${"=".repeat(70)}`);

  const ext = extname(path).toLowerCase();
  if (canMergeStructurally(ext)) {
    const st = stages(path, repo);
    const m = st.base !== null ? structuredMerge(ext, st.base, st.ours, st.theirs) : null;
    console.log(`structural merge: ${m ? "produced" : "declined"}`);
    if (m) console.log(m.text.split("\n").slice(0, 20).join("\n"));
  }

  const text = diff3Text(path, repo);
  if (!text) {
    console.log("(no diff3)");
    continue;
  }
  const parts = parseConflicts(text);

  parts.forEach((part, index) => {
    if (part.type !== "conflict") return;
    console.log(`\n--- conflict at line ${part.line} ---`);
    console.log("OURS  :", JSON.stringify(part.ours));
    console.log("BASE  :", JSON.stringify(part.base));
    console.log("THEIRS:", JSON.stringify(part.theirs));

    const b = before(parts, index);
    const a = after(parts, index);
    const hb = occurrences(truthLines, b);
    const ha = hb.length === 1 ? occurrences(truthLines, a, hb[0] + b.length) : [];
    console.log(`anchor before ${JSON.stringify(b)} -> ${hb.length} hit(s)`);
    console.log(`anchor after  ${JSON.stringify(a)} -> ${ha.length} hit(s)`);

    if (hb.length === 1 && ha.length === 1) {
      const human = truthLines.slice(hb[0] + b.length, ha[0]);
      console.log("HUMAN :", JSON.stringify(human));

      const cands = enumerate(part).filter((c) => validateInFile(path, parts, part.id, c.lines).ok);
      for (const c of cands) {
        const hit = c.lines.map(normLine).join("\n") === human.join("\n");
        console.log(`   ${hit ? "MATCH" : "     "} ${c.kind.padEnd(16)} ${JSON.stringify(c.lines)}`);
      }
    } else {
      console.log("HUMAN : (anchors ambiguous — undecidable)");
    }
  });
}

git(["merge", "--abort"], true);
git(["reset", "-q", "--hard"], true);
