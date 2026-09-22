/**
 * Draw terminal frames into an animated GIF.
 *
 * Shared by the two recordings: the batch report, which appends lines as
 * commands run, and the review UI, which repaints a whole screen per
 * keystroke. Both are just arrays of ANSI-coloured lines with a delay.
 */

import { writeFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import gifenc from "gifenc"; // CommonJS: no named exports through the ESM bridge
const { GIFEncoder, applyPalette, quantize } = gifenc;

export const FONT_SIZE = 15;
export const LINE = 23;
export const PAD = 22;
export const TITLEBAR = 38;

const FONT = `${FONT_SIZE}px Consolas, "DejaVu Sans Mono", monospace`;

export const THEME = {
  bg: "#0a0d13",
  window: "#0f131c",
  chrome: "#171d29",
  edge: "#222b3a",
  fg: "#c9d4e4",
};

/** Terminal palette, keyed by SGR code. */
export const SGR = {
  31: "#f07178",
  32: "#8ed69b",
  33: "#e6c07b",
  34: "#7aa2f7",
  35: "#c792ea",
  36: "#5fc9d8",
  90: "#5f6b80",
  94: "#7aa2f7",
};

/** Split a line carrying SGR escapes into styled runs. */
export function parseAnsi(line) {
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
      else if (code === 7) bold = true;
      else if (SGR[code]) colour = SGR[code];
    }
    last = re.lastIndex;
  }
  if (last < line.length) runs.push({ t: line.slice(last), colour, bold });
  return runs.filter((r) => r.t.length);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * @param {Array<{lines: string[], delay: number}>} frames
 * @param {string} outPath
 * @param {{columns: number, rows: number, title: string}} opts
 */
export function framesToGif(frames, outPath, { columns, rows, title }) {
  const probe = createCanvas(10, 10).getContext("2d");
  probe.font = FONT;
  const CH = probe.measureText("M").width;

  const W = Math.ceil(columns * CH + PAD * 2);
  const H = rows * LINE + TITLEBAR + PAD * 2;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const draw = (lines) => {
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, W, H);

    roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 12);
    ctx.fillStyle = THEME.window;
    ctx.fill();
    ctx.strokeStyle = THEME.edge;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 12);
    ctx.clip();
    ctx.fillStyle = THEME.chrome;
    ctx.fillRect(0, 0, W, TITLEBAR);
    ctx.restore();

    ctx.strokeStyle = THEME.edge;
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

    ctx.font = "13px Consolas, monospace";
    ctx.fillStyle = "#7c8899";
    ctx.textAlign = "center";
    ctx.fillText(title, W / 2, TITLEBAR / 2 + 4.5);
    ctx.textAlign = "left";

    ctx.font = FONT;
    let y = TITLEBAR + PAD + FONT_SIZE;
    for (const line of lines.slice(0, rows)) {
      let x = PAD;
      for (const run of parseAnsi(line)) {
        ctx.font = run.bold ? `bold ${FONT}` : FONT;
        ctx.fillStyle = run.colour ?? THEME.fg;
        ctx.fillText(run.t, x, y);
        x += run.t.length * CH;
      }
      y += LINE;
    }
  };

  // One palette for the whole animation, sampled across it so nothing that
  // only appears late gets quantised away.
  const samples = [];
  const step = Math.max(1, Math.ceil(frames.length / 10));
  for (let i = 0; i < frames.length; i += step) {
    draw(frames[i].lines);
    samples.push(ctx.getImageData(0, 0, W, H).data);
  }
  draw(frames[frames.length - 1].lines);
  samples.push(ctx.getImageData(0, 0, W, H).data);

  const merged = new Uint8ClampedArray(samples.reduce((n, s) => n + s.length, 0));
  let at = 0;
  for (const s of samples) {
    merged.set(s, at);
    at += s.length;
  }
  const palette = quantize(merged, 256, { format: "rgb565" });

  const gif = GIFEncoder();
  for (const [i, f] of frames.entries()) {
    draw(f.lines);
    const index = applyPalette(ctx.getImageData(0, 0, W, H).data, palette, "rgb565");
    gif.writeFrame(index, W, H, {
      palette: i === 0 ? palette : undefined,
      delay: f.delay,
      repeat: 0,
      transparent: false,
    });
  }
  gif.finish();

  const bytes = Buffer.from(gif.bytes());
  writeFileSync(outPath, bytes);
  return { width: W, height: H, bytes: bytes.length, frames: frames.length };
}
