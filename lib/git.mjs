/**
 * Git access. Nothing here modifies the working tree, the index, or HEAD.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Capture stderr rather than inheriting it: every caller here either
    // handles the failure or reports it in its own words, and git's "fatal:
    // not a git repository" turning up before ours is just noise.
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}

/** Absolute path to the repository root, or null if we are not in one. */
export function repoRoot(cwd = process.cwd()) {
  try {
    return git(["rev-parse", "--show-toplevel"], { cwd }).trim();
  } catch {
    return null;
  }
}

/** Paths with unmerged stages, relative to the repo root. */
export function conflictedPaths(cwd) {
  const out = git(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd });
  return out.split("\0").filter(Boolean);
}

/**
 * The two sides of the merge, described well enough for a judgment: branch
 * name plus the subjects of the commits each side contributed. Falls back to
 * whatever is available, because a rebase or a cherry-pick has no MERGE_HEAD.
 */
export function mergeContext(cwd) {
  const safe = (args, fallback = "") => {
    try {
      return git(args, { cwd }).trim();
    } catch {
      return fallback;
    }
  };

  const ours = safe(["rev-parse", "--abbrev-ref", "HEAD"], "HEAD");
  const theirs =
    safe(["name-rev", "--name-only", "MERGE_HEAD"]) ||
    safe(["rev-parse", "--short", "MERGE_HEAD"]) ||
    "incoming";

  // Subjects unique to each side, newest first. Cheap intent, straight from
  // the people who wrote the code.
  const log = (range) =>
    safe(["log", "--no-merges", "--format=%s", "-8", range])
      .split("\n")
      .filter(Boolean);

  return {
    ours_branch: ours,
    theirs_branch: theirs,
    ours_commits: log("MERGE_HEAD..HEAD"),
    theirs_commits: log("HEAD..MERGE_HEAD"),
  };
}

/**
 * The three index stages as raw text: base, ours, theirs. Null for any stage
 * git does not have (add/add has no base, delete/modify is missing a side).
 */
export function stages(path, cwd) {
  const read = (n) => {
    try {
      return git(["show", `:${n}:${path}`], { cwd });
    } catch {
      return null;
    }
  };
  return { base: read(1), ours: read(2), theirs: read(3) };
}

/**
 * Re-derive the conflict in diff3 form, so every hunk carries its base.
 *
 * The working-tree file only has base sections if the user happens to have
 * merge.conflictStyle set, so we rebuild from the index stages instead:
 * 1 = base, 2 = ours, 3 = theirs. Nothing in the working tree is touched.
 *
 * Returns null when a stage is missing, as with add/add or delete/modify.
 * Those are not content conflicts.
 */
export function diff3Text(path, cwd) {
  const stage = (n) => {
    try {
      return git(["show", `:${n}:${path}`], { cwd });
    } catch {
      return null;
    }
  };

  const base = stage(1);
  const ours = stage(2);
  const theirs = stage(3);
  if (base === null || ours === null || theirs === null) return null;

  const dir = mkdtempSync(join(tmpdir(), "hunkpick-"));
  try {
    const f = (name, text) => {
      const p = join(dir, name);
      writeFileSync(p, text);
      return p;
    };
    const o = f("ours", ours);
    const b = f("base", base);
    const t = f("theirs", theirs);

    try {
      // Exit 0 means git merged it after all; non-zero means conflicts, which
      // is the case we are here for. Both give us usable stdout.
      return git(["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", o, b, t]);
    } catch (err) {
      if (typeof err.stdout === "string" && err.stdout.length) return err.stdout;
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export { git };
