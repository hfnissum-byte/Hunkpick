# jevmerge

**Resolves git merge conflicts by listing every sensible answer, then having a model point at one.**

Most AI merge tools ask a language model to *write* the resolution. This one never does.
Instead it works out, mechanically, every resolution a conflict could legitimately have —
take your side, take theirs, keep both, combine them — and discards any that do not
compile. The model's only job is to point at one of the survivors.

That flip is the whole design. The model cannot invent a resolution, so it cannot produce
a file that does not parse. The worst it can do is pick a valid answer that is the wrong
valid answer, which you catch by reading the diff.

![jevmerge resolving four conflicts](demo/jevmerge.gif)

Four conflicts in the clip, four different shapes. It merges three and hands the fourth
back, because that one is a decision rather than a merge. Every frame is real output —
`demo/capture.sh` runs the commands, `demo/render.mjs` only draws what they printed.

---

**Contents** · [Quick start](#quick-start) · [Reading the output](#reading-the-output) ·
[How it works](#how-it-works) · [JSON](#json-files-are-merged-by-key) ·
[Options](#options) · [How well it works](#how-well-it-works) ·
[Thresholds](#thresholds) · [Limits](#limits) · [Layout](#project-layout)

---

## Quick start

**You need** Node 20 or newer, git, and a [TypeSafe](https://typesafe.ai) API key.
There are no runtime dependencies — the tool uses only Node built-ins.

```bash
git clone https://github.com/hfnissum-byte/jevmerge.git
cd jevmerge
cp .env.example .env        # then put your key in it
node test/run.mjs           # 46 offline tests, no API calls
```

Then, in a repository with conflicts:

```bash
node /path/to/jevmerge/jevmerge.mjs            # report only, changes nothing
node /path/to/jevmerge/jevmerge.mjs --apply    # write the resolutions it is sure about
```

**Nothing is written without `--apply`.** Nothing is ever staged or committed — that
stays your decision. Conflicts it does not resolve keep their markers exactly as they
were, so you can finish them by hand as usual.

## Reading the output

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

| what you see | what it means |
| --- | --- |
| `RESOLVE` / `LEAVE` | whether this conflict will be written, or handed back to you |
| `merged_tokens`, `union`, … | *which kind* of resolution was picked — see the table below |
| `approach` | how sure the model is about that kind of resolution, 0 to 1 |
| `mechanical` | how sure it is that this is a merge at all, rather than a decision for a person |
| `│ …` | the actual lines that would be written |

Both bars must clear their thresholds before anything is written. The bar turns amber
near the line and red well below it.

**The kinds of resolution:**

| kind | what it does |
| --- | --- |
| `ours` | keep the current branch's version |
| `theirs` | keep the incoming branch's version |
| `union` | keep both, one after the other |
| `merged_lines` | combine them — they changed different lines |
| `merged_tokens` | combine them *within* one line |
| `structural` | merge the file by key (JSON only) |
| `base` / `drop` | revert both, or delete the region |

In the example above, the two it left alone are the interesting ones:

- **`server.js` line 9** — both branches set the same timeout, to 1s and 30s. There is no
  mechanical answer, and `mechanical 0.15` says so. Somebody has to decide.
- **`cart.js` line 3** — it found a combination it was completely sure about as an
  *approach* (1.00) and still declined, because multiplying a tax rate by a quantity
  changes what the function computes. That is a decision wearing a merge's clothes.

## How it works

### 1. Rebuild the conflict with its ancestor

The file in your working tree shows both sides but not what they started from. jevmerge
re-derives the conflict from git's index stages — `:1:` base, `:2:` ours, `:3:` theirs —
via `git merge-file --diff3`, so every hunk carries its common ancestor. Your working
tree is not touched to do this.

### 2. Enumerate every candidate

For each hunk: `ours`, `theirs`, `base`, `union` in both orders, `drop`, and two computed
merges — one across the hunk's **lines**, one across a line's **tokens**. The same
three-way algorithm runs at both scales.

The token pass catches what line-level merging structurally cannot:

```
base      sum += it.price;
ours      sum += it.price * it.qty;
theirs    sum += it.price * (1 + TAX);
────────────────────────────────────────────
candidate sum += it.price * it.qty * (1 + TAX);
```

Neither branch contains that line. Both intentions survive in it.

### 3. Throw out anything that does not parse

Every candidate is rendered into the **whole file** and parsed — not checked in
isolation, because a hunk that parses on its own can still break the code around it.
Whatever fails is gone before the model ever sees it.

### 4. Ask two questions per conflict

Every conflict in the repository goes out in a single request. Jev is a *System One*
model: it does not generate text, it returns typed answers with probabilities attached.
Two question types are used here.

- **Choice** — pick one of the surviving candidates. Which one keeps both sides' intent?
- **Noul** — a yes/no with a probability. Is this something a person has to decide?

The second question exists because confidence cannot express it. A conflict can have one
obviously best mechanical resolution and still be a real decision: two valid timeouts,
two valid defaults, a security check one branch removed. High confidence, still not ours
to take.

### 5. Gate the answer in code

Both thresholds are checked by code, never by the model, and the chosen kind must be one
that is allowed to apply unattended. Anything that fails a gate is left for you with its
markers intact.

## JSON files are merged by key

Line and token merges cannot fix the commonest conflict in a JavaScript repo — two
branches adding a different dependency to `package.json` — because the correct result
needs a comma that appears in neither version.

So `.json` files take a different route: parse all three stages, three-way merge the
objects key by key, serialise once. A single Noul then asks whether the result is right
and safe to apply unreviewed.

It declines and falls back to the line-level path when structure cannot settle things:
two different values for one key, an ambiguous array order, or a key one branch deleted
while the other edited it. It also declines when the merged result is identical to one
side — that is a *choice* between branches, and a Choice question handles it better.

## Options

| Flag | |
| --- | --- |
| `--apply` | write files; without it nothing is modified |
| `--confidence <0-1>` | minimum for the `approach` bar (default 0.75) |
| `--safe <0-1>` | minimum for the `mechanical` bar (default 0.45) |
| `--kinds <a,b,…\|all>` | which kinds may apply unattended (default is measured, see below) |
| `--context <n>` | lines of surrounding context shown to the model (default 6) |
| `--all` | apply everything regardless of the gates |
| `--json` | machine-readable output |
| `--model <name>` | override the model |

**Exit codes:** `0` everything resolved · `1` some left for you · `2` nothing to do, or an error.

## How well it works

Measured, not asserted. `bench/replay.mjs` replays real merges from a real repository:
check out a merge commit's first parent, merge the second, and compare what jevmerge does
against what the maintainers actually committed. Nobody wrote that answer key to make
this tool look good.

```bash
node bench/replay.mjs --repo /path/to/a/clone --max 25
```

Scoring is per conflict region, anchored on the stable lines either side. Whole-file
comparison would measure the wrong thing, because merge commits contain plenty of edits
that are not conflict resolution.

Over 25 conflicted merges from `expressjs/express`, **118 conflict regions** had a
recoverable answer. In **77%** of them the human's resolution was among the candidates,
so enumeration covers most of what people actually do. The remaining 23% no mechanical
tool could have matched.

The first run allowed every kind, and the result was a coin flip:

| kind chosen | correct |
| --- | --- |
| `ours` | 5/5 — 100% |
| `merged_lines` | 19/23 — 83% |
| `union` | 2/3 — 67% |
| `theirs` | **0/17 — 0%** |
| `union_reversed` | **0/4 — 0%** |
| `base` | 0/1 |
| **overall** | **26/53 — 49%** |

`theirs` was chosen seventeen times and wrong seventeen times. Refusing to auto-apply it
and `union_reversed` raises precision from **49% to 81%** and costs *nothing* in recall —
between them they never once produced a right answer. That is now the default, and
`--kinds all` puts them back.

The asymmetry makes sense given what the humans chose: `ours` 55% of the time,
`merged_lines` 27%, `theirs` only 10%. Express merges a maintenance branch into a
development branch and the development side nearly always wins. A repository with
different habits could well need `theirs` back. **These are one workflow's numbers, not
a law.**

### What it is not

Even gated, it resolves a minority of conflicts. On a 10-merge confirmation run, 5 of 7
auto-resolutions were right and it handed 82% of the solvable ones back to a human. The
judgment is the bottleneck, not the enumeration: in 17 regions the answer was plainly
`ours` and it did not take it.

Treat `--apply` as a first pass that clears the boring conflicts, and read the diff
afterwards. It is not an unattended merge bot, and the numbers above are why that is
stated here rather than discovered the hard way.

## Thresholds

Six identical runs over the same two-file merge, to see which signals actually move:

| signal | range over 6 runs |
| --- | --- |
| structural merge, `correct` | 0.76 – 0.78 |
| two added imports, `approach` | 0.94 – 0.96 |
| two added imports, `mechanical` | **0.59 – 0.67** |
| 1s vs 30s timeout, `mechanical` | 0.15 – 0.17 |

Two things follow. The Choice is steady and the Noul is the noisy one, so the Noul is
where a threshold gets into trouble. And the Noul still separates the two cases cleanly —
roughly 0.16 against 0.63 — so the signal was fine and only the threshold was misplaced.

`--safe` started at 0.60, sitting *inside* the upper cluster, and the same conflict
resolved or did not depending on the run. It now defaults to 0.45, in the gap, with about
0.14 of margin either side.

That is calibrated against two clusters. It is a better guess, not a tuned value. Run it
over a batch of your own merges with `--json`, compare against what you would have done,
and move both numbers.

### Why the gate uses "approach", not raw confidence

Two orderings of a union are the same decision in different clothes. The Choice splits
its probability between them, which reads as doubt about *what to do* when it is only
doubt about the order.

The first real conflict this was run against picked the right resolution at 0.64, with
its own mirror image as runner-up at 0.30. The model was 0.94 sure of the approach and
the gate could not see it.

So the gate sums probability across candidates of the same kind and tests that instead —
which is why the bar is labelled `approach`. Summing a distribution over a partition of
its own outcomes is just arithmetic; the pick *within* the kind is still the model's.
`ours` and `theirs` are single-candidate kinds, so nothing changes for them.

## Limits

- **Content conflicts only.** Add/add, delete/modify and rename conflicts are reported
  and skipped — there is no text to enumerate over.
- **Syntax checking covers `.js`, `.mjs`, `.cjs`, `.py` and `.json`.** Everything else is
  checked only for surviving conflict markers and otherwise trusted. Adding a language
  means adding a case to `lib/validate.mjs`.
- **`node --check` lies about `.js` files.** A `.js` file containing ESM syntax exits 0
  even when it does not parse: the CommonJS parse fails, Node retries it as a module, and
  the error is lost on the way. The validator checks JavaScript as `.mjs`, then `.cjs`,
  and never as `.js`. A regression test pins this.
- **It resolves, it does not review.** A merge that parses and preserves both intents can
  still be wrong. Read the diff.

## Project layout

| Path | |
| --- | --- |
| `jevmerge.mjs` | the CLI: enumerate, judge, gate, write, report |
| `lib/git.mjs` | index stages, diff3 reconstruction, branch context |
| `lib/conflicts.mjs` | marker parsing and rendering; throws rather than guesses |
| `lib/candidates.mjs` | three-way merge, used on lines and on tokens |
| `lib/structured.mjs` | three-way merge on keys, for JSON |
| `lib/validate.mjs` | syntax gates per file type |
| `lib/judge.mjs` | one request covering the whole merge |
| `test/run.mjs` | 46 offline tests — no git, no API |
| `bench/replay.mjs` | replays real merges, scores against the committed answer |
| `bench/inspect.mjs` | dumps one conflict, its candidates and the human's answer |
| `demo/capture.sh` | builds the demo repo and records the real runs |
| `demo/render.mjs` | draws the recording as a GIF |

```bash
npm test
```

Run it before anything else. It covers the logic that decides what gets written into
someone's file.

## Credentials

Put `TYPESAFE_API_KEY` in a `.env` file beside `jevmerge.mjs`, or set it in the
environment. The `.env` file is gitignored; `.env.example` shows the shape.
