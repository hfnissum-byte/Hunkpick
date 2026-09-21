/**
 * Candidate resolutions for one conflict.
 *
 * The model picks from this list and never writes a resolution itself, so the
 * list has to contain the right answer often enough to be useful, without
 * containing anything invalid.
 *
 * threeWay() is generic over arrays and is used twice: on the lines of a hunk,
 * and on the tokens of a line. The token pass covers both sides editing one
 * line compatibly, e.g. "price * qty" and "price * (1 + tax)" merging to
 * "price * qty * (1 + tax)". A line-level merge cannot produce that.
 */

/** Split a line into words, symbols and runs of whitespace, keeping all of it. */
export function tokenize(line) {
  return line.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\s+|[^\s\w$]/g) ?? [];
}

/** Matched index pairs between a and b, longest common subsequence. */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  // Guard against pathological hunks; callers fall back to coarser candidates.
  if (n * m > 400_000) return null;

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Regions of `base` that `other` replaced, as {s, e, repl} with s/e indices
 * into base and repl the tokens that took their place.
 */
function changeRegions(base, other) {
  const pairs = lcsPairs(base, other);
  if (pairs === null) return null;

  const regions = [];
  let bi = 0;
  let oi = 0;
  const push = (s, e, repl) => {
    if (e > s || repl.length) regions.push({ s, e, repl });
  };

  for (const [pb, po] of pairs) {
    if (pb > bi || po > oi) push(bi, pb, other.slice(oi, po));
    bi = pb + 1;
    oi = po + 1;
  }
  if (bi < base.length || oi < other.length) push(bi, base.length, other.slice(oi));
  return regions;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * How many lines of `base` one side replaced, and how many it put there.
 * Returns null when the arrays are too large to diff.
 */
export function diffStat(base, other) {
  const regions = changeRegions(base, other);
  if (regions === null) return null;
  let removed = 0;
  let added = 0;
  for (const r of regions) {
    removed += r.e - r.s;
    added += r.repl.length;
  }
  return { removed, added, unchanged: base.length - removed };
}

/**
 * Three-way merge of arrays. Returns one result normally, two when both sides
 * inserted at the same point and the order is ambiguous, and none when the
 * changes overlap.
 */
export function threeWay(base, ours, theirs) {
  const ourR = changeRegions(base, ours);
  const theirR = changeRegions(base, theirs);
  if (ourR === null || theirR === null) return [];

  // Walk base left to right, consuming whichever change starts next.
  const results = [[]];
  let pos = 0;
  let a = 0;
  let b = 0;

  const emit = (chunk) => {
    for (const r of results) r.push(...chunk);
  };

  while (a < ourR.length || b < theirR.length) {
    const ra = ourR[a];
    const rb = theirR[b];

    if (ra && rb) {
      // Identical edits are not a conflict at all. Checked first, so that two
      // sides inserting the same text collapse instead of fanning out.
      if (ra.s === rb.s && ra.e === rb.e && same(ra.repl, rb.repl)) {
        emit(base.slice(pos, ra.s));
        emit(ra.repl);
        pos = ra.e;
        a++;
        b++;
        continue;
      }

      // Two insertions at the same point. Both regions are zero-length, so the
      // disjointness tests below would treat them as separate; this case has to
      // be checked first. Both orderings become candidates.
      if (ra.s === rb.s && ra.e === ra.s && rb.e === rb.s) {
        const head = base.slice(pos, ra.s);
        if (results.length === 1) {
          const forward = [...results[0], ...head, ...ra.repl, ...rb.repl];
          const reverse = [...results[0], ...head, ...rb.repl, ...ra.repl];
          results.length = 0;
          results.push(forward, reverse);
        } else {
          // Already fanned out once. Doubling again buys little and costs
          // exponentially, so later insertions keep a fixed order.
          emit(head);
          emit(ra.repl);
          emit(rb.repl);
        }
        pos = ra.s;
        a++;
        b++;
        continue;
      }
    }

    // Only one side has changes left, or the next changes do not touch.
    if (!rb || (ra && ra.e <= rb.s)) {
      emit(base.slice(pos, ra.s));
      emit(ra.repl);
      pos = ra.e;
      a++;
      continue;
    }
    if (!ra || rb.e <= ra.s) {
      emit(base.slice(pos, rb.s));
      emit(rb.repl);
      pos = rb.e;
      b++;
      continue;
    }

    return []; // a real overlap; no mechanical merge exists
  }

  emit(base.slice(pos));
  return same(results[0], results[1] ?? []) ? [results[0]] : results;
}

const key = (lines) => lines.join("\n");

/**
 * All candidate resolutions for one hunk, de-duplicated, each labelled with
 * how it was derived. Order is meaningful only as a tie-break for humans; the
 * judgment sees them as an unordered set.
 */
export function enumerate(hunk) {
  const { ours, theirs, base, hasBase } = hunk;
  const found = new Map();
  const add = (kind, lines) => {
    const k = key(lines);
    if (!found.has(k)) found.set(k, { kind, lines });
  };

  add("ours", ours);
  add("theirs", theirs);
  if (ours.length || theirs.length) {
    add("union", [...ours, ...theirs]);
    add("union_reversed", [...theirs, ...ours]);
  }
  add("drop", []);

  if (hasBase) {
    add("base", base);

    // Line-level three-way: catches sides that edited different lines of the
    // same hunk.
    for (const merged of threeWay(base, ours, theirs)) add("merged_lines", merged);

    // Token-level three-way, only for the single-line-each case where it is
    // well defined and cheap.
    if (base.length === 1 && ours.length === 1 && theirs.length === 1) {
      const merges = threeWay(tokenize(base[0]), tokenize(ours[0]), tokenize(theirs[0]));
      for (const m of merges) add("merged_tokens", [m.join("")]);
    }
  }

  // An empty resolution is only worth offering when a side actually deleted.
  if (ours.length && theirs.length) found.delete(key([]));

  return [...found.values()].map((c, i) => ({ ...c, id: `c${i}` }));
}
