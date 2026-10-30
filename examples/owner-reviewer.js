export const meta = {
  name: "owner-reviewer",
  description:
    "Per item: an owner agent does the task, then a fresh reviewer checks it; what the reviewer finds goes to the next owner round",
  whenToUse:
    "args: { items: [string | { id, task, resources? }], rounds?: 2 (owner -> review rounds per item, at most 5), concurrency?: 4 (items in flight), notes?: { [id]: string[] } }. Owners reserve item.resources (the whole folder when absent, so such owners take turns); reviewers are read-only.",
  phases: [
    {
      title: "Own",
      detail:
        "one owner agent per item and round: do the task, check it, report",
    },
    {
      title: "Review",
      detail:
        "a fresh read-only reviewer per round: confirm, or list concrete findings",
    },
  ],
};

// pelican run examples/owner-reviewer.js --as lead --args '@items.json'
// with items.json like
//   { "items": [{ "id": "dry-run", "task": "Add a --dry-run flag to scripts/sync.js with tests", "resources": ["scripts/sync.js", "test/sync.test.js"] }] }
// Every finding of a reviewer becomes a note of its item, so each later owner
// round sees the open findings (labelled with the round that found them) and
// each later reviewer rechecks them; the result carries the notes.
const items = (Array.isArray(args?.items) ? args.items : []).map((item, i) =>
  typeof item === "string" ? { id: `item-${i + 1}`, task: item } : item,
);
if (!items.length)
  throw new Error(
    'pass args.items, e.g. { "items": ["Add a --dry-run flag to scripts/sync.js"] }',
  );
for (const item of items)
  if (!item || typeof item.id !== "string" || typeof item.task !== "string")
    throw new Error(
      `each item is a task string or { id, task, resources? }, not ${JSON.stringify(item)}`,
    );
const rounds = Math.max(1, Math.min(5, Math.floor(Number(args?.rounds ?? 2))));
const concurrency = Math.max(
  1,
  Math.min(16, Math.floor(Number(args?.concurrency ?? 4))),
);
const operatorNotes = (id) =>
  Array.isArray(args?.notes?.[id]) ? args.notes[id] : [];

const OWNER = {
  type: "object",
  properties: {
    done: {
      type: "boolean",
      description: "true when the task is done and your checks pass",
    },
    changes: {
      type: "array",
      items: { type: "string" },
      description: "what you changed and why, one line each",
    },
    checks: {
      type: "string",
      description: "the checks you ran and their results",
    },
    open: {
      type: "array",
      items: { type: "string" },
      description: "anything left undone or uncertain",
    },
  },
  required: ["done", "changes", "checks", "open"],
};
const REVIEW = {
  type: "object",
  properties: {
    approved: {
      type: "boolean",
      description: "true only when the task is done and every check holds",
    },
    findings: {
      type: "array",
      items: { type: "string" },
      description: "each concrete problem, with the file and line",
    },
    checks: { type: "string", description: "what you ran and read" },
  },
  required: ["approved", "findings", "checks"],
};

function ownerPrompt(item, round, notes) {
  return [
    `Task: ${item.task}`,
    item.resources?.length
      ? `You own ${item.resources.join(", ")}; ask before changing anything else.`
      : "",
    "Do the task, run the relevant tests and checks yourself, and report what you changed and what you ran.",
    round > 1
      ? `This is round ${round} of ${rounds}: a reviewer did not approve the previous round.`
      : "",
    notes.length
      ? `Notes (act on them first; a reviewer's finding stays open until your own checks show it fixed):\n- ${notes.join("\n- ")}`
      : "",
    "Return done: true only when the task is done and your checks pass.",
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewPrompt(item, owner, notes) {
  return [
    `Review this task independently; you did not do it, so assume nothing: ${item.task}`,
    `The owner reports these changes:\n- ${owner.changes.join("\n- ") || "(none listed)"}`,
    `and these checks: ${owner.checks}`,
    notes.length
      ? `Earlier findings; check each one specifically:\n- ${notes.join("\n- ")}`
      : "",
    "Read the changes, run the checks yourself, and approve only if the task is done and everything holds. List each concrete problem as a finding. Do not edit files.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function runItem(item) {
  const notes = [...operatorNotes(item.id)];
  let owner = null,
    review = null;
  for (let round = 1; round <= rounds; round += 1) {
    owner = await agent(ownerPrompt(item, round, notes), {
      label: `own:${item.id}#${round}`,
      phase: "Own",
      schema: OWNER,
      ...(item.resources ? { resources: item.resources } : {}),
    });
    if (owner === null)
      return { item: item.id, outcome: "owner-failed", round, notes };
    if (!owner.done)
      return { item: item.id, outcome: "not-done", round, owner, notes };
    review = await agent(reviewPrompt(item, owner, notes), {
      label: `review:${item.id}#${round}`,
      phase: "Review",
      schema: REVIEW,
      resources: [],
    });
    if (review === null)
      return { item: item.id, outcome: "reviewer-failed", round, owner, notes };
    if (review.approved)
      return {
        item: item.id,
        outcome: "approved",
        round,
        owner,
        review,
        notes,
      };
    const found = review.findings.length
      ? review.findings.map((finding) => `reviewer, round ${round}: ${finding}`)
      : [
          `reviewer, round ${round}: not approved, no finding listed (checks: ${review.checks})`,
        ];
    notes.push(...found);
    log(
      `${item.id}: the review found ${found.length}; round ${round} of ${rounds}`,
    );
  }
  return {
    item: item.id,
    outcome: "not-approved",
    round: rounds,
    owner,
    review,
    notes,
  };
}

// A small pool: at most `concurrency` items in flight. The workspace's own
// concurrency still caps the agents running at once.
const queue = [...items];
const results = new Map();
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    const result = await runItem(item);
    results.set(item.id, result);
    log(`${item.id}: ${result.outcome} (round ${result.round} of ${rounds})`);
  }
}
log(
  `${items.length} item${items.length === 1 ? "" : "s"}, ${Math.min(concurrency, items.length)} at a time, up to ${rounds} round${rounds === 1 ? "" : "s"} each`,
);
await Promise.all(
  Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
);
return { results: items.map((item) => results.get(item.id)) };
