import test from "node:test";
import assert from "node:assert/strict";
import { harness, until } from "./helpers.js";

test("questions and approvals share arrival order across agents and owners, including timestamp ties", async (t) => {
  const { o, spec, as } = await harness(t);
  const [a] = await o.createBatch([spec("First created")], "lead");
  const [b] = await o.createBatch([spec("Second created")], "reviewer");
  await until(() => a.status === "running" && b.status === "running");
  const send = (job, id, approval = false) =>
    o.requestFromWorker(job, o.active.get(job.id), {
      id,
      method: approval
        ? "item/commandExecution/requestApproval"
        : "item/tool/call",
      params: approval
        ? {
            command: "node verify.mjs",
            availableDecisions: ["accept", "decline"],
          }
        : { tool: "pelican_ask", arguments: { question: "Which approach?" } },
    });
  await send(b, 1, true);
  await send(a, 2);
  await send(b, 3);
  const [first, last] = b.pending,
    second = a.pending[0];
  for (const q of [first, second, last])
    q.createdAt = "2026-10-11T00:00:00.000Z";
  assert.ok(
    first.sequence < second.sequence && second.sequence < last.sequence,
  );
  const everyone = await as("lead").questions();
  assert.deepEqual(
    everyone.map((q) => q.requestId),
    [first.id, second.id, last.id],
  );
  assert.deepEqual(
    everyone.map((q) => q.owner),
    ["reviewer", "lead", "reviewer"],
  );
  assert.deepEqual(
    (await as("lead").questions({ owner: "reviewer" })).map((q) => q.requestId),
    [first.id, last.id],
  );
  await as("lead").answer(a.id, second.id, "go");
  assert.equal(o.active.get(a.id).proc.replies.length, 1);
  assert.equal(o.active.get(b.id).proc.replies.length, 0);
  const reviewer = as("reviewer");
  await reviewer.answer(b.id, first.id, "decline");
  await reviewer.answer(b.id, last.id, "go");
  assert.equal((await reviewer.questions()).length, 0);
  await send(a, 4);
  await send(b, 5);
  await o.stop(a.id, "Stopped by lead", true, "lead");
  await o.answer(b.id, b.pending[0].id, "continue", "reviewer");
  assert.equal((await reviewer.questions()).length, 0);
});
