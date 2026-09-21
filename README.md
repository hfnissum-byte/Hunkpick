# jevmerge

Resolve git merge conflicts by enumeration and judgment.

Code enumerates every resolution a conflict could legitimately have and throws out the
ones that do not parse. Jev picks among the survivors. Code decides whether the pick
was confident enough to keep.

The model never writes a resolution, so it cannot invent one. Everything it is allowed
to choose already parses in the context of the whole file. A wrong answer here is a bad
merge you review and reject — never a broken file.

![jevmerge resolving four conflicts](demo/jevmerge.gif)

Four conflicts, four shapes: a line both sides edited compatibly, an import each side
added, a dependency each side added, and a timeout they set to different values. It
merges the first three and hands back the fourth, because that one is a decision.

Every frame is real output. `demo/capture.sh` builds the repo and runs the commands;
`demo/render.mjs` only draws what they printed.

## Run

```bash
cd a-repo-with-conflicts
node path/to/jevmerge.mjs            # look, change nothing
node path/to/jevmerge.mjs --apply    # write the ones it is sure about
```

Nothing is written without `--apply`. Nothing is ever staged or committed. Conflicts it
does not resolve keep their markers exactly as they were.

```
cart.js
  LEAVE   line 3  merged_tokens   approach ██████████ 1.00   mechanical ███······· 0.29
           needs a person (0.29 below 0.45)
           │   for (const it of items) sum += it.price * (1 + TAX) * it.qty;

package.json
  RESOLVE whole file  merged by key   correct ████████·· 0.77
           gains from feature/checkout: dependencies.stripe

server.js
  RESOLVE line 2  union   approach ██████████ 0.95   mechanical ████████·· 0.81
           │ import fs from "fs";
           │ import crypto from "crypto";
  LEAVE   line 9  theirs   approach ████████·· 0.85   mechanical ██········ 0.15
           theirs is not an auto-applied kind
           │ const TIMEOUT = 30000;

jev-1.13.0 · 1 request(s) · 2623 in / 251 out
2/4 conflicts resolved, 2 left for you
```

The two it left are the interesting ones. On `server.js` both branches set the same
timeout, to 1s and 30s — there is no mechanical answer and `mechanical 0.15` says so.
On `cart.js` it found a token merge it was certain about as an *approach* (1.00), and
still declined, because combining a tax rate with a quantity multiplier changes what the
function computes. That is a decision, not a merge.

## How a conflict gets resolved

**1. Rebuild it with its ancestor.** The working-tree file only shows both sides. We
re-derive the conflict from the index stages — `:1:` base, `:2:` ours, `:3:` theirs —
through `git merge-file --diff3`, so every hunk carries what both sides started from.
Nothing in the working tree is touched to do it.

**2. Enumerate.** Per hunk: `ours`, `theirs`, `base`, `union` in both orders, `drop`,
and two merges — one over the hunk's *lines*, one over a line's *tokens*. The same
three-way algorithm runs at both granularities. The token pass is what catches the case
line-level merging cannot see:

```
base    sum += it.price;
ours    sum += it.price * it.qty;
theirs  sum += it.price * (1 + TAX);
→       sum += it.price * it.qty * (1 + TAX);
```

Neither side contains that line. Both intents survive in it.

**3. Validate.** Every candidate is rendered into the whole file and parsed, with all
other conflicts pinned to `ours` so only this hunk varies. A hunk that parses alone can
still break the file around it. Anything that fails is gone before the model sees it.

**4. Judge.** Two questions per conflict, every conflict in the repo in one request:

- **Choice** over the surviving candidates — which one keeps both sides' intent.
- **Noul** — or is this a decision a person has to make.

The second exists because confidence cannot express it. A conflict can have one
obviously best mechanical resolution and still be a real decision: two valid timeouts,
two valid defaults, a security check one side removed. High confidence, still not ours.

**5. Gate.** In code, never in the model. Both thresholds must clear.

## Structured files get merged by key

Line and token merges cannot fix the commonest conflict in a JS repo — two branches
adding a different key to `package.json` — because the correct result needs a comma that
appears in neither side. So `.json` files take a different path: parse all three stages,
three-way merge the objects, serialise once. Then a single Noul asks whether the merge
is right and safe to apply unreviewed.

If structure cannot settle it — two different values for one key, an ambiguous array
order, a key one side deleted and the other edited — it declines and the file falls back
to the line-level path. A merge that comes out identical to one side declines too: that
is a choice between the branches, and a Choice question puts it better.

## Options

| Flag | |
| --- | --- |
| `--apply` | write files; without it nothing is modified |
| `--confidence <0-1>` | minimum probability for the chosen approach (default 0.75) |
| `--safe <0-1>` | minimum "resolvable mechanically" Noul (default 0.45) |
| `--context <n>` | lines of surrounding context shown to the model (default 6) |
| `--kinds <a,b,…\|all>` | kinds allowed to apply unattended (see the benchmark below) |
| `--all` | resolve everything regardless of the gates |
| `--json` | machine-readable output |
| `--model <name>` | override the model |

Exit codes: `0` everything resolved, `1` some left for you, `2` nothing to do or an error.

## Why the gate uses approach mass, not confidence

Two orderings of a union are the same decision in different clothes. The Choice splits
its probability between them, which reads as doubt about the approach when it is only
doubt about the order. The first real conflict this was run against picked the right
resolution at 0.64, with its own mirror image as runner-up at 0.30 — the model was 0.94
sure of *what to do* and the gate could not see it.

