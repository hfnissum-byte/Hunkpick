/**
 * Split diff3-marked text into stable regions and conflict hunks, and put it
 * back together again. Parsing is deliberately strict: an unterminated or
 * out-of-order marker throws rather than guessing, because guessing here means
 * corrupting someone's file.
 */

const OURS = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const SPLIT = /^={7}(?:$| )/;
const THEIRS = /^>{7}(?: |$)/;

/**
 * @returns {Array<{type:'stable',lines:string[]} | {type:'conflict',id:string,ours:string[],base:string[],theirs:string[],line:number}>}
 */
export function parseConflicts(text) {
  const lines = text.split("\n");
  const parts = [];
  let stable = [];
  let i = 0;
  let n = 0;

  const flush = () => {
    if (stable.length) parts.push({ type: "stable", lines: stable });
    stable = [];
  };

  while (i < lines.length) {
    if (!OURS.test(lines[i])) {
      stable.push(lines[i]);
      i++;
      continue;
    }

    const startLine = i + 1;
    flush();
    i++; // past <<<<<<<

    const ours = [];
    const base = [];
    const theirs = [];

    while (i < lines.length && !BASE.test(lines[i]) && !SPLIT.test(lines[i])) {
      if (OURS.test(lines[i]) || THEIRS.test(lines[i])) {
        throw new Error(`Nested or unbalanced conflict marker at line ${i + 1}`);
      }
      ours.push(lines[i++]);
    }

    // The base section is optional: we ask git for diff3, but a file already
    // half-resolved by hand can reach us in plain merge style.
    let hasBase = false;
    if (i < lines.length && BASE.test(lines[i])) {
      hasBase = true;
      i++;
      while (i < lines.length && !SPLIT.test(lines[i])) base.push(lines[i++]);
    }

    if (i >= lines.length) throw new Error(`Conflict starting at line ${startLine} has no =======`);
    i++; // past =======

    while (i < lines.length && !THEIRS.test(lines[i])) {
      if (OURS.test(lines[i])) throw new Error(`Nested conflict marker at line ${i + 1}`);
      theirs.push(lines[i++]);
    }

    if (i >= lines.length) throw new Error(`Conflict starting at line ${startLine} has no >>>>>>>`);
    i++; // past >>>>>>>

    parts.push({
      type: "conflict",
      id: `h${n++}`,
      ours,
      base,
      theirs,
      hasBase,
      line: startLine,
    });
  }

  flush();
  return parts;
}

/** Rebuild a file from parsed parts, taking `resolutions[id]` for each conflict. */
export function render(parts, resolutions) {
  const out = [];
  for (const part of parts) {
    if (part.type === "stable") {
      out.push(...part.lines);
      continue;
    }
    const lines = resolutions[part.id];
    if (lines === undefined) {
      // Unresolved: put the markers back exactly as they were.
      out.push("<<<<<<< ours", ...part.ours);
      if (part.hasBase) out.push("||||||| base", ...part.base);
      out.push("=======", ...part.theirs, ">>>>>>> theirs");
      continue;
    }
    out.push(...lines);
  }
  return out.join("\n");
}

/** Up to `n` lines of surrounding stable text, for context in the judgment. */
export function contextAround(parts, index, n = 6) {
  const before = [];
  const after = [];
  for (let i = index - 1; i >= 0 && before.length < n; i--) {
    if (parts[i].type === "stable") before.unshift(...parts[i].lines.slice(-n));
  }
  for (let i = index + 1; i < parts.length && after.length < n; i++) {
    if (parts[i].type === "stable") after.push(...parts[i].lines.slice(0, n));
  }
  return { before: before.slice(-n), after: after.slice(0, n) };
}
