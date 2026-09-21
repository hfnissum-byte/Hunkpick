/**
 * Minimal System One client. One endpoint, retries on the two statuses that
 * are worth retrying, and no dependencies.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function readDotEnv() {
  for (const dir of [HERE, join(HERE, "..")]) {
    try {
      const out = {};
      for (const line of readFileSync(join(dir, ".env"), "utf8").split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
      }
      if (Object.keys(out).length) return out;
    } catch {
      // try the next location
    }
  }
  return {};
}

const env = readDotEnv();

export const API_KEY = process.env.TYPESAFE_API_KEY || env.TYPESAFE_API_KEY;
export const MODEL =
  process.env.TYPESAFE_DEFAULT_MODEL || env.TYPESAFE_DEFAULT_MODEL || "jev-latest";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function systemOne(payload, { attempts = 4, timeoutMs = 90000 } = {}) {
  if (!API_KEY) throw new Error("No TYPESAFE_API_KEY — put one in .env next to jevmerge.mjs");

  let wait = 1000;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt >= attempts) throw new Error(`Network error talking to TypeSafe: ${err.message}`);
      await sleep(wait);
      wait *= 2;
      continue;
    }

    if (res.ok) return res.json();

    const body = await res.text().catch(() => "");
    if ((res.status === 429 || res.status === 529) && attempt < attempts) {
      await sleep(wait);
      wait *= 2;
      continue;
    }
    const hint = res.status === 401 ? " — the API key was rejected." : "";
    throw new Error(`TypeSafe HTTP ${res.status}${hint} ${body.slice(0, 400)}`);
  }
}
