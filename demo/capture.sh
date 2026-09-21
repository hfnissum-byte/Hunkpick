#!/usr/bin/env bash
# Build a small repo with four conflicts of four different shapes, run the real
# commands, and save their real output for demo/render.mjs to draw.
#
#   bash demo/capture.sh /tmp/hunkpick-demo
#   node demo/render.mjs /tmp/hunkpick-demo/cap demo/hunkpick.gif
#
# The four shapes, one per mechanism:
#   cart.js       both sides changed one line compatibly   -> token merge
#   server.js     both sides added an import               -> union
#   server.js     both sides set a different timeout       -> a real decision
#   package.json  both sides added a dependency            -> structural merge
set -euo pipefail

OUT="${1:-/tmp/hunkpick-demo}"
HUNKPICK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/hunkpick.mjs"

rm -rf "$OUT"
mkdir -p "$OUT/repo" "$OUT/cap"
cd "$OUT/repo"

git init -q .
git config user.email dev@shop.io
git config user.name Dev
git config core.autocrlf false
git config advice.detachedHead false

write_base() {
  cat > cart.js <<'JS'
function total(items) {
  let sum = 0;
  for (const it of items) sum += it.price;
  return sum;
}
module.exports = { total };
JS
  cat > server.js <<'JS'
import http from "http";

const TIMEOUT = 5000;

export function serve(app) {
  return http.createServer(app).listen(3000);
}
JS
  cat > package.json <<'JSON'
{
  "name": "shop",
  "version": "2.1.0",
  "dependencies": {
    "express": "4.19.2"
  }
}
JSON
}

write_base
git add -A && git commit -qm "base"

git checkout -qb feature/checkout
cat > cart.js <<'JS'
function total(items) {
  let sum = 0;
  for (const it of items) sum += it.price * (1 + TAX);
  return sum;
}
module.exports = { total };
JS
cat > server.js <<'JS'
import http from "http";
import crypto from "crypto";

const TIMEOUT = 30000;

export function serve(app) {
  return http.createServer(app).listen(3000);
}
JS
cat > package.json <<'JSON'
{
  "name": "shop",
  "version": "2.1.0",
  "dependencies": {
    "express": "4.19.2",
    "stripe": "14.0.0"
  }
}
JSON
git add -A && git commit -qm "checkout: add tax, stripe, longer timeout for card auth"

git checkout -q master 2>/dev/null || git checkout -q main
cat > cart.js <<'JS'
function total(items) {
  let sum = 0;
  for (const it of items) sum += it.price * it.qty;
  return sum;
}
module.exports = { total };
JS
cat > server.js <<'JS'
import http from "http";
import fs from "fs";

const TIMEOUT = 1000;

export function serve(app) {
  return http.createServer(app).listen(3000);
}
JS
cat > package.json <<'JSON'
{
  "name": "shop",
  "version": "2.1.0",
  "dependencies": {
    "express": "4.19.2",
    "pino": "9.0.0"
  }
}
JSON
git add -A && git commit -qm "cart: multiply by quantity; add logging"

# Every command below is the real thing, and its real output is what gets drawn.
git merge feature/checkout > "$OUT/cap/01.txt" 2>&1 || true
FORCE_COLOR=1 node "$HUNKPICK" > "$OUT/cap/dry.txt" 2>&1 || true
FORCE_COLOR=1 node "$HUNKPICK" --apply > "$OUT/cap/02.txt" 2>&1 || true
head -8 package.json > "$OUT/cap/03.txt" 2>&1
sed -n '1,4p' server.js > "$OUT/cap/04.txt" 2>&1

echo "captured to $OUT/cap"
echo
echo "  node demo/render.mjs $OUT/cap demo/hunkpick.gif"
echo "  node demo/svg.mjs    $OUT/cap/dry.txt demo/output.svg"
