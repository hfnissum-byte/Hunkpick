/**
 * Builds one System One request covering every conflict, and parses the
 * answers.
 *
 * Two questions per conflict, all independent, so the whole merge is one round
 * trip:
 *
 *   pick_<id>  Choice over the surviving candidates
 *   safe_<id>  Noul: does this need a person
 *
 * The second question is separate because confidence does not cover it. A
 * conflict can have one clearly best mechanical resolution and still be a
 * decision: two valid timeouts, two valid defaults, a check one side removed.
 */

import { diffStat } from "./candidates.mjs";
import { MODEL, systemOne } from "./typesafe.mjs";

/**
 * What one side did to the region, stated in lines.
 *
 * This exists because of a measured failure. The dominant selection error was
 * picking the incoming version when the current branch had deleted the region
 * and the incoming branch had edited one line inside it: 24 of 38 wrong picks
 * in the benchmark. Shown only the two versions, a deletion looks like losing
 * code and the model kept the code. Shown that one side removed 24 lines and
 * the other changed 1 of them, the choice is a different question.
 *
 * Code counts the lines; the model still decides which change wins.
 */
function describeSide(base, side) {
  if (!base.length && !side.length) return "no change";
  if (!base.length) return `added ${side.length} line(s) where the ancestor had none`;
  if (!side.length) return `deleted all ${base.length} line(s) of the region`;

  const d = diffStat(base, side);
  if (!d) return `replaced the region with ${side.length} line(s)`;
  if (!d.removed && !d.added) return "left the region unchanged";
  if (!d.removed) return `added ${d.added} line(s), keeping the ancestor's ${base.length}`;
  if (!d.added) return `removed ${d.removed} of the ancestor's ${base.length} line(s)`;
  return `changed ${d.removed} of the ancestor's ${base.length} line(s), writing ${d.added} in their place`;
}

/** Questions per request. Independent questions parallelise, but state is shared. */
const BATCH = 30;

const PROVENANCE = {
  ours: "Keeps only the current branch's version, discarding the incoming change.",
  theirs: "Keeps only the incoming branch's version, discarding the current change.",
  union: "Keeps both versions, current branch first.",
  union_reversed: "Keeps both versions, incoming branch first.",
  base: "Reverts to the common ancestor, discarding both changes.",
  drop: "Removes this region entirely.",
  merged_lines: "Combines both changes, which touched different lines.",
  merged_tokens: "Combines both changes within the line.",
};

/** The no-match option offered alongside the real candidates. */
export const NONE = "none";

const NO_MATCH =
  "None of the options above is the resolution. The region needs writing by hand: " +
  "combining the two versions, or rewriting them, in a way none of the candidates does. " +
  "Choose this when the correct result is not among them, rather than picking the nearest.";

const MAX_TEXT = 1200;

function clip(text, limit = MAX_TEXT) {
  if (typeof text !== "string") return text;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length} chars total)`;
}

/**
 * A whole-file structural merge is one yes-or-no question, not a choice: code
 * already derived the only answer structure allows, so all that is left is
 * whether it is the right one to apply unsupervised.
 */
function questionsForFile(item) {
  const { key, file, stages, merged } = item;
  const path = `conflicts.${key}`;

  return {
    state: {
      file,
      current_branch_version: clip(stages.ours),
      common_ancestor_version: clip(stages.base),
      incoming_branch_version: clip(stages.theirs),
      proposed_merge: clip(merged.text),
      gained_from_incoming_branch: merged.added,
    },
    questions: {
      [`struct_${key}`]: {
        type: "noul",
        instructions:
          `\`${path}.proposed_merge\` was produced by merging the two versions of ${file} ` +
          `key by key. Is it the right result — does it keep what both branches meant to ` +
          `change, without quietly reverting or dropping anything — and is it safe to apply ` +
          `without a person reviewing it?`,
        criteria: {
          true:
            "The merge keeps both branches' intended changes and loses nothing. " +
            "Applying it unreviewed is fine.",
          false:
            "The merge drops, reverts or distorts something, or the two branches disagreed " +
            "about a value in a way that needs a person.",
        },
      },
    },
  };
}

/**
 * Build the state entry and the two questions for one conflict.
 * `item` is {key, file, hunk, context, candidates}.
 */
