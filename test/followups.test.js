import test from "node:test";
import assert from "node:assert/strict";
import { harness, until } from "./helpers.js";

const running = (o, id) => until(() => o.get(id).status === "running");

test("a follow-up keeps what the assignment before it handed back", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Fix"));
  await running(o, job.id);
  await lead.message(job.id, "Then update the README", { mode: "followup" });
  workers[0].call("pelican_report", { report: "Fixed the parser." });
  await until(() => o.get(job.id).report === "Fixed the parser.");
  workers[0].say("Parser fixed.");
  workers[0].complete();
  await until(() => workers.length === 2 && o.get(job.id).status === "running");
  workers[1].call("pelican_report", { report: "README updated." });
  await until(() => o.get(job.id).report === "README updated.");
  workers[1].complete();
  const { agents } = await lead.wait([job.id], { timeoutMs: 2000 });
  assert.equal(agents[0].status, "completed");
  assert.equal(agents[0].report, "README updated.");
  assert.equal(agents[0].earlier.length, 1);
  assert.equal(agents[0].earlier[0].status, "completed");
  assert.equal(agents[0].earlier[0].report, "Fixed the parser.");
  assert.equal(agents[0].earlier[0].summary, "Parser fixed.");
  assert.equal((await lead.get(job.id)).earlier[0].report, "Fixed the parser.");
  // An assignment given directly starts over.
  await lead.resume(job.id, { prompt: "Now the changelog" });
  await until(() => workers.length === 3);
  assert.equal((await lead.get(job.id)).earlier, undefined);
});

test("follow-ups wait for the next assignment when a turn ends without completing", async (t) => {
  const { o, spec, workers, as, store } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Fix"));
  await running(o, job.id);
  await lead.message(job.id, "Then update the README", { mode: "followup" });
  workers[0].complete("failed");
  await until(() => o.get(job.id).status === "failed");
  // Not started, not dropped: the result says it waits.
  assert.equal(workers.length, 1);
  const { agents } = await lead.wait([job.id], { timeoutMs: 2000 });
  assert.equal(agents[0].followupsWaiting, 1);
  assert.equal(
    store.events({ jobId: job.id, types: ["job.finished"] }).at(-1).data
      .followupsWaiting,
    1,
  );
  assert.equal(
    (await lead.get(job.id)).messages.find((m) => m.mode === "followup")
      .delivered,
    false,
  );
  // The next assignment brings it along.
  await lead.resume(job.id, { prompt: "Try the fix again" });
  await until(() => workers[1]?.last("turn/start"));
  assert.equal(
    workers[1].last("turn/start").params.input[0].text,
    "Assignment from lead:\nTry the fix again\n\nFollow-up from lead, sent before your last turn ended:\nThen update the README",
  );
  const detail = await lead.get(job.id);
  assert.equal(detail.followupsWaiting, undefined);
  assert.equal(
    detail.messages.find((m) => m.mode === "followup").delivered,
    true,
  );
});
