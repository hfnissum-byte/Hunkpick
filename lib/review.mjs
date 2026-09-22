/**
 * Interactive review: walk the conflicts one at a time and write only what the
 * user accepts.
 *
 * The tool resolves about three in four conflicts correctly, so the README has
 * to say "read the diff afterwards". Reading a diff is the slow way to check a
 * decision the tool already has the context for — it knows the candidates,
 * their probabilities and which one it picked. This puts that in front of you
 * at the moment of the decision instead.
 *
 * Everything except `drive()` is pure. buildDecisions, reduce and renderScreen
 * take state and return state or strings, which is what makes a terminal UI
 * testable without a terminal.
 */

import { bar, c, truncate } from "./ui.mjs";

const KEYBAR = [
  ["enter", "accept"],
  ["j/k", "candidate"],
  ["s", "skip"],
  ["u", "undo"],
  ["n", "next file"],
  ["q", "done"],
];

/**
 * Flatten the CLI's `files` array into one ordered list of things to decide.
 * A decision is a hunk with candidates, or a whole-file structural merge.
 */
export function buildDecisions(files) {
  const out = [];
  for (const file of files) {
    if (file.structural) {
      out.push({
        ref: file,
        type: "file",
        path: file.path,
        lines: file.structural.merged.text.split(/\r?\n/),
        added: file.structural.merged.added,
        verdict: file.outcome?.verdict ?? null,
        recommended: file.outcome?.resolved ? 0 : -1,
        candidates: [{ id: "structural", kind: "structural", lines: null }],
      });
      continue;
    }
    for (const entry of file.hunks) {
      const v = entry.outcome?.verdict ?? null;
      const probs = v?.probabilities ?? {};
      // Highest probability first: the order you would read them in.
      const candidates = [...entry.candidates].sort(
        (a, b) => (probs[b.id] ?? 0) - (probs[a.id] ?? 0)
      );
      out.push({
        ref: entry,
        type: "hunk",
        path: file.path,
        hunkId: entry.hunk.id,
        line: entry.hunk.line,
        hunk: entry.hunk,
        context: entry.context,
        candidates,
        probs,
        verdict: v,
        reason: entry.outcome?.reason ?? null,
        // Pre-select what the batch mode would have done, so accepting
        // everything reproduces --apply exactly.
        recommended: Math.max(
          0,
          candidates.findIndex((x) => x.id === v?.candidateId)
        ),
        wouldApply: !!entry.outcome?.resolved,
        noMatch: !!entry.outcome?.noMatch,
      });
    }
  }
  return out;
}

