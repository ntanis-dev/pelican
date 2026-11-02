import test from "node:test";
import assert from "node:assert/strict";
import { Fleet } from "../src/fleet.js";
import { FakeWorker, harness, until } from "./helpers.js";

const running = (o, id) => until(() => o.get(id).status === "running");

// The account's limits as CodexAccount.usage reads them, the short window
// used up and resetting at resetsAt.
const spent = (resetsAt) => async () => ({
  limits: [
    {
      id: "codex",
      windows: [
        { usedPercent: 100, windowMinutes: 300, resetsAt },
        { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
      ],
    },
  ],
});
// Codex failing the agent's turn at a limit.
const failAtLimit = (worker, codexErrorInfo = "usageLimitExceeded") =>
  worker.emit("notification", {
    method: "turn/completed",
    params: {
      turn: {
        id: worker.turnId,
        status: "failed",
        error: { message: "You've hit your usage limit.", codexErrorInfo },
      },
    },
  });

test("an agent stopped by a usage limit waits for the reset, then continues", async (t) => {
  // The window reset a moment under a minute ago: it continues at once.
  const resetsAt = new Date(Date.now() - 59800).toISOString();
  const { o, spec, workers, as, store } = await harness(t, {
    usage: spent(resetsAt),
  });
  const job = await as("lead").spawn(spec("Limited"));
  await running(o, job.id);
  failAtLimit(workers[0]);
  await until(() => o.get(job.id).limitWaits === 1);
  const limited = store
    .events({ jobId: job.id, types: ["job.limited"] })
    .at(-1).data;
  assert.equal(limited.resetsAt, resetsAt);
  assert.equal(limited.attempt, 1);
  assert.match(limited.reason, /usage limit/);
  await until(() => workers[1]?.last("turn/start"));
  assert.match(
    workers[1].last("turn/start").params.input[0].text,
    /^Pelican:\nYour turn stopped at the Codex usage limit/,
  );
  assert.equal(o.get(job.id).status, "running");
});

test("a usage limit that resets later than six hours away fails the agent, saying when", async (t) => {
  const resetsAt = new Date(Date.now() + 3 * 86400000).toISOString();
  const { o, spec, workers, as } = await harness(t, {
    usage: spent(resetsAt),
  });
  const job = await as("lead").spawn(spec("Weekly"));
  await running(o, job.id);
  failAtLimit(workers[0], {
    responseTooManyFailedAttempts: { httpStatusCode: 429 },
  });
  await until(() => o.get(job.id).status === "failed");
  assert.equal(
    o.get(job.id).error,
    `You've hit your usage limit. The limit resets at ${resetsAt}; resume the agent then.`,
  );
  assert.equal(workers.length, 1);
});

test("a usage limit with no known reset fails the agent as before", async (t) => {
  const { o, spec, workers, as } = await harness(t, {
    usage: async () => {
      throw new Error("Codex is unreachable");
    },
  });
  const job = await as("lead").spawn(spec("Unknown"));
  await running(o, job.id);
  failAtLimit(workers[0], "rateLimitExceeded");
  await until(() => o.get(job.id).status === "failed");
  assert.equal(o.get(job.id).error, "You've hit your usage limit.");
});

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

test("a turn that completed just before a restart is settled as completed", async (t) => {
  const { o, spec, workers, as, store, config } = await harness(t);
  const lead = as("lead");
  const done = await lead.spawn(spec("Done"));
  const owes = await lead.spawn(
    spec("Owes", { resultSchema: { type: "object" } }),
  );
  const cut = await lead.spawn(spec("Cut"));
  for (const job of [done, owes, cut]) await running(o, job.id);
  // The service dies after Codex completed two turns, before Pelican settled
  // them: the journal has their ends, the jobs still say running.
  for (const job of [done, owes])
    store.event(job.id, "turn/completed", {
      turn: { id: o.get(job.id).turnId, status: "completed" },
    });
  const restarted = new Fleet({
    store,
    config,
    workerFactory: (job) => new FakeWorker(job),
  });
  assert.equal(restarted.get(done.id).status, "completed");
  assert.equal(restarted.get(done.id).error, null);
  assert.equal(
    store.events({ jobId: done.id, types: ["job.finished"] }).at(-1).data
      .recovered,
    true,
  );
  // One that owes a result it never gave, and one still working, are
  // interrupted as before.
  assert.equal(restarted.get(owes.id).status, "interrupted");
  assert.equal(restarted.get(cut.id).status, "interrupted");
  assert.equal(workers.length, 3);
});
