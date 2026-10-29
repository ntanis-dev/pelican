import test from "node:test";
import assert from "node:assert/strict";
import { harness, until } from "./helpers.js";

test("history pruning yields between batches and preserves concurrent journal writes", async (t) => {
  const { store } = await harness(t);
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  store.transaction(() => {
    for (let i = 0; i < 1024; i++)
      store.event("old-agent", "job.updated", { i });
    store.db.prepare("UPDATE events SET at=?").run(old);
  });
  const retained = store.event("live-agent", "agent.question", {
    question: "Keep this request",
  });
  const count = store.db.prepare(
    "SELECT count(*) AS n FROM events WHERE at < ?",
  );
  let batchesSeen = 0,
    concurrent;
  const scan = store.prune();
  assert.equal(store.prune(), scan, "maintenance must be single flight");
  // Observe via immediates: all deletion batches in one synchronous callback
  // would skip the partially pruned state and fail this check.
  let observing = true;
  function observe() {
    if (!observing) return;
    const n = count.get(retained.at).n;
    if (n > 0 && n < 1024) {
      batchesSeen++;
      concurrent ??= store.event("live-agent", "agent.answered", {
        answer: "Still responsive",
      });
    }
    setImmediate(observe);
  }
  setImmediate(observe);
  try {
    const result = await scan;
    assert.equal(result.removed, 1024);
    assert.ok(batchesSeen > 1);
    assert.deepEqual(
      store.events().map((e) => e.seq),
      [retained.seq, concurrent.seq],
    );
  } finally {
    observing = false;
  }
});

test("supervisor interruption is retained as Interrupted without automatically retrying the worker", async (t) => {
  const { o, spec, workers, store } = await harness(t);
  const job = await o.create(spec("Supervisor recovery"), "lead");
  await until(() => job.status === "running");
  workers[0].emit("exit", {
    interrupted: true,
    message: "Pelican did not recover; supervisor interruption",
  });
  await until(() => !o.active.has(job.id));
  assert.equal(job.status, "interrupted");
  assert.equal(workers.length, 1);
  assert.match(job.error, /supervisor interruption/);
  assert.equal(store.jobs().find((j) => j.id === job.id).status, "interrupted");
});