export function initialState(decisions) {
  return {
    decisions,
    at: 0,
    cursor: decisions[0]?.recommended ?? 0,
    choices: new Array(decisions.length).fill(null),
    done: decisions.length === 0,
    quit: false,
  };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Move to `at`, re-selecting that decision's recommended candidate. */
function goTo(state, at) {
  if (at >= state.decisions.length) return { ...state, at: state.decisions.length, done: true };
  return { ...state, at, cursor: Math.max(0, state.decisions[at].recommended), done: false };
}

/**
 * Pure state machine. Actions: up, down, accept, skip, undo, nextFile, quit.
 */
export function reduce(state, action) {
  if (state.done || state.quit) return state;
  const d = state.decisions[state.at];
  if (!d) return { ...state, done: true };

  switch (action) {
    case "up":
      return { ...state, cursor: clamp(state.cursor - 1, 0, d.candidates.length - 1) };
    case "down":
      return { ...state, cursor: clamp(state.cursor + 1, 0, d.candidates.length - 1) };

    case "accept": {
      if (!d.candidates.length) return reduce(state, "skip");
      const choices = state.choices.slice();
      choices[state.at] = { action: "accept", candidate: state.cursor };
      return goTo({ ...state, choices }, state.at + 1);
    }

    case "skip": {
      const choices = state.choices.slice();
      choices[state.at] = { action: "skip" };
      return goTo({ ...state, choices }, state.at + 1);
    }

    case "undo": {
      // Step back to the last decision that was actually decided and clear it.
      let i = Math.min(state.at, state.decisions.length) - 1;
      while (i >= 0 && !state.choices[i]) i--;
      if (i < 0) return state;
      const choices = state.choices.slice();
      choices[i] = null;
      return goTo({ ...state, choices }, i);
    }

    case "nextFile": {
      let i = state.at;
      const here = d.path;
      const choices = state.choices.slice();
      while (i < state.decisions.length && state.decisions[i].path === here) {
        if (!choices[i]) choices[i] = { action: "skip" };
        i++;
      }
      return goTo({ ...state, choices }, i);
    }

    case "quit":
      return { ...state, quit: true };

    default:
      return state;
  }
}

/** What the user accepted, as {path -> {hunkId -> lines}} plus whole files. */
export function resolutions(state) {
  const hunks = new Map();
  const wholeFiles = new Map();
  state.choices.forEach((choice, i) => {
    if (choice?.action !== "accept") return;
    const d = state.decisions[i];
    if (d.type === "file") {
      wholeFiles.set(d.path, d.lines.join("\n"));
      return;
    }
    const picked = d.candidates[choice.candidate];
    if (!picked) return;
    if (!hunks.has(d.path)) hunks.set(d.path, {});
    hunks.get(d.path)[d.hunkId] = picked.lines;
  });
  return { hunks, wholeFiles };
}

export function counts(state) {
  let accepted = 0;
  let skipped = 0;
  for (const ch of state.choices) {
    if (ch?.action === "accept") accepted++;
    else if (ch?.action === "skip") skipped++;
  }
  return { accepted, skipped, total: state.decisions.length };
}

// ------------------------------------------------------------------ rendering

const rule = (n) => c.dim("─".repeat(Math.max(0, n)));

function sideLines(label, lines, cols) {
  if (!lines || !lines.length) return [`  ${c.dim(label.padEnd(8))}${c.dim("(empty)")}`];
  return lines.slice(0, 6).map((l, i) => {
    const tag = i === 0 ? c.dim(label.padEnd(8)) : " ".repeat(8);
    return truncate(`  ${tag}${l}`, cols);
  });
}

/**
 * Pad or trim to exactly `rows` lines, with `footer` pinned to the last one.
 *
 * Exactness matters: the driver repaints with home + erase-to-end-of-line, so
 * a frame shorter than the screen leaves the tail of the previous frame
 * showing, and a longer one scrolls and desynchronises every row after it.
 */
function frame(out, rows, footer, cols) {
  const body = footer == null ? out : out.slice(0, Math.max(0, rows - 1));
  const lines = body.slice(0, rows);
  while (lines.length < (footer == null ? rows : rows - 1)) lines.push("");
  if (footer != null) lines.push(footer);
  // Truncation belongs here rather than only in the driver: the render
  // function owns the layout, and anything reading it should get lines that
  // already fit.
  return lines.slice(0, rows).map((l) => truncate(l, cols));
}

/** Drop key hints from the right until the bar fits. */
function keyBar(cols) {
  for (let n = KEYBAR.length; n > 0; n--) {
    const bar = "  " + KEYBAR.slice(0, n).map(([k, what]) => `[${k}] ${what}`).join("   ");
    if (bar.length <= cols) return c.dim(bar);
  }
  return "";
}

/**
 * Render one screen. Pure: same state and size always give the same lines.
 */
export function renderScreen(state, { columns = 80, rows = 24 } = {}) {
  const cols = Math.max(40, columns - 1);
  const out = [];
  const { accepted, skipped, total } = counts(state);

  if (columns < 60 || rows < 14) {
    return frame(
      ["", `  Terminal too small: need 60x14, have ${columns}x${rows}.`],
      rows,
      null,
      columns
    );
  }

  if (state.done || state.quit || state.at >= state.decisions.length) {
    out.push("");
    out.push(`  ${c.bold("Done.")}  ${c.green(`${accepted} accepted`)}, ${skipped} skipped, of ${total}.`);
    out.push("");
    out.push(c.dim("  Accepted resolutions will be written. Nothing is staged or committed."));
    return frame(out, rows, null, columns);
  }

  const d = state.decisions[state.at];
  const sameFile = state.decisions.filter((x) => x.path === d.path);
  const posInFile = sameFile.indexOf(d) + 1;

  out.push("");
  out.push(
    `  ${c.bold(c.cyan(d.path))}  ${c.dim("·")}  ` +
      (d.type === "file"
        ? c.dim("whole file")
        : c.dim(`hunk ${posInFile} of ${sameFile.length}, line ${d.line}`)) +
      `  ${c.dim("·")}  ${c.dim(`${state.at + 1}/${total}`)}  ` +
      c.dim(`(${accepted} accepted, ${skipped} skipped)`)
  );
  out.push("");

  if (d.type === "file") {
    out.push(`  ${c.magenta("merged by key")}`);
    out.push(
      d.added.length
        ? `  ${c.dim("gains:")} ${c.green(d.added.join(", "))}`
        : `  ${c.dim("no keys gained")}`
    );
    out.push("");
    for (const l of d.lines.slice(0, Math.max(4, rows - 14))) out.push(truncate(`    ${l}`, cols));
    if (d.lines.length > rows - 14) out.push(c.dim(`    … ${d.lines.length - (rows - 14)} more lines`));
  } else {
    for (const l of d.context.before.slice(-2)) out.push(c.dim(truncate(`      ${l}`, cols)));
    out.push(`  ${rule(cols - 2)}`);
    out.push(...sideLines("base", d.hunk.hasBase ? d.hunk.base : null, cols));
    out.push(...sideLines("ours", d.hunk.ours, cols));
    out.push(...sideLines("theirs", d.hunk.theirs, cols));
    out.push(`  ${rule(cols - 2)}`);
    for (const l of d.context.after.slice(0, 2)) out.push(c.dim(truncate(`      ${l}`, cols)));
  }

  out.push("");

  if (d.type === "hunk") {
    if (!d.candidates.length) {
      out.push(`  ${c.yellow("No candidate resolution parses here.")}`);
      out.push(`  ${c.dim(d.reason ?? "")}`);
    } else {
      // When the model answered no-match, that is the most important thing on
      // the screen and it belongs above the list, not in a dim line under it.
      // The candidates are still shown: overriding the model is the point of
      // reviewing, and the cursor has to start somewhere.
      if (d.noMatch) {
        out.push(`  ${c.yellow("the model's answer: none of these is the resolution")}`);
        out.push("");
      }
      for (const [i, cand] of d.candidates.entries()) {
        const p = d.probs[cand.id] ?? 0;
        const picked = i === state.cursor;
        const marker = picked ? c.green("▸") : " ";
        const kind = picked ? c.bold(cand.kind.padEnd(15)) : c.dim(cand.kind.padEnd(15));
        const first = cand.lines.length ? cand.lines[0] : c.dim("(deletes the region)");
        const more = cand.lines.length > 1 ? c.dim(` +${cand.lines.length - 1}`) : "";
        out.push(truncate(`  ${marker} ${kind}${p.toFixed(2)}  ${first}${more}`, cols));
      }
    }
  } else {
    const p = d.verdict?.correct ?? 0;
    out.push(`  ${state.cursor === 0 ? c.green("▸") : " "} ${c.bold("apply this merge")}  ${p.toFixed(2)}`);
  }

  out.push("");
  if (d.verdict?.safe != null) {
    out.push(
      `  ${c.dim("mechanical")} ${bar(d.verdict.safe, 0.25)} ${d.verdict.safe.toFixed(2)}` +
        (d.verdict.safe < 0.25 ? c.yellow("   a person should decide this") : "")
    );
  }
  // The no-match case already said its piece above the list; repeating the
  // same sentence in dim text under it is noise.
  if (!d.wouldApply && !d.noMatch && d.reason && d.candidates.length) {
    out.push(`  ${c.dim(`batch mode would leave this: ${d.reason}`)}`);
  }

  return frame(out, rows, keyBar(columns), columns);
}

// -------------------------------------------------------------------- driver

/** Decode a raw keypress into an action name, or null. */
export function keyToAction(seq) {
  switch (seq) {
    case "\r":
    case "\n":
      return "accept";
    case "j":
    case "[B":
      return "down";
    case "k":
    case "[A":
      return "up";
    case "s":
      return "skip";
    case "u":
      return "undo";
    case "n":
      return "nextFile";
    case "q":
    case "": // ctrl-c: raw mode does not raise SIGINT, so handle it here
      return "quit";
    default:
      return null;
  }
}

const ALT_ON = "[?1049h[?25l";
const ALT_OFF = "[?25h[?1049l";
const HOME = "[H";
const EL = "[K"; // erase to end of line

/**
 * Split a chunk into individual keys, keeping any partial escape sequence for
 * the next chunk.
 *
 * Raw stdin can deliver "" and "[A" in separate reads, and a one-shot
 * switch on the chunk turns one arrow key into a stray escape plus two
 * letters. Only shows up over ssh or under load, so it has to be designed for
 * rather than discovered.
 */
export function createDecoder() {
  let pending = "";
  return function decode(chunk) {
    const s = pending + chunk;
    pending = "";
    const keys = [];
    for (let i = 0; i < s.length; ) {
      if (s[i] !== "") {
        keys.push(s[i]);
        i += 1;
        continue;
      }
      // A CSI sequence is ESC [ ... final-byte. If it is not all here yet,
      // hold it and wait for the rest.
      const m = /^\[[0-9;]*[A-Za-z~]/.exec(s.slice(i));
      if (m) {
        keys.push(m[0]);
        i += m[0].length;
        continue;
      }
      if (s.length - i <= 3) {
        pending = s.slice(i);
        break;
      }
      keys.push(s[i]);
      i += 1;
    }
    return keys;
  };
}

/**
 * Run the loop against a real terminal. Resolves with the final state.
 *
 * Requires a TTY. Callers check first and fall back, because a piped stdin
 * here would wait for keys that never arrive.
 */
export function drive(state, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const decode = createDecoder();
    let torn = false;

    const draw = () => {
      const rows = output.rows || 24;
      const columns = output.columns || 80;
      const lines = renderScreen(state, { columns, rows });
      // Home plus erase-to-end-of-line overwrites in place. A full 2J clears
      // first and shows as a flash on conhost. One write per frame, because
      // several writes is what people actually see as flicker.
      const frame = lines.map((l) => truncate(l, columns) + EL).join("\r\n");
      output.write(HOME + frame);
    };

    // Must be safe to call twice, and must run even on a crash: a leaked
    // "[?25l" leaves the user with an invisible cursor and no idea why.
    const teardown = () => {
      if (torn) return;
      torn = true;
      input.off("data", onData);
      output.off("resize", draw);
      process.off("exit", teardown);
      process.off("uncaughtException", onCrash);
      if (input.isTTY && input.setRawMode) input.setRawMode(false);
      input.pause();
      output.write(ALT_OFF);
    };

    const onCrash = (err) => {
      teardown();
      throw err;
    };

    const onData = (buf) => {
      for (const seq of decode(buf.toString("utf8"))) {
        const action = keyToAction(seq);
        if (action) state = reduce(state, action);
      }
      draw();
      if (state.done || state.quit) {
        teardown();
        resolve(state);
      }
    };

    process.on("exit", teardown);
    process.on("uncaughtException", onCrash);
    if (input.isTTY && input.setRawMode) input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    output.on("resize", draw);
    output.write(ALT_ON);
    draw();
  });
}
