/**
 * Turn a pile of conflicts into one System One request and read the answers
 * back out.
 *
 * Two questions per conflict, both independent of every other conflict, so the
 * whole merge goes out in a single round trip:
 *
 *   pick_<id>  Choice over the surviving candidates — which one is right
 *   safe_<id>  Noul — or does this need a person
 *
 * The second one exists because confidence cannot express it. A conflict can
 * have one obviously best mechanical resolution and still be a decision
 * somebody should make on purpose: two valid timeouts, two valid defaults, a
 * security check one side removed. High confidence, still not ours to take.
 */

import { MODEL, systemOne } from "./typesafe.mjs";

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

  return {
    state: {
      file,
      lines_before: context.before,
      current_branch_version: hunk.ours,
      common_ancestor_version: hunk.hasBase ? hunk.base : "(not available)",
      incoming_branch_version: hunk.theirs,
      lines_after: context.after,
    },
    questions: {
      [`pick_${key}`]: {
        type: "choice",
        instructions:
          `Two branches changed the same part of ${file}, shown in \`${path}\`. ` +
          `Compare \`${path}.current_branch_version\` and \`${path}.incoming_branch_version\` ` +
          `against \`${path}.common_ancestor_version\` to see what each side was trying to do. ` +
          `Which candidate resolution preserves the intent of both sides, and fits the ` +
          `surrounding code in \`${path}.lines_before\` and \`${path}.lines_after\`?`,
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
