#!/usr/bin/env node
/**
 * jevmerge: resolve git merge conflicts by generating candidates and having a
 * model pick one.
 *
 * Generates the candidate resolutions, discards those that do not parse, sends
 * the rest to the model, and applies thresholds to the answer in code.
 *
 * Writes nothing without --apply. Never stages or commits. Unresolved
 * conflicts keep their markers.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { conflictedPaths, diff3Text, mergeContext, repoRoot, stages } from "./lib/git.mjs";
import { contextAround, parseConflicts, render } from "./lib/conflicts.mjs";
import { enumerate } from "./lib/candidates.mjs";
import { validate, validateInFile } from "./lib/validate.mjs";
import { judge, NONE } from "./lib/judge.mjs";
import { canMergeStructurally, structuredMerge } from "./lib/structured.mjs";
import { MODEL } from "./lib/typesafe.mjs";

/**
 * Resolution kinds that may be applied unattended.
 *
 * Set from bench/replay.mjs. Over 50 held-out merges in expressjs/express the
 * model's picks scored: merged_lines 21/23, ours 98/134, theirs 4/20,
 * union 1/5, union_reversed 0/1. Excluding theirs and union_reversed takes
 * overall precision from 67% to 74%. `base` and `drop` discard work outright,
 * so they need review regardless of how they score.
 *
 * `union` is only weakly supported at n=5 and `merged_tokens` is effectively
 * unmeasured, since express never produced a conflict where a token merge was
 * the committed answer. Both are kept in; neither has evidence behind it.
 *
 * These proportions come from one repository's workflow, where a maintenance
 * branch is merged into a development branch and the development side usually
 * wins. Use `--kinds all` for the full set.
 */
const DEFAULT_KINDS = ["ours", "union", "merged_lines", "merged_tokens", "structural"];

const HELP = `
jevmerge — resolve git merge conflicts by enumeration and judgment

  jevmerge                 inspect the current conflicts and report (default)
  jevmerge --apply         write the resolutions it is confident about

Options
  --apply                  write files; without it nothing is modified
  --confidence <0-1>       minimum probability for the chosen approach (default 0.55)
  --safe <0-1>             minimum "resolvable mechanically" Noul (default 0.25)
  --context <n>            lines of surrounding context to show the model (default 6)
  --kinds <a,b,...|all>    resolution kinds allowed to apply unattended
                           (default ${DEFAULT_KINDS.join(",")})
  --all                    resolve every conflict regardless of the gates
  --json                   machine-readable output
  --model <name>           override the model (default ${MODEL})
  -h, --help               this

Exit codes
  0  every conflict resolved
  1  some conflicts left for you
  2  nothing to do, or an error
`;

