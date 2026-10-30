import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { ProtocolPump } from "../src/protocol-pump.js";
import { CodexProcess } from "../src/codex.js";
import { createServer } from "../src/server.js";
import { root } from "../src/config.js";
import { harness, until } from "./helpers.js";
import { join } from "node:path";

test("text buffering preserves all text, metadata boundaries, RPC order and the final tail", async () => {
  const input = new PassThrough(),
    output = [];
  const pump = new ProtocolPump(
    input,
    (m) => output.push(m),
    (e) => assert.fail(e.message),
  );
  const delta = (text, item = "one") => ({
    method: "item/agentMessage/delta",
    params: { itemId: item, delta: text },
  });
  input.write(
    [
      delta("a"),
      delta("b"),
      delta("c", "two"),
      { id: 9, result: {} },
      delta("tail"),
    ]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n",
  );
  await new Promise((resolve) => pump.end(resolve));
  assert.deepEqual(output, [
    delta("ab"),
    delta("c", "two"),
    { id: 9, result: {} },
    delta("tail"),
  ]);
  input.write(JSON.stringify(delta("live tail")) + "\n");
  await until(() => output.length === 5);
  assert.equal(output[4].params.delta, "live tail");
  input.end(JSON.stringify(delta("exit tail")) + "\n");
  await new Promise((resolve) => input.once("end", resolve));
  await new Promise((resolve) => pump.end(resolve));
  assert.equal(output[5].params.delta, "exit tail");
  pump.close();
  input.destroy();
});

test(
  "five real CLI pipes under output load keep HTTP controls responsive and journal text lossless",
  { timeout: 30000 },
  async (t) => {
    const workers = [];
    const { o, config, spec, store } = await harness(t, {
      workerFactory: () => {
        const worker = new CodexProcess({
          bin: process.execPath,
          args: [join(root, "test/fixtures/fake-codex.js")],
          timeoutMs: 15000,
        });
        workers.push(worker);
        return worker;
      },
    });
    o.updateSettings({ concurrency: 5 });
    const service = await createServer({ config, fleet: o });
    t.after(() => service.close());
    const jobs = await o.createBatch(
      Array.from({ length: 5 }, (_, i) =>
        spec("Flood " + i, { resources: [] }),
      ),
      "lead",
    );
    await until(() => jobs.every((j) => j.status === "running"), 10000);
    const count = 16000,
      chunk = "small command output line with useful text\n";
    const starts = new Set(),
      received = new Map(),
      completed = new Set();
    o.on("event", (e) => {
      if (e.type === "item/started") starts.add(e.jobId);
      if (e.type === "item/commandExecution/outputDelta") {
        assert.ok(
          !completed.has(e.jobId),
          "no output may arrive after item completion",
        );
        received.set(e.jobId, (received.get(e.jobId) || "") + e.data.delta);
      }
      if (e.type === "item/completed") completed.add(e.jobId);
    });
    const floods = workers.map((w) =>
      w
        .request("flood", { count, chunk })
        .catch((error) => ({ error: error.message })),
    );
    await until(() => starts.size === 5);
    const latencies = [];
    // A control call must answer within 2 s while five streams flood; a shared
    // CI runner has a fraction of the CPUs this was written on, so it gets room.
    const controlTimeoutMs = process.env.CI ? 10000 : 2000;
    const api = async (method, params = {}) => {
      const start = performance.now();
      const response = await fetch(service.origin + "/api/rpc", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "x-pelican-as": "lead",
        },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(controlTimeoutMs),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      latencies.push(performance.now() - start);
      return body.result;
    };
    for (let i = 0; i < 3; i++) assert.equal((await api("list")).length, 5);
    const results = await Promise.all(floods);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(results[i], { count });
      assert.equal(received.get(jobs[i].id), chunk.repeat(count));
      const events = store
        .events({ jobId: jobs[i].id, limit: 1000 })
        .filter((e) => e.type === "item/commandExecution/outputDelta");
      assert.ok(
        events.length < count / 10,
        "small output chunks must not create individual durable writes",
      );
      assert.equal(
        events.map((e) => e.data.delta).join(""),
        chunk.repeat(count),
      );
      assert.ok(completed.has(jobs[i].id));
    }
    const persisted = store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE type='item/commandExecution/outputDelta'",
      )
      .get().count;
    // Keep another stream busy while exercising the actual HTTP stop control.
    completed.delete(jobs[4].id);
    const moreOutput = workers[4]
      .request("flood", { count: 160000, chunk })
      .catch((error) => ({ error: error.message }));
    const killedPid = workers[4].child.pid;
    assert.equal(
      (
        await api("stop", {
          id: jobs[4].id,
          force: true,
          reason: "Load-test stop",
        })
      ).stopped[0].status,
      "interrupted",
    );
    assert.throws(() => process.kill(killedPid, 0));
    await moreOutput;
    t.diagnostic(
      JSON.stringify({
        inputChunks: 5 * count,
        persistedOutputEvents: persisted,
        maxControlMs: Math.ceil(Math.max(...latencies)),
      }),
    );
  },
);
