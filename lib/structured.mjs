/**
 * Three-way merge at a fourth granularity: keys.
 *
 * Line and token merges cannot resolve the commonest conflict in a JS repo —
 * two branches adding a different key to package.json — because the correct
 * result needs a comma that appears in neither side. Structure does not have
 * that problem: merge the parsed objects, then serialise once.
 *
 * Only applied when all three stages parse. A file somebody hand-edited into
 * invalid JSON falls back to the line-level path like everything else.
 */

import { threeWay } from "./candidates.mjs";

const CONFLICT = Symbol("conflict");

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @returns merged value, or CONFLICT when the two sides disagree in a way
 * structure cannot settle.
 */
function mergeValue(base, ours, theirs) {
  if (same(ours, theirs)) return ours; // includes both-unchanged
  if (same(base, ours)) return theirs; // only theirs moved
  if (same(base, theirs)) return ours; // only ours moved

  if (isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs)) {
    // Key order: base's order first, then whatever each side added.
    const keys = [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])];
    const out = {};
    for (const k of keys) {
      const inOurs = k in ours;
      const inTheirs = k in theirs;
      const inBase = k in base;

      // A key present on one side only is either an addition or a deletion,
      // and which one it is depends entirely on whether the ancestor had it.
      // Getting this backwards silently drops new keys, so it is spelled out.
      if (!inOurs && !inTheirs) continue;

      if (!inOurs) {
        if (!inBase) {
          out[k] = theirs[k]; // the incoming branch added it
          continue;
        }
        if (same(base[k], theirs[k])) continue; // we deleted it, they left it alone
        return CONFLICT; // we deleted it, they changed it
      }

      if (!inTheirs) {
        if (!inBase) {
          out[k] = ours[k]; // we added it
          continue;
        }
        if (same(base[k], ours[k])) continue; // they deleted it, we left it alone
        return CONFLICT; // they deleted it, we changed it
      }

      const merged = mergeValue(inBase ? base[k] : undefined, ours[k], theirs[k]);
      if (merged === CONFLICT) return CONFLICT;
      out[k] = merged;
    }
    return out;
  }

  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    // Reuse the array merge, comparing elements by their serialised form.
    const enc = (arr) => arr.map((x) => JSON.stringify(x));
    const results = threeWay(enc(base), enc(ours), enc(theirs));
    if (results.length !== 1) return CONFLICT; // ambiguous order is not ours to pick
    return results[0].map((s) => JSON.parse(s));
  }

  return CONFLICT; // two different scalars, or a type change
}

/** Two spaces unless the file clearly says otherwise. */
function detectIndent(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  return m[1].startsWith("\t") ? "\t" : m[1].length;
}

const SUPPORTED = new Set([".json"]);

export function canMergeStructurally(ext) {
  return SUPPORTED.has(ext.toLowerCase());
}

/**
 * @returns {{text: string, added: string[]} | null}
 */
export function structuredMerge(ext, baseText, oursText, theirsText) {
  if (!canMergeStructurally(ext)) return null;

  let base;
  let ours;
  let theirs;
  try {
    base = JSON.parse(baseText);
    ours = JSON.parse(oursText);
    theirs = JSON.parse(theirsText);
  } catch {
    return null;
  }

  const merged = mergeValue(base, ours, theirs);
  if (merged === CONFLICT) return null;
  // A result identical to one side is not a merge, it is a choice between
  // the two, and the line-level path asks that as a Choice with both sides as
  // candidates. Decline here and let it fall through.
  if (same(merged, ours) || same(merged, theirs)) return null;

  const trailingNewline = /\n$/.test(oursText) ? "\n" : "";
  const text = JSON.stringify(merged, null, detectIndent(oursText)) + trailingNewline;

  // What the merge contributed that the current branch did not have — the
  // thing a reviewer actually wants to see.
  const added = [];
  const walk = (a, b, path) => {
    if (!isPlainObject(a) || !isPlainObject(b)) return;
    for (const k of Object.keys(b)) {
      const here = path ? `${path}.${k}` : k;
      if (!(k in a)) added.push(here);
      else walk(a[k], b[k], here);
    }
  };
  walk(ours, merged, "");

  return { text, added };
}
