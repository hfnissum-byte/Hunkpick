/**
 * Replays merges from a real repository and scores jevmerge against the
 * committed resolution.
 *
 * For each merge commit M with parents P1 and P2: check out P1, merge P2, and
 * whatever conflicts is a conflict that actually occurred. The resolution is
 * in M's tree.
 *
 *   node bench/replay.mjs --repo <path> --max 30
 *
 * Scoring is per hunk. Merge commits usually contain edits unrelated to the
 * conflicts, so whole-file comparison measures the wrong thing. Instead the
 * harness anchors on the stable lines either side of a conflict, locates them
 * in the committed file, and reads out what sits between them.
 *
 * Results are split three ways:
 *
 *   reachable + picked      correct
 *   reachable + not picked  selection error
 *   not reachable           candidate generation did not cover it
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { diff3Text, stages } from "../lib/git.mjs";
import { parseConflicts, render } from "../lib/conflicts.mjs";
import { enumerate } from "../lib/candidates.mjs";
import { validate, validateInFile } from "../lib/validate.mjs";
import { canMergeStructurally, structuredMerge } from "../lib/structured.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "jevmerge.mjs");

/** Stable lines to anchor on either side of a conflict. */
const ANCHOR = 4;

function parseArgs(argv) {
  const o = { repo: null, max: 30, skip: 0, out: null, confidence: 0.55, safe: 0.25, kinds: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") o.repo = argv[++i];
    else if (argv[i] === "--max") o.max = Number(argv[++i]);
    else if (argv[i] === "--skip") o.skip = Number(argv[++i]);
    else if (argv[i] === "--out") o.out = argv[++i];
    else if (argv[i] === "--confidence") o.confidence = Number(argv[++i]);
    else if (argv[i] === "--safe") o.safe = Number(argv[++i]);
    else if (argv[i] === "--kinds") o.kinds = argv[++i];
    else throw new Error(`unknown arg ${argv[i]}`);
  }
  if (!o.repo) throw new Error("--repo is required");
  return o;
}

const git = (cwd, args, ok = false) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    if (ok) return err.stdout ?? "";
    throw err;
  }
};

/** Line endings and trailing whitespace are not merge decisions. */
const normLine = (l) => l.replace(/\r$/, "").replace(/\s+$/, "");
const toLines = (t) => t.replace(/\r\n/g, "\n").split("\n").map(normLine);
const sameLines = (a, b) => a.length === b.length && a.every((x, i) => normLine(x) === normLine(b[i]));

/** Deep equality that does not care about key order. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Put the clone back on its default branch. The harness leaves HEAD detached
 * on whatever parent it checked out last, and `rev-list HEAD` from there walks
 * a different history, which silently yields nothing to test.
 */
function resetRepo(repo) {
  git(repo, ["merge", "--abort"], true);
  git(repo, ["reset", "-q", "--hard"], true);
  const head = git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], true).trim();
  const branch = head ? head.replace(/^origin\//, "") : "";
  for (const ref of [branch, "master", "main"].filter(Boolean)) {
    try {
      git(repo, ["checkout", "-qf", ref]);
      return ref;
    } catch {
      // try the next name
    }
  }
  throw new Error("could not get the clone back onto a branch");
}

function conflictedMerges(repo, limit, skip = 0) {
  const merges = git(repo, ["rev-list", "--merges", "HEAD"]).split("\n").filter(Boolean);
  const out = [];
  for (const m of merges) {
    if (out.length >= limit + skip) break;
    let p1;
    let p2;
    try {
      p1 = git(repo, ["rev-parse", `${m}^1`]).trim();
      p2 = git(repo, ["rev-parse", `${m}^2`]).trim();
    } catch {
      continue;
    }
    git(repo, ["checkout", "-qf", "--detach", p1], true);
    git(repo, ["merge", "--no-commit", "--no-ff", p2], true);
    const paths = git(repo, ["diff", "--name-only", "--diff-filter=U"], true)
      .split("\n")
      .filter(Boolean);
    if (paths.length) out.push({ merge: m, p1, p2 });
    git(repo, ["merge", "--abort"], true);
    git(repo, ["reset", "-q", "--hard"], true);
  }
  return out.slice(skip);
}

