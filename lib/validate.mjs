/**
 * Syntax checks on candidate resolutions, applied before the model sees them.
 * The model only ever chooses between candidates that parse, so a wrong pick
 * is a bad merge rather than a broken file.
 *
 * Unknown file types pass. Rejecting everything we cannot parse would rule out
 * most repositories.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { render } from "./conflicts.mjs";

const MARKER = /^(?:<{7}|\|{7}|={7}|>{7})(?:\s|$)/m;

let scratch = null;
const scratchDir = () => (scratch ??= mkdtempSync(join(tmpdir(), "hunkpick-v-")));

process.on("exit", () => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const cache = new Map();

function compiles(text, ext) {
  const file = join(scratchDir(), `candidate${ext}`);
  writeFileSync(file, text);
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function python(text) {
  const file = join(scratchDir(), "candidate.py");
  writeFileSync(file, text);
  for (const exe of ["python", "python3"]) {
    try {
      execFileSync(exe, ["-c", "import sys,py_compile; py_compile.compile(sys.argv[1], doraise=True)", file], {
        stdio: "pipe",
      });
      return { ok: true };
    } catch (err) {
      // A missing interpreter is not a failed candidate; a real SyntaxError is.
      if (err.code === "ENOENT") continue;
      return { ok: false, reason: "python syntax error" };
    }
  }
  return { ok: true, reason: "no python available" };
}

/**
 * Validate one candidate in the context of the whole file. A hunk that parses
 * on its own can still break the file around it, so the candidate is rendered
 * in place and the result parsed.
 *
 * Every other conflict is pinned to the current branch's version. Leaving them
 * as markers would put markers in the rendered file, and the marker check below
 * would then reject every candidate in any file with more than one conflict.
 * The benchmark uses this same function, which is why it is here and not in the
 * CLI.
 */
export function validateInFile(path, parts, hunkId, lines) {
  const resolutions = {};
  for (const p of parts) {
    if (p.type !== "conflict") continue;
    resolutions[p.id] = p.id === hunkId ? lines : p.ours;
  }
  return validate(path, render(parts, resolutions));
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
export function validate(path, text) {
  const ext = extname(path).toLowerCase();
  const k = `${ext}\u0000${text}`;
  const hit = cache.get(k);
  if (hit) return hit;

  const result = run(ext, text);
  cache.set(k, result);
  return result;
}

function run(ext, text) {
  // Applies to everything, including plain prose: a resolution that still
  // contains a marker is never what anyone wanted.
  if (MARKER.test(text)) return { ok: false, reason: "conflict marker survived" };

  switch (ext) {
    case ".json":
      try {
        JSON.parse(text);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `invalid json: ${err.message.split("\n")[0]}` };
      }

    case ".js":
      // Do not check a .js file as .js. With ESM syntax in the source,
      // `node --check foo.js` exits 0 even when the file does not parse: the
      // CommonJS parse fails, Node retries as a module, and the error is
      // discarded. Verified on Node 24, where a .js file with an import and a
      // conflict marker passes and the same bytes as .mjs fail.
      //
      // Whether a .js file is CommonJS or ESM depends on a package.json we do
      // not have, so try both, under extensions that report correctly.
      return compiles(text, ".mjs") || compiles(text, ".cjs")
        ? { ok: true }
        : { ok: false, reason: "javascript syntax error" };

    case ".mjs":
    case ".cjs":
      return compiles(text, ext) ? { ok: true } : { ok: false, reason: "javascript syntax error" };

    case ".py":
      return python(text);

    default:
      return { ok: true, reason: "no parser for this file type" };
  }
}
