import test from "node:test";
import assert from "node:assert/strict";
import { harness, until } from "./helpers.js";

const running = (o, id) => until(() => o.get(id).status === "running");

test("a question Codex settles itself closes instead of waiting for its owner", async (t) => {
  const { o, spec, workers, as, store } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Ask"));
  await running(o, job.id);
  workers[0].call("pelican_ask", { question: "Which branch?" }, 7);
  await until(() => o.get(job.id).status === "waiting");
  const [question] = await lead.questions();
  workers[0].emit("notification", {
    method: "serverRequest/resolved",
    params: { threadId: o.get(job.id).threadId, requestId: 7 },
  });
  await until(() => o.get(job.id).status === "running");
  assert.deepEqual(o.get(job.id).pending, []);
  assert.deepEqual(await lead.questions(), []);
  const expired = store
    .events({ jobId: job.id, types: ["questions.expired"] })
    .at(-1).data;
  assert.deepEqual(expired.ids, [question.requestId]);
  assert.match(expired.reason, /Codex settled the request itself/);
  await assert.rejects(
    lead.answer(job.id, question.requestId, "main"),
    /has no pending question/,
  );
  assert.equal(workers[0].answer(7), undefined);
  // A request Pelican does not hold changes nothing.
  workers[0].emit("notification", {
    method: "serverRequest/resolved",
    params: { threadId: o.get(job.id).threadId, requestId: 99 },
  });
  assert.equal(o.get(job.id).status, "running");
});