/** Every start index where `needle` occurs in `hay`, at or after `from`. */
function occurrences(hay, needle, from = 0) {
  const hits = [];
  if (!needle.length) return hits;
  for (let i = from; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

const stableBefore = (parts, index) => {
  const out = [];
  for (let i = index - 1; i >= 0 && out.length < ANCHOR; i--) {
    if (parts[i].type === "stable") out.unshift(...parts[i].lines.slice(-ANCHOR));
  }
  return out.slice(-ANCHOR).map(normLine);
};

const stableAfter = (parts, index) => {
  const out = [];
  for (let i = index + 1; i < parts.length && out.length < ANCHOR; i++) {
    if (parts[i].type === "stable") out.push(...parts[i].lines.slice(0, ANCHOR));
  }
  return out.slice(0, ANCHOR).map(normLine);
};

const hasContent = (lines) => lines.some((l) => l.trim().length > 0);

/**
 * What the human actually wrote in place of this conflict.
 *
 * Anchored on the surrounding stable lines: find them in the committed file,
 * and whatever sits between them is the resolution. Returns null when the
 * anchors are missing or ambiguous, which happens when the merge also edited
 * the context. Those are reported as undecided rather than guessed at.
 */
function humanResolution(parts, index, truthLines) {
  const before = stableBefore(parts, index);
  const after = stableAfter(parts, index);

  let from;
  if (!before.length) from = 0;
  else {
    if (!hasContent(before)) return null;
    const hits = occurrences(truthLines, before);
    if (hits.length !== 1) return null;
    from = hits[0] + before.length;
  }

  if (!after.length) return truthLines.slice(from);
  if (!hasContent(after)) return null;
  const hits = occurrences(truthLines, after, from);
  if (hits.length !== 1) return null;
  return truthLines.slice(from, hits[0]);
}

function scoreFile(repo, path, truth, fileReport) {
  const ext = extname(path).toLowerCase();
  const rows = [];

  // Structured files are merged whole, so they are scored whole, on parsed
  // content, so key order and formatting do not count as errors.
  if (fileReport?.structural) {
    let reachable = null;
    try {
      const st = stages(path, repo);
      const merged = structuredMerge(ext, st.base, st.ours, st.theirs);
      reachable = merged ? deepEqual(JSON.parse(merged.text), JSON.parse(truth)) : false;
    } catch {
      reachable = null;
    }
    let correct = null;
    if (fileReport.structural.resolved) {
      try {
        correct = deepEqual(JSON.parse(readWorking(repo, path)), JSON.parse(truth));
      } catch {
        correct = false;
      }
    }
    rows.push({
      path,
      route: "structural",
      decided: reachable !== null,
      reachable,
      claimed: !!fileReport.structural.resolved,
      correct,
      chosenKind: "structural",
      correctKind: reachable ? "structural" : null,
    });
    return rows;
  }

  const text = diff3Text(path, repo);
  if (text === null) return rows;

  let parts;
  try {
    parts = parseConflicts(text);
  } catch {
    return rows;
  }

  const truthLines = toLines(truth);
  let n = 0;

  parts.forEach((part, index) => {
    if (part.type !== "conflict") return;
    const reported = fileReport?.hunks?.[n];
    n++;

    const human = humanResolution(parts, index, truthLines);
    if (human === null) {
      rows.push({ path, route: "line", decided: false, claimed: !!reported?.resolved });
      return;
    }

    const survivors = enumerate(part).filter((c) => validateInFile(path, parts, part.id, c.lines).ok);
    const match = survivors.find((c) => sameLines(c.lines, human));

    // pickCorrect is scored whether or not the gates let it through. Without
    // it there is no way to tell a wrong selection from a correct selection
    // that a threshold blocked, and those need opposite fixes.
    const pickCorrect = reported?.lines ? sameLines(reported.lines, human) : null;

    rows.push({
      path,
      route: "line",
      decided: true,
      candidates: survivors.length,
      reachable: !!match,
      correctKind: match?.kind ?? null,
      claimed: !!reported?.resolved,
      pickCorrect,
      mass: reported?.approach_mass ?? null,
      safe: reported?.safe ?? null,
      gateReason: reported?.reason ?? null,
      correct: reported?.resolved ? pickCorrect : null,
      chosenKind: reported?.kind ?? null,
    });
  });

  return rows;
}

function readWorking(repo, p) {
  try {
    return readFileSync(join(repo, p), "utf8");
  } catch {
    return "";
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = opts.repo;

  const branch = resetRepo(repo);
  process.stderr.write(`on ${branch}; finding merges that actually conflicted…\n`);
  const cases = conflictedMerges(repo, opts.max, opts.skip);
  process.stderr.write(`${cases.length} conflicted merges\n\n`);

  const rows = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let requests = 0;

  for (const [i, c] of cases.entries()) {
    git(repo, ["checkout", "-qf", "--detach", c.p1], true);
    git(repo, ["merge", "--no-commit", "--no-ff", c.p2], true);

    const live = git(repo, ["diff", "--name-only", "--diff-filter=U"], true)
      .split("\n")
      .filter(Boolean);

    const truths = new Map();
    for (const p of live) {
      try {
        truths.set(p, git(repo, ["show", `${c.merge}:${p}`]));
      } catch {
        // the merge deleted it; nothing to compare against
      }
    }

    let result = null;
    try {
      const out = execFileSync(
        process.execPath,
        [CLI, "--apply", "--json", "--confidence", String(opts.confidence), "--safe", String(opts.safe),
          ...(opts.kinds ? ["--kinds", opts.kinds] : [])],
        { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
      );
      result = JSON.parse(out);
    } catch (err) {
      // Exit 1 just means it left something behind, which is a normal outcome.
      try {
        result = JSON.parse(err.stdout ?? "");
      } catch {
        result = null;
      }
    }

    if (result?.usage) {
      usage.input_tokens += result.usage.input_tokens ?? 0;
      usage.output_tokens += result.usage.output_tokens ?? 0;
      requests += result.requests ?? 0;
    }

    for (const [p, truth] of truths) {
      const f = result?.files?.find((x) => x.path === p);
      try {
        for (const r of scoreFile(repo, p, truth, f)) rows.push({ merge: c.merge.slice(0, 8), ...r });
      } catch (err) {
        process.stderr.write(`      scoring ${p} failed: ${err.message}\n`);
      }
    }

    git(repo, ["merge", "--abort"], true);
    git(repo, ["reset", "-q", "--hard"], true);
    process.stderr.write(`  [${i + 1}/${cases.length}] ${c.merge.slice(0, 8)}  ${live.length} file(s)\n`);
  }

  resetRepo(repo);
  printReport(rows, usage, requests, opts);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(rows, null, 2));
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");

function printReport(rows, usage, requests, opts) {
  const decided = rows.filter((r) => r.decided);
  const reachable = decided.filter((r) => r.reachable);

  const claimed = rows.filter((r) => r.claimed);
  const scored = claimed.filter((r) => r.correct !== null && r.correct !== undefined);
  const right = scored.filter((r) => r.correct);

  const reachClaimed = reachable.filter((r) => r.claimed);
  const reachRight = reachClaimed.filter((r) => r.correct);

  const L = console.log;

  L(`\n${"=".repeat(66)}`);
  L(`conflict regions seen                 ${rows.length}`);
  L(`  answer key recoverable              ${decided.length}   (anchors found)`);
  L(`  context itself was edited           ${rows.length - decided.length}   (undecidable, excluded)`);
  L("");
  L(`Of the ${decided.length} with a known answer:`);
  L(`  the answer was among the candidates ${reachable.length}  ${pct(reachable.length, decided.length)}`);
  L(`  no candidate could have matched     ${decided.length - reachable.length}  ${pct(decided.length - reachable.length, decided.length)}`);
  L("");
  L(`Where the answer WAS reachable (${reachable.length}):`);
  L(`  resolved it, matched the human      ${reachRight.length}  ${pct(reachRight.length, reachable.length)}`);
  L(`  resolved it, got it wrong           ${reachClaimed.length - reachRight.length}  ${pct(reachClaimed.length - reachRight.length, reachable.length)}   <- judgment error`);
  L(`  left it for a human                 ${reachable.length - reachClaimed.length}  ${pct(reachable.length - reachClaimed.length, reachable.length)}   <- conservative`);
  L("");
  L(`Everything it resolved and could score (${scored.length}):`);
  L(`  matched the committed merge         ${right.length}  ${pct(right.length, scored.length)}`);
  L(`  did not match                       ${scored.length - right.length}  ${pct(scored.length - right.length, scored.length)}`);

  const byKind = {};
  for (const r of scored) {
    const k = r.chosenKind ?? "?";
    byKind[k] ??= { n: 0, ok: 0 };
    byKind[k].n++;
    if (r.correct) byKind[k].ok++;
  }
  if (Object.keys(byKind).length) {
    L("");
    L("Accuracy by resolution kind chosen:");
    for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1].n - a[1].n)) {
      L(`  ${k.padEnd(18)} ${String(v.ok).padStart(3)}/${String(v.n).padEnd(4)} ${pct(v.ok, v.n)}`);
    }
  }

  // The whole diagnosis: of the reachable regions it did not resolve, how many
  // did the model get right and a threshold throw away, and how many did the
  // model get wrong. The first is a gate problem, the second is a prompt
  // problem, and they do not share a fix.
  const missed = reachable.filter((r) => !r.claimed);
  const blocked = missed.filter((r) => r.pickCorrect === true);
  const mispicked = missed.filter((r) => r.pickCorrect === false);

  if (missed.length) {
    L("");
    L(`Reachable but not resolved (${missed.length}):`);
    L(`  model picked right, gate blocked it  ${blocked.length}  ${pct(blocked.length, missed.length)}   <- gate`);
    L(`  model picked the wrong candidate     ${mispicked.length}  ${pct(mispicked.length, missed.length)}   <- selection`);

    if (blocked.length) {
      const why = {};
      for (const r of blocked) {
        const k = (r.gateReason ?? "?").replace(/[\d.]+/g, "N");
        why[k] = (why[k] ?? 0) + 1;
      }
      L("");
      L("  What blocked a correct pick:");
      for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
        L(`    ${String(n).padStart(3)}  ${k}`);
      }
      const masses = blocked.map((r) => r.mass).filter((x) => x != null).sort((a, b) => a - b);
      const safes = blocked.map((r) => r.safe).filter((x) => x != null).sort((a, b) => a - b);
      const span = (a) => (a.length ? `${a[0].toFixed(2)} – ${a[a.length - 1].toFixed(2)}` : "—");
      L(`    approach on correct-but-blocked picks: ${span(masses)}`);
      L(`    mechanical on the same:                ${span(safes)}`);
    }

    if (mispicked.length) {
      const pairs = {};
      for (const r of mispicked) {
        const k = `${r.correctKind ?? "?"} -> ${r.chosenKind ?? "?"}`;
        pairs[k] = (pairs[k] ?? 0) + 1;
      }
      L("");
      L("  Wrong selections, as should-have -> did:");
      for (const [k, n] of Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        L(`    ${String(n).padStart(3)}  ${k}`);
      }
    }
  }

  const wrong = scored.filter((r) => !r.correct);
  if (wrong.length) {
    L("");
    L("Wrong resolutions:");
    for (const r of wrong.slice(0, 12)) L(`  ${r.merge}  ${(r.chosenKind ?? "?").padEnd(16)} ${r.path}`);
    if (wrong.length > 12) L(`  … ${wrong.length - 12} more`);
  }

  L("");
  L(`gates: confidence ${opts.confidence}, safe ${opts.safe}`);
  L(`${requests} request(s) · ${usage.input_tokens} in / ${usage.output_tokens} out`);
  L("=".repeat(66));
}

main();
