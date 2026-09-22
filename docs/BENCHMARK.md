# How well hunkpick works

Every number here comes from `bench/replay.mjs`, which replays merges from a real
repository: check out a merge commit's first parent, merge the second, run hunkpick,
and compare against what the maintainers actually committed.

```bash
node bench/replay.mjs --repo /path/to/a/clone --max 25
```

Scoring is per conflict region, anchored on the stable lines either side. Whole-file
comparison does not work, because merge commits also contain edits unrelated to the
conflicts.

---

## Before you trust the defaults

The thresholds and the kind allow-list were fitted to `expressjs/express`. They do not
transfer. The same benchmark on two more repositories:

| | express | django | requests |
| --- | --- | --- | --- |
| precision | 74% | 65% | 43% |
| the committed answer was `ours` | 65% | 38% | 20% |
| the committed answer was `theirs` | 8% | 15% | **40%** |

Express merges a maintenance branch into a development branch, so the development side
usually wins and `ours` dominates. `requests` merges pull requests into main, the opposite
direction, and there `theirs` is the most common correct answer — while being excluded
from the defaults, which leaves the tool structurally unable to get those right.

The django and requests samples are small (23 and 7 resolutions) and their intervals
overlap express's, so the precision difference is not statistically established. The
mechanism behind it is not in doubt.

**If your pull requests merge into main, start with `--kinds all`** and compare against
what you would have done. `bench/replay.mjs` will do that on your own history.

## Benchmark

`bench/replay.mjs` replays merges from a real repository. For each merge commit it checks
out the first parent, merges the second, runs hunkpick, and compares the result to the
merge commit's tree.

```bash
node bench/replay.mjs --repo /path/to/a/clone --max 25
```

Scoring is per conflict region, anchored on the stable lines on either side. Whole-file
comparison does not work here because merge commits also contain edits unrelated to the
conflicts.

### Results

The thresholds, the prompt and the kind list were set using merges 1–25. The numbers
below are from merges 26–75, which none of that was fitted to.

Across those 50 merges there were 266 conflict regions with a recoverable answer. In 74%
of them the committed resolution was among the candidates; the other 26% were not
reachable by any combination of the two sides.

| | |
| --- | --- |
| resolutions written | 163 |
| correct | 120 |
| **precision** | **74%** (95% CI 66–80%) |
| **recall of solvable conflicts** | **61%** |

31 of the 43 errors were regions where no candidate matched what was committed, because
the authors wrote the merge by hand. Counting only regions where a correct answer existed,
precision is 91%. That does not make the other 12 harmless: a wrong resolution is a wrong
resolution whether or not a right one was available.

By kind, at the default thresholds and with no kind filter:

| kind chosen | correct |
| --- | --- |
| `merged_lines` | 21/23 (91%) |
| `ours` | 98/134 (73%) |
| `theirs` | 4/20 (20%) |
| `union` | 1/5 (20%) |
| `union_reversed` | 0/1 |
| `merged_tokens` | 0/1 |

Excluding `theirs`, `union_reversed`, `base` and `drop` from unattended use takes overall
precision from 67% to 74%. That is the default; `--kinds all` restores them. `union` is
only weakly supported at n=5 and `merged_tokens` is effectively unmeasured, since express
never produced a conflict where a token merge was the answer.

The committed resolutions were `ours` most of the time. Express merges a maintenance
branch into a development branch and the development side usually wins, so these
proportions are specific to that workflow.

### What moved the numbers

Three changes, each measured against the setting before it:

**Telling the model what each side did.** The dominant selection error was picking the
incoming version when the current branch had deleted a region and the incoming branch had
edited one line inside it — 24 of 38 wrong picks. Shown only the two versions, a deletion
looks like losing code. `lib/judge.mjs` now states, in lines, what each branch changed
relative to the ancestor. Correct selections went from 51 to 58 out of 118.

**Fixing the thresholds.** On identical held-out data, changing only the gates:

| gates | applied | correct | precision | recall |
| --- | --- | --- | --- | --- |
| 0.75 / 0.45 | 60 | 42 | 70% | 21% |
| 0.55 / 0.25 | 163 | 120 | 74% | 61% |

Better on both axes. The `mechanical` threshold had been discarding correct answers for
nothing — see below.

**Letting the model decline.** The `Choice` had to name a candidate even when the right
answer was not among them, and that answer got written. Adding a no-match option, on the
same merges: precision 73% → 81%, wrong resolutions 24 → 15, at the cost of one correct
resolution.

### What did not work

**A second look at the chosen resolution.** After the gates, ask one Noul about the single
resolution about to be written, rather than comparing candidates. It should catch the
regions whose real answer was never on the list. It does not.

| | applied | precision | rejected |
| --- | --- | --- | --- |
| no second look | 80 | 81% | |
| "is this the resolution?" | 53 | 81% | 22 correct, 7 wrong |
| "is any change missing?" | 63 | 79% | 16 correct, 2 wrong |

Both framings cut coverage without moving precision. Worse, the first was anti-predictive:
of the rejections scoring below 0.20, every single one had been correct, while the 0.35–0.50
band was only 33% correct. It appears to answer "does this look complicated", and in this
repository the complicated conflicts are deletions, which are usually right.

The code is not in the tool. If you try this again, measure the rejections rather than the
headline precision — a filter that removes good and bad answers at the same rate leaves
precision unchanged and looks like it did nothing, which is exactly what happened.

## Thresholds

Binned by the reported number, over the held-out runs:

| `approach` | correct | | `mechanical` | correct |
| --- | --- | --- | --- | --- |
| 0.45–0.60 | 67% | | 0.15–0.25 | 71% |
| 0.60–0.75 | 71% | | 0.25–0.35 | 100% |
| 0.75–0.90 | 80% | | 0.35–0.45 | 50% |
| 0.90–1.00 | 84% | | 0.45+ | 73–77% |

`approach` is monotonic: it predicts correctness and is worth gating on. `mechanical` is
flat, so as an accuracy gate it does nothing but cut coverage, which is why it went from
0.45 to 0.25.

That is not a fault in the Noul. It answers "does a person need to decide this", which is
not the same question as "is this pick correct" — a conflict can be resolvable the way the
maintainer resolved it and still be a decision you want to make yourself. It is kept as a
gate for the extreme cases, and as a column you can read, but it is not evidence about
accuracy and is not tuned as though it were.

Both numbers are fitted to one repository. Run the benchmark on your own merges with
`--json`, compare against what you would have done, and move them.

Because `approach` is monotonic, `--confidence` is the dial that actually trades coverage
for precision. On the held-out data:

| `--confidence` | applied | precision | recall |
| --- | --- | --- | --- |
| 0.55 (default) | 163 | 74% | 61% |
| 0.65 | 136 | 74% | 52% |
| 0.75 | 102 | 76% | 40% |

It is a shallow curve. Halving the coverage buys two points of precision, which is worth
knowing before reaching for it.

### Gating on approach rather than confidence

Two orderings of a union are the same resolution in a different order. The Choice
distributes probability across both, which lowers confidence even though the model is not
uncertain about the kind.

The first conflict this was tested on selected the correct resolution at 0.64 with its own
reverse ordering at 0.30. Summed, the kind had 0.94.

The gate therefore sums probability across candidates of the same kind, which is what the
`approach` column shows. The selection within the kind is still the model's. `ours` and
`theirs` have one candidate each, so their numbers are unchanged.