function questionsForHunk(item) {
  const { key, file, hunk, context, candidates } = item;
  const path = `conflicts.${key}`;

  const criteria = {};
  for (const c of candidates) {
    criteria[c.id] = `${PROVENANCE[c.kind] ?? "A possible resolution."}\nResulting text:\n${clip(
      c.lines.join("\n")
    )}`;
  }

  // Without this, the Choice has to name one of the candidates even when the
  // right answer is not among them, and the answer gets written. Measured on
  // the benchmark: 17 of 24 wrong resolutions were regions where no candidate
  // matched what was committed, because the authors hand-wrote the merge.
  criteria.none = NO_MATCH;

  return {
    state: {
      file,
      lines_before: context.before,
      common_ancestor_version: hunk.hasBase ? hunk.base : "(not available)",
      current_branch_version: hunk.ours,
      incoming_branch_version: hunk.theirs,
      what_each_side_did: hunk.hasBase
        ? {
            current_branch: describeSide(hunk.base, hunk.ours),
            incoming_branch: describeSide(hunk.base, hunk.theirs),
          }
        : "(no common ancestor available)",
      lines_after: context.after,
    },
    questions: {
      [`pick_${key}`]: {
        type: "choice",
        instructions:
          `Two branches changed the same region of ${file}, shown in \`${path}\`. ` +
          `\`${path}.what_each_side_did\` states what each branch changed relative to ` +
          `\`${path}.common_ancestor_version\`. Which candidate is the resolution the ` +
          `authors would have committed? ` +
          `If the two changes can coexist, that is a candidate keeping both. If they cannot, ` +
          `it is the side whose change supersedes the other: deleting a region supersedes an ` +
          `edit made inside that region, and a rewrite supersedes a small fix to the old ` +
          `version. The result must fit the surrounding code in \`${path}.lines_before\` and ` +
          `\`${path}.lines_after\`. If the resolution is not among the candidates, choose the ` +
          `no-match option rather than the nearest one.`,
        criteria,
      },
      [`safe_${key}`]: {
        type: "noul",
        instructions:
          `Can the conflict in \`${path}\` be resolved mechanically, or does it need a person ` +
          `to decide? Consider whether the two sides are compatible changes that can both be ` +
          `kept, or a genuine disagreement about what the code should do.`,
        criteria: {
          true:
            "The two sides are compatible, or one is clearly a superset of the other. " +
            "Combining or choosing between them does not change anyone's intent.",
          false:
            "The sides disagree about behaviour, security, or a value, and picking one " +
            "silently discards a real decision. A person should look at this.",
        },
      },
    },
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @param {Array} items one per conflict, see questionsFor
 * @param {object} merge branch names and commit subjects
 * @returns {Promise<{verdicts: Map, usage: object, requests: number, model: string}>}
 */
export async function judge(items, merge, { model = MODEL } = {}) {
  const verdicts = new Map();
  const usage = { input_tokens: 0, output_tokens: 0 };
  let requests = 0;
  let seenModel = model;

  for (const group of chunk(items, BATCH)) {
    const conflicts = {};
    let questions = {};
    for (const item of group) {
      const built = item.type === "file" ? questionsForFile(item) : questionsForHunk(item);
      conflicts[item.key] = built.state;
      questions = { ...questions, ...built.questions };
    }

    const data = await systemOne({
      model,
      state: {
        what_this_is:
          "A git merge left conflicts. Each entry in `conflicts` is one conflicted region, " +
          "with the version from each branch and the common ancestor they both started from.",
        current_branch: merge.ours_branch,
        incoming_branch: merge.theirs_branch,
        current_branch_recent_commits: merge.ours_commits,
        incoming_branch_recent_commits: merge.theirs_commits,
        conflicts,
      },
      questions,
    });

    requests++;
    seenModel = data.model ?? seenModel;
    usage.input_tokens += data.usage?.input_tokens ?? 0;
    usage.output_tokens += data.usage?.output_tokens ?? 0;

    for (const item of group) {
      if (item.type === "file") {
        verdicts.set(item.key, { correct: data.answers[`struct_${item.key}`]?.noul ?? 0 });
        continue;
      }
      const pick = data.answers[`pick_${item.key}`];
      const safe = data.answers[`safe_${item.key}`];
      verdicts.set(item.key, {
        candidateId: pick?.choice,
        confidence: pick?.confidence ?? 0,
        probabilities: pick?.probabilities ?? {},
        safe: safe?.noul ?? 0,
      });
    }
  }

  return { verdicts, usage, requests, model: seenModel };
}
