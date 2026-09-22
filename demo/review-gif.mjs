/**
 * Record the review UI as a GIF.
 *
 *   bash demo/capture.sh /tmp/hunkpick-demo
 *   node demo/review-gif.mjs /tmp/hunkpick-demo/repo demo/review.gif
 *
 * The frames come from the real renderScreen, over real conflicts, with real
 * verdicts from the model — the same collectFiles and applyGates the CLI runs.
 * Only the keystrokes are scripted, because raw-mode input cannot be driven
 * from a process without a terminal. So the recording shows what the UI
 * actually draws, for a session someone could have had.
 */

import { conflictedPaths, mergeContext } from "../lib/git.mjs";
import { judge } from "../lib/judge.mjs";
import { applyGates, collectFiles, countDecisions } from "../lib/pipeline.mjs";
import { buildDecisions, initialState, reduce, renderScreen } from "../lib/review.mjs";
import { framesToGif } from "./termgif.mjs";

const [repo, outPath] = process.argv.slice(2);
if (!repo || !outPath) throw new Error("usage: review-gif.mjs <repo> <out.gif>");

const COLUMNS = 92;
const ROWS = 26;

/**
 * The session to play back. `hold` is how long the frame stays up, in ms:
 * long enough to read a new conflict, short enough that a cursor move does
 * not feel like a pause.
 */
const SCRIPT = [
  { action: null, hold: 2400 }, // the first conflict, as it opens
  { action: "down", hold: 900 }, // look at another candidate
  { action: "up", hold: 900 }, // back to the model's pick
  { action: "skip", hold: 2200 }, // leave it: the model said no candidate fits
  { action: "accept", hold: 2000 }, // package.json, merged by key
  { action: "accept", hold: 2200 }, // server.js imports, union
  { action: "down", hold: 1100 }, // the timeout conflict: consider ours
  { action: "skip", hold: 2600 }, // a real decision, so leave it
  { action: null, hold: 3600 }, // the summary
];

// Colour is decided at module load from stdout.isTTY, which is false here.
// Force it on so the recording has the colours a person would see.
if (!process.env.FORCE_COLOR) {
  console.error("run with FORCE_COLOR=1 so the frames carry colour");
  process.exit(2);
}

const paths = conflictedPaths(repo);
if (!paths.length) throw new Error(`no conflicts in ${repo}; run demo/capture.sh first`);

const opts = {
  context: 6,
  confidence: 0.55,
  safe: 0.25,
  all: false,
  kinds: new Set(["ours", "union", "merged_lines", "merged_tokens", "structural"]),
};

const { files, items } = collectFiles(paths, repo, opts);
if (!countDecisions(files)) throw new Error("no resolvable conflicts");

const merge = mergeContext(repo);
const { verdicts } = await judge(items, merge);
applyGates(files, verdicts, opts);

let state = initialState(buildDecisions(files));
const frames = [];
for (const step of SCRIPT) {
  if (step.action) state = reduce(state, step.action);
  frames.push({ lines: renderScreen(state, { columns: COLUMNS, rows: ROWS }), hold: step.hold });
}

// Typing is instant on screen, so each step is one frame held for its own
// duration rather than an animation.
const out = framesToGif(
  frames.map((f) => ({ lines: f.lines, delay: f.hold })),
  outPath,
  { columns: COLUMNS, rows: ROWS, title: "hunkpick --review" }
);

const seconds = frames.reduce((n, f) => n + f.hold, 0) / 1000;
process.stderr.write(
  `wrote ${outPath} — ${out.width}x${out.height}, ${out.frames} frames, ` +
    `${(out.bytes / 1e6).toFixed(2)} MB, ${seconds.toFixed(1)}s\n`
);
