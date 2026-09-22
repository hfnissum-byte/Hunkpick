/**
 * Terminal colour and small drawing helpers, shared by the batch report and
 * the interactive review mode so there is one definition of each.
 */

/**
 * Colour on a TTY, plain text otherwise. NO_COLOR disables it; FORCE_COLOR=1
 * forces it on, which is how the demo capture gets colour through a pipe.
 */
export const COLOUR =
  !process.env.NO_COLOR && (process.env.FORCE_COLOR === "1" || process.stdout.isTTY === true);

const wrap = (code) => (s) => (COLOUR ? `[${code}m${s}[0m` : String(s));

export const c = {
  green: wrap(32),
  yellow: wrap(33),
  red: wrap(31),
  blue: wrap(94),
  magenta: wrap(35),
  cyan: wrap(36),
  dim: wrap(90),
  bold: wrap(1),
  invert: wrap(7),
};

/** Green once it is over the line, amber near it, red well below. */
export const tint = (p, gate) => (p >= gate ? c.green : p >= gate * 0.7 ? c.yellow : c.red);

export const bar = (p, gate = 0.75, neutral = false) => {
  const n = Math.max(0, Math.min(10, Math.round(p * 10)));
  const fill = neutral ? c.dim : tint(p, gate);
  return fill("█".repeat(n)) + c.dim("·".repeat(10 - n));
};

/**
 * Visible width of a string, ignoring SGR escapes. Used for truncation, where
 * counting escape bytes as characters would cut the line far too short.
 */
export function width(s) {
  return s.replace(/\[[0-9;]*m/g, "").length;
}

/**
 * Truncate to `max` visible columns, keeping escapes intact and closing any
 * style that was left open.
 */
export function truncate(s, max) {
  if (width(s) <= max) return s;
  let out = "";
  let seen = 0;
  const re = /(\[[0-9;]*m)|([^]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) {
      out += m[1];
      continue;
    }
    const room = max - 1 - seen;
    if (room <= 0) break;
    const take = m[2].slice(0, room);
    out += take;
    seen += take.length;
    if (take.length < m[2].length) break;
  }
  return `${out}…${COLOUR ? "[0m" : ""}`;
}