So the gate sums probability across candidates of the same kind and tests that.
Marginalising a distribution over a partition of its outcomes is just arithmetic; the
pick within the kind is still the model's. `ours` and `theirs` are single-candidate
kinds, so nothing changes for them.

## Does it actually work

Replaying 25 real conflicted merges from `expressjs/express`. For each merge commit,
check out the first parent, merge the second, and compare against what the maintainers
committed. Nobody wrote that answer key to make this tool look good.

```bash
node bench/replay.mjs --repo /path/to/a/clone --max 25
```

Scoring is per conflict region, anchored on the stable lines either side, because a
merge commit contains plenty of edits that are not conflict resolution and comparing
whole files would measure the wrong thing.

**118 conflict regions with a recoverable answer.** 77% of the time the human's
resolution was among the candidates — enumeration covers most of what people actually
do. The other 23% no mechanical tool could have matched.

The first run allowed every kind, and the result was a coin flip:

| chosen kind | correct |
| --- | --- |
| `ours` | 5/5 — 100% |
| `merged_lines` | 19/23 — 83% |
| `union` | 2/3 — 67% |
| `theirs` | **0/17 — 0%** |
| `union_reversed` | **0/4 — 0%** |
| `base` | 0/1 |
| **overall** | **26/53 — 49%** |

`theirs` was chosen seventeen times and was wrong seventeen times. Refusing to apply it
and `union_reversed` takes precision from 49% to **81%** and costs *nothing* in recall,
because between them they never once produced a right answer. That is now the default,
and `--kinds all` puts them back.

The asymmetry makes sense from the ground truth: across reachable regions the humans
chose `ours` 55% of the time, `merged_lines` 27%, `theirs` only 10%. Express merges a
maintenance branch into a development branch and the development side nearly always
wins. A repository with different habits could well need `theirs` back — this is one
workflow's numbers, not a law.

**What it is not.** Even gated, it resolves a minority of conflicts — on a 10-merge
confirmation run, 5 of 7 auto-resolutions were right and it handed 82% of the reachable
ones back to a human. The judgment, not the enumeration, is the limit: in 17 regions the
answer was plainly `ours` and it did not take it. Treat `--apply` as a first pass that
clears the boring conflicts, and read the diff. It is not an unattended merge bot, and
the numbers above are the reason to say so rather than find out the hard way.

## Thresholds

Six identical runs over the same two-file merge, to see what actually moves:

| signal | range over 6 runs |
| --- | --- |
| structural merge, `correct` | 0.76 – 0.78 |
| two added imports, approach mass | 0.94 – 0.96 |
| two added imports, `mechanical` | **0.59 – 0.67** |
| 1s vs 30s timeout, `mechanical` | 0.15 – 0.17 |

Two things fall out of that. The Choice is steady and the Noul is the noisy one, so the
Noul is where a threshold gets into trouble. And the Noul separates the two cases
cleanly — about 0.16 against about 0.63 — which means the signal is fine and only the
threshold was misplaced. `--safe` started at 0.60, sitting inside the upper cluster, and
the same conflict resolved or did not depending on the run. It now defaults to 0.45,
in the gap, with roughly 0.14 of margin on each side.

That is calibrated against two clusters. It is a better guess, not a tuned value. Run it
over a batch of your own merges with `--json`, compare against what you would have done,
and move both numbers.

## Limits worth knowing

- **Only content conflicts.** Add/add, delete/modify and rename conflicts are reported
  and skipped — there is no text to enumerate over.
- **Syntax checking covers `.js`, `.mjs`, `.cjs`, `.py` and `.json`.** Everything else
  is checked only for surviving conflict markers and otherwise trusted. Adding a
  language means adding a case to `lib/validate.mjs`.
- **`node --check` lies about `.js` files.** A `.js` file containing ESM syntax exits 0
  even when it does not parse: the CommonJS parse fails, Node retries as a module, and
  the error is lost. The validator checks JavaScript as `.mjs`, then `.cjs`, never as
  `.js`. There is a regression test pinning this.
- **It resolves, it does not review.** A merge that parses and preserves both intents
  can still be wrong. Read the diff.

## Layout

| Path | |
| --- | --- |
| `jevmerge.mjs` | CLI: enumerate, judge, gate, write, report |
| `lib/git.mjs` | index stages, diff3 reconstruction, branch context |
| `lib/conflicts.mjs` | marker parsing and rendering; strict, throws rather than guesses |
| `lib/candidates.mjs` | three-way merge, used on lines and on tokens |
| `lib/structured.mjs` | three-way merge on keys, for `.json` |
| `lib/validate.mjs` | syntax gates per file type |
| `lib/judge.mjs` | one System One request for the whole merge |
| `test/run.mjs` | 46 offline tests, no git and no API |
| `bench/replay.mjs` | replays real merges and scores against the committed answer |
| `bench/inspect.mjs` | dumps one conflict, its candidates and the human's answer |
| `demo/capture.sh` | builds the demo repo and records the real runs |
| `demo/render.mjs` | draws the recording as a GIF |

```bash
node test/run.mjs
```

Run it before anything else. It covers the logic that decides what gets written to
someone's file.

## Credentials

`TYPESAFE_API_KEY` in `.env` beside `jevmerge.mjs`, gitignored, or in the environment.
