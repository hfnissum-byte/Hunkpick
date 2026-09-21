/**
 * Draw captured terminal output as a standalone SVG, for embedding in the
 * README where a grey code block would otherwise sit next to the colour GIF.
 *
 *   node demo/svg.mjs <capture.txt> <out.svg>
 *
 * Each line becomes one <text> with a <tspan> per colour run, and nothing is
 * positioned horizontally by hand. The browser lays the runs out in its own
 * monospace font, so columns stay aligned regardless of which font resolves.
 * Absolute x coordinates would not survive a font substitution.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) throw new Error("usage: svg.mjs <capture.txt> <out.svg>");

const FONT_SIZE = 14;
const LINE = 21;
const PAD_X = 20;
const PAD_Y = 18;
const ADVANCE = 8.4; // only used to size the canvas, never to place text

const BG = "#0f131c";
const EDGE = "#222b3a";
const FG = "#c9d4e4";

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

const escape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function parseAnsi(line) {
  const runs = [];
  let colour = null;
  let bold = false;
  const re = /\[([0-9;]*)m/g;
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

const raw = readFileSync(inPath, "utf8").replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
const lines = raw.split("\n").map(parseAnsi);

const widest = Math.max(...lines.map((runs) => runs.reduce((n, r) => n + r.t.length, 0)));
const W = Math.ceil(widest * ADVANCE + PAD_X * 2);
const H = lines.length * LINE + PAD_Y * 2;

const body = lines
  .map((runs, i) => {
    if (!runs.length) return "";
    const y = PAD_Y + FONT_SIZE + i * LINE;
    const spans = runs
      .map((r) => {
        const style = [r.colour ? `fill="${r.colour}"` : "", r.bold ? 'font-weight="600"' : ""]
          .filter(Boolean)
          .join(" ");
        return style ? `<tspan ${style}>${escape(r.t)}</tspan>` : escape(r.t);
      })
      .join("");
    return `  <text x="${PAD_X}" y="${y}" xml:space="preserve">${spans}</text>`;
  })
  .filter(Boolean)
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="jevmerge output: two conflicts resolved, two left for a person">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${BG}" stroke="${EDGE}"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}" fill="${FG}">
${body}
  </g>
</svg>
`;

writeFileSync(outPath, svg);
process.stderr.write(`wrote ${outPath} — ${W}x${H}, ${lines.length} lines\n`);
