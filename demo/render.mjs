/**
 * Turn captured terminal output into an animated GIF.
 *
 * Everything it renders came out of a real run — demo/capture.sh records the
 * commands, this only draws them. Nothing here invents output, which is the
 * point: a demo you hand-wrote is a mockup, not a demo.
 *
 *   node demo/render.mjs <capture-dir> <out.gif>
 */

import { createCanvas } from "@napi-rs/canvas";
import gifenc from "gifenc"; // CommonJS: no named exports through the ESM bridge
const { GIFEncoder, applyPalette, quantize } = gifenc;
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [capDir, outPath] = process.argv.slice(2);
if (!capDir || !outPath) throw new Error("usage: render.mjs <capture-dir> <out.gif>");

// ---------------------------------------------------------------- appearance

const W = 940;
const H = 620;
const PAD = 22;
const TITLEBAR = 38;
const FONT_SIZE = 15;
const LINE = 23;
const FONT = `${FONT_SIZE}px Consolas, "DejaVu Sans Mono", monospace`;

const BG = "#0a0d13";
const WINDOW = "#0f131c";
const CHROME = "#171d29";
const EDGE = "#222b3a";
const FG = "#c9d4e4";

/** Terminal palette, keyed by SGR code. */
const SGR = {
  31: "#f07178",
  32: "#8ed69b",
  33: "#e6c07b",
  34: "#7aa2f7",
  35: "#c792ea",
  36: "#5fc9d8",
  90: "#5f6b80",
  94: "#7aa2f7",
};

// -------------------------------------------------------------------- parsing

/** Split a line carrying SGR escapes into styled runs. */
function parseAnsi(line) {
  const runs = [];
  let colour = null;
  let bold = false;
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) runs.push({ t: line.slice(last, m.index), colour, bold });
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (const code of codes) {
      if (code === 0) {
        colour = null;
        bold = false;
      } else if (code === 1) bold = true;
      else if (SGR[code]) colour = SGR[code];
    }
    last = re.lastIndex;
  }
  if (last < line.length) runs.push({ t: line.slice(last), colour, bold });
  return runs.filter((r) => r.t.length);
}

