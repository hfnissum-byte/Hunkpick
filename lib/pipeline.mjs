/**
 * The two phases that turn conflicted paths into decided outcomes: gathering
 * the candidates, and applying the thresholds to the model's answers.
 *
 * These live here rather than in the CLI because more than one thing needs
 * them. The demo recorder drives the same review UI the tool does, and if it
 * rebuilt this itself the recording would slowly stop matching the tool.
 */

import { extname } from "node:path";

import { enumerate } from "./candidates.mjs";
import { contextAround, parseConflicts } from "./conflicts.mjs";
import { diff3Text, stages } from "./git.mjs";
import { NONE } from "./judge.mjs";
import { canMergeStructurally, structuredMerge } from "./structured.mjs";
import { validate, validateInFile } from "./validate.mjs";

/**
 * Walk the conflicted paths and build, per file, every candidate resolution
 * that parses.
 *
 * @returns {{files: Array, items: Array, skipped: Array}} `items` is what goes
 * to the model; `files` is what everything downstream reads.
 */
export function collectFiles(paths, root, opts) {
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

  return { files, items, skipped };
}

/** How many decisions there are, counting a structural file as one. */
export function countDecisions(files) {
  return files.reduce((n, f) => n + (f.structural ? 1 : f.hunks.length), 0);
}

/**
 * Apply the thresholds and the allow-list to the model's answers, writing an
 * `outcome` onto every file and hunk. Mutates `files` in place.
 */
export function applyGates(files, verdicts, opts) {
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
}