function parseArgs(argv) {
  const opts = {
    apply: false,
    confidence: 0.55,
    safe: 0.25,
    context: 6,
    all: false,
    json: false,
    kinds: new Set(DEFAULT_KINDS),
    model: MODEL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (name) => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) throw new Error(`--${name} needs a number`);
      return v;
    };
    switch (a) {
      case "--apply": opts.apply = true; break;
      case "--all": opts.all = true; break;
      case "--json": opts.json = true; break;
      case "--confidence": opts.confidence = num("confidence"); break;
      case "--safe": opts.safe = num("safe"); break;
      case "--context": opts.context = num("context"); break;
      case "--kinds": {
        const v = argv[++i];
        opts.kinds = v === "all" ? null : new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      case "--model": opts.model = argv[++i]; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

/** Match the file's existing line endings so a resolution is not a whitespace diff. */
function matchEol(text, original) {
  const crlf = (original.match(/\r\n/g) ?? []).length;
  const lf = (original.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? text.replace(/\r?\n/g, "\r\n") : text;
}

/**
 * Colour on a TTY, plain text otherwise. NO_COLOR disables it; FORCE_COLOR=1
 * forces it on, which is how the demo capture gets colour through a pipe.
 */
const COLOUR =
  !process.env.NO_COLOR && (process.env.FORCE_COLOR === "1" || process.stdout.isTTY === true);

const wrap = (code) => (s) => (COLOUR ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const c = {
  green: wrap(32),
  yellow: wrap(33),
  red: wrap(31),
  blue: wrap(94),
  magenta: wrap(35),
  cyan: wrap(36),
  dim: wrap(90),
  bold: wrap(1),
};

/** Green once it is over the line, amber near it, red well below. */
const tint = (p, gate) => (p >= gate ? c.green : p >= gate * 0.7 ? c.yellow : c.red);

const bar = (p, gate = 0.75, neutral = false) => {
  const n = Math.max(0, Math.min(10, Math.round(p * 10)));
  const fill = neutral ? c.dim : tint(p, gate);
  return fill("█".repeat(n)) + c.dim("·".repeat(10 - n));
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const root = repoRoot();
  if (!root) {
    console.error("Not inside a git repository.");
    return 2;
  }

  const paths = conflictedPaths(root);
  if (!paths.length) {
    if (opts.json) console.log(JSON.stringify({ conflicts: 0 }));
    else console.log("No conflicted files. Nothing to do.");
    return 2;
  }

  const merge = mergeContext(root);

  // ---- enumerate -----------------------------------------------------------

  const files = [];
  const items = [];
  const skipped = [];

  for (const path of paths) {
    // A structured file gets merged by key before anything looks at its lines.
    // Two branches adding different entries to the same object is a solved
    // problem once you stop treating the file as text.
    const ext = extname(path).toLowerCase();
    if (canMergeStructurally(ext)) {
      const st = stages(path, root);
      if (st.base !== null && st.ours !== null && st.theirs !== null) {
        const merged = structuredMerge(ext, st.base, st.ours, st.theirs);
        if (merged && validate(path, merged.text).ok) {
          const key = `f${files.length}`;
          files.push({ path, structural: { stages: st, merged }, key, hunks: [] });
          items.push({ type: "file", key, file: path, stages: st, merged });
          continue;
        }
      }
    }

    const text = diff3Text(path, root);
    if (text === null) {
      skipped.push({ path, reason: "not a content conflict (add/delete/rename)" });
      continue;
    }

    let parts;
    try {
      parts = parseConflicts(text);
    } catch (err) {
      skipped.push({ path, reason: err.message });
      continue;
    }

    const hunks = [];
    parts.forEach((part, index) => {
      if (part.type !== "conflict") return;

      const all = enumerate(part);
      const candidates = [];
      const rejected = [];
      for (const c of all) {
        const v = validateInFile(path, parts, part.id, c.lines);
        if (v.ok) candidates.push(c);
        else rejected.push({ ...c, reason: v.reason });
      }

      const entry = {
        hunk: part,
        index,
        candidates,
        rejected,
        context: contextAround(parts, index, opts.context),
      };
      hunks.push(entry);

      if (candidates.length < 2) {
        entry.outcome = {
          resolved: false,
          reason:
            candidates.length === 0
              ? "no candidate resolution parses"
              : "only one candidate survived, which is not a choice",
        };
        return;
      }

      entry.key = `${files.length}_${part.id}`;
      items.push({ key: entry.key, file: path, hunk: part, context: entry.context, candidates });
    });

    files.push({ path, parts, hunks });
  }

  const total = files.reduce((n, f) => n + (f.structural ? 1 : f.hunks.length), 0);
  if (!total) {
    console.log("Found conflicted files, but no resolvable content conflicts.");
    for (const s of skipped) console.log(`  ${s.path}: ${s.reason}`);
    return 2;
  }

  // ---- judge ---------------------------------------------------------------

  let verdicts = new Map();
  let stats = { usage: { input_tokens: 0, output_tokens: 0 }, requests: 0, model: opts.model };
  if (items.length) {
    const res = await judge(items, merge, { model: opts.model });
    verdicts = res.verdicts;
    stats = res;
  }

  // ---- gate ----------------------------------------------------------------

  for (const file of files) {
    if (file.structural) {
      const v = verdicts.get(file.key);
      const correct = v?.correct ?? 0;
      const allowed = opts.kinds === null || opts.kinds.has("structural");
      file.outcome = {
        resolved: opts.all || (allowed && correct >= opts.confidence),
        verdict: v,
        reason: opts.all
          ? "--all"
          : !allowed
          ? "structural is not an auto-applied kind"
          : correct >= opts.confidence
          ? "accepted"
          : `structural merge at ${correct.toFixed(2)}, below ${opts.confidence}`,
      };
      continue;
    }
    for (const entry of file.hunks) {
      if (entry.outcome) continue;
      const v = verdicts.get(entry.key);
      const chosen = entry.candidates.find((c) => c.id === v?.candidateId);

      if (!chosen) {
        // `none` is not a candidate, so summing probability over its kind gives
        // zero. Report the probability the model put on the no-match option
        // instead, which is the number that explains the outcome.
        if (v && v.candidateId === NONE) v.mass = v.probabilities[NONE] ?? 0;
        entry.outcome = {
          resolved: false,
          noMatch: v?.candidateId === NONE,
          reason:
            v?.candidateId === NONE
              ? "none of the candidates is the resolution; write this one by hand"
              : "no candidate was selected",
          verdict: v,
        };
        continue;
      }

      // Candidates of the same kind differ only in ordering: two orderings of
      // a union, two of a token merge. The Choice splits probability between
      // them, which lowers confidence without the model being uncertain about
      // the kind. Summing over the kind gives the number to gate on. The
      // selection within the kind is still the model's.
      const mass = entry.candidates
        .filter((c) => c.kind === chosen.kind)
        .reduce((sum, c) => sum + (v.probabilities[c.id] ?? 0), 0);
      v.mass = mass;

      const allowed = opts.kinds === null || opts.kinds.has(chosen.kind);
      const confident = mass >= opts.confidence;
      const mechanical = v.safe >= opts.safe;

      entry.outcome = {
        resolved: opts.all || (allowed && confident && mechanical),
        chosen,
        verdict: v,
        reason: opts.all
          ? "--all"
          : !allowed
          ? `${chosen.kind} is not an auto-applied kind`
          : !confident
          ? `${chosen.kind} at ${mass.toFixed(2)}, below ${opts.confidence}`
          : !mechanical
          ? `needs a person (${v.safe.toFixed(2)} below ${opts.safe})`
          : "accepted",
      };
    }
  }

  // ---- write ---------------------------------------------------------------

  const touched = [];
  for (const file of files) {
    if (file.structural) {
      if (!file.outcome?.resolved) continue;
      file.output = file.structural.merged.text;
      touched.push(file);
      if (opts.apply) {
        const abs = join(root, file.path);
        writeFileSync(abs, matchEol(file.output, readFileSync(abs, "utf8")));
      }
      continue;
    }
    const resolutions = {};
    for (const entry of file.hunks) {
      if (entry.outcome?.resolved) resolutions[entry.hunk.id] = entry.outcome.chosen.lines;
    }
    if (!Object.keys(resolutions).length) continue;

    file.output = render(file.parts, resolutions);
    touched.push(file);

    if (opts.apply) {
      const abs = join(root, file.path);
      const original = readFileSync(abs, "utf8");
      writeFileSync(abs, matchEol(file.output, original));
    }
  }

  // ---- report --------------------------------------------------------------

  const resolved =
    files.filter((f) => f.structural && f.outcome?.resolved).length +
    files.flatMap((f) => f.hunks).filter((h) => h.outcome?.resolved).length;
  const left = total - resolved;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          model: stats.model,
          requests: stats.requests,
          usage: stats.usage,
          applied: opts.apply,
          total,
          resolved,
          remaining: left,
          skipped,
          files: files.map((f) => ({
            path: f.path,
            structural: f.structural
              ? {
                  resolved: !!f.outcome?.resolved,
                  correct: f.outcome?.verdict?.correct ?? null,
                  gained: f.structural.merged.added,
                  reason: f.outcome?.reason,
                }
              : null,
            hunks: f.hunks.map((h) => ({
              line: h.hunk.line,
              candidates: h.candidates.length,
              rejected: h.rejected.length,
              resolved: !!h.outcome?.resolved,
              kind: h.outcome?.chosen?.kind ?? null,
              lines: h.outcome?.chosen ? h.outcome.chosen.lines : null,
              approach_mass: h.outcome?.verdict?.mass ?? null,
              confidence: h.outcome?.verdict?.confidence ?? null,
              safe: h.outcome?.verdict?.safe ?? null,
              reason: h.outcome?.reason,
            })),
          })),
        },
        null,
        2
      )
    );
    return left ? 1 : 0;
  }

  const mark = (ok) => (ok ? c.green("RESOLVE") : c.yellow("LEAVE  "));

  for (const file of files) {
    console.log(`\n${c.bold(c.cyan(file.path))}`);

    if (file.structural) {
      const o = file.outcome;
      const correct = o?.verdict?.correct ?? 0;
      console.log(
        `  ${mark(o?.resolved)} ${c.dim("whole file")}  ${c.magenta("merged by key")}` +
          `   ${c.dim("correct")} ${bar(correct, opts.confidence)} ${correct.toFixed(2)}`
      );
      if (!o?.resolved) console.log(`           ${c.yellow(o.reason)}`);
      const gained = file.structural.merged.added;
      console.log(
        gained.length
          ? `           ${c.dim(`gains from ${merge.theirs_branch}:`)} ${c.green(gained.join(", "))}`
          : `           ${c.dim("no keys gained; the merge only reorders")}`
      );
      continue;
    }

    for (const entry of file.hunks) {
      const o = entry.outcome;
      const v = o?.verdict;
      const head = `  ${mark(o?.resolved)} ${c.dim(`line ${entry.hunk.line}`)}`;

      if (!v) {
        console.log(`${head}  ${c.dim("—")}  ${c.yellow(o.reason)}`);
        continue;
      }
      const label = o.chosen ? c.magenta(o.chosen.kind) : c.yellow("no match");
      console.log(
        `${head}  ${label}` +
          `   ${c.dim(o.noMatch ? "no-match " : "approach ")}` +
          `${bar(v.mass ?? 0, opts.confidence, o.noMatch)} ${(v.mass ?? 0).toFixed(2)}` +
          `   ${c.dim("mechanical")} ${bar(v.safe, opts.safe)} ${v.safe.toFixed(2)}`
      );
      if (!o.resolved) console.log(`           ${c.yellow(o.reason)}`);
      if (o.chosen) {
        for (const line of o.chosen.lines.slice(0, 4)) {
          console.log(`           ${c.dim("│")} ${o.resolved ? c.green(line) : line}`);
        }
        if (o.chosen.lines.length > 4) {
          console.log(`           ${c.dim(`│ … ${o.chosen.lines.length - 4} more`)}`);
        }
      }
      const runnerUp = Object.entries(v.probabilities)
        .filter(([id]) => id !== v.candidateId)
        .sort((a, b) => b[1] - a[1])[0];
      if (runnerUp && runnerUp[1] > 0.05) {
        const alt = entry.candidates.find((x) => x.id === runnerUp[0]);
        console.log(
          `           ${c.dim(`runner-up: ${alt?.kind ?? runnerUp[0]} at ${runnerUp[1].toFixed(2)}`)}`
        );
      }
    }
  }

  for (const s of skipped) {
    console.log(`\n${c.bold(c.cyan(s.path))}\n  ${c.yellow("LEAVE  ")} ${c.dim(s.reason)}`);
  }

  console.log(
    c.dim(
      `\n${stats.model} · ${stats.requests} request(s) · ` +
        `${stats.usage.input_tokens} in / ${stats.usage.output_tokens} out`
    )
  );
  console.log(
    `${c.green(`${resolved}/${total}`)} conflicts resolved, ` +
      `${left ? c.yellow(left) : c.green(left)} left for you`
  );

  if (!opts.apply && touched.length) {
    console.log(`\nDry run. Re-run with --apply to write ${touched.length} file(s).`);
  } else if (opts.apply && touched.length) {
    console.log(`\nWrote ${touched.length} file(s). Review them, then:`);
    console.log(`  git diff`);
    for (const f of touched) console.log(`  git add ${f.path}`);
  }

  return left ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`jevmerge: ${err.message}`);
    process.exit(2);
  }
);