const read = (n) => {
  try {
    return readFileSync(join(capDir, n), "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  } catch {
    return "";
  }
};

const STEPS = [
  { cmd: "git merge feature/checkout", file: "01.txt" },
  { cmd: "jevmerge --apply", file: "02.txt" },
  { cmd: "head -8 package.json", file: "03.txt" },
  { cmd: "sed -n '1,4p' server.js", file: "04.txt" },
];

// ------------------------------------------------------------------- timeline

/**
 * A screen is a list of rendered lines plus, optionally, a command still being
 * typed. Each entry carries its own delay, so a pause costs one frame rather
 * than thirty identical ones.
 */
const screens = [];
const lines = [];

const promptRuns = (typed, caret) => [
  { t: "~/shop", colour: SGR[36], bold: true },
  { t: " $ ", colour: SGR[90] },
  { t: typed, colour: null, bold: true },
  ...(caret ? [{ t: "█", colour: SGR[94] }] : []),
];

const push = (delay) => screens.push({ lines: lines.slice(), delay });

for (const [i, step] of STEPS.entries()) {
  if (i > 0) {
    lines.push([]);
    push(220);
  }

  // type the command
  lines.push(promptRuns("", true));
  push(260);
  for (let n = 1; n <= step.cmd.length; n += 2) {
    lines[lines.length - 1] = promptRuns(step.cmd.slice(0, n), true);
    push(38);
  }
  lines[lines.length - 1] = promptRuns(step.cmd, false);
  push(420);

  // reveal the output
  const body = read(step.file).split("\n");
  for (let n = 0; n < body.length; n += 2) {
    for (const l of body.slice(n, n + 2)) lines.push(parseAnsi(l));
    push(n + 2 >= body.length ? 900 : 60);
  }
}

lines.push([]);
lines.push([{ t: "  both branches' work survived, and the two real decisions were left alone", colour: SGR[90] }]);
push(3200);

// -------------------------------------------------------------------- drawing

const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");
ctx.font = FONT;
const CH = ctx.measureText("M").width;
const VISIBLE = Math.floor((H - TITLEBAR - PAD * 2) / LINE);

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawScreen(screen) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  roundRect(0.5, 0.5, W - 1, H - 1, 12);
  ctx.fillStyle = WINDOW;
  ctx.fill();
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 1;
  ctx.stroke();

  // title bar
  ctx.save();
  roundRect(0.5, 0.5, W - 1, H - 1, 12);
  ctx.clip();
  ctx.fillStyle = CHROME;
  ctx.fillRect(0, 0, W, TITLEBAR);
  ctx.restore();
  ctx.strokeStyle = EDGE;
  ctx.beginPath();
  ctx.moveTo(0, TITLEBAR + 0.5);
  ctx.lineTo(W, TITLEBAR + 0.5);
  ctx.stroke();

  for (const [i, colour] of ["#ec6a5e", "#f4bf4f", "#61c554"].entries()) {
    ctx.beginPath();
    ctx.arc(22 + i * 19, TITLEBAR / 2, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }

  ctx.font = `13px Consolas, monospace`;
  ctx.fillStyle = "#7c8899";
  ctx.textAlign = "center";
  ctx.fillText("jevmerge — resolve conflicts by enumeration and judgment", W / 2, TITLEBAR / 2 + 4.5);
  ctx.textAlign = "left";

  // body, scrolled to the tail
  ctx.font = FONT;
  const view = screen.lines.slice(-VISIBLE);
  let y = TITLEBAR + PAD + FONT_SIZE;
  for (const runs of view) {
    let x = PAD;
    for (const run of runs) {
      ctx.font = run.bold ? `bold ${FONT}` : FONT;
      ctx.fillStyle = run.colour ?? FG;
      ctx.fillText(run.t, x, y);
      x += run.t.length * CH;
    }
    y += LINE;
  }
}

// ------------------------------------------------------------------- encoding

process.stderr.write(`${screens.length} frames, ${VISIBLE} visible lines\n`);

// One palette for the whole animation, sampled across it so nothing that only
// appears late gets quantised away.
const samples = [];
for (let i = 0; i < screens.length; i += Math.max(1, Math.ceil(screens.length / 10))) {
  drawScreen(screens[i]);
  samples.push(ctx.getImageData(0, 0, W, H).data);
}
drawScreen(screens[screens.length - 1]);
samples.push(ctx.getImageData(0, 0, W, H).data);

const merged = new Uint8ClampedArray(samples.reduce((n, s) => n + s.length, 0));
let at = 0;
for (const s of samples) {
  merged.set(s, at);
  at += s.length;
}
const palette = quantize(merged, 256, { format: "rgb565" });
process.stderr.write(`palette: ${palette.length} colours\n`);

if (process.env.DUMP_FRAMES) {
  for (const n of process.env.DUMP_FRAMES.split(",").map(Number)) {
    drawScreen(screens[Math.min(n, screens.length - 1)]);
    writeFileSync(`${outPath}.${n}.png`, canvas.toBuffer("image/png"));
  }
  process.exit(0);
}

const gif = GIFEncoder();
for (const [i, screen] of screens.entries()) {
  drawScreen(screen);
  const data = ctx.getImageData(0, 0, W, H).data;
  const index = applyPalette(data, palette, "rgb565");
  gif.writeFrame(index, W, H, {
    palette: i === 0 ? palette : undefined,
    delay: screen.delay,
    repeat: 0,
    transparent: false,
  });
  if (i % 25 === 0) process.stderr.write(`  ${i}/${screens.length}\n`);
}
gif.finish();

writeFileSync(outPath, Buffer.from(gif.bytes()));
const total = screens.reduce((n, s) => n + s.delay, 0);
process.stderr.write(
  `wrote ${outPath} — ${(Buffer.from(gif.bytes()).length / 1e6).toFixed(2)} MB, ${(total / 1000).toFixed(1)}s\n`
);
