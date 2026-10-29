import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { EventWaiters } from "../src/event-waiters.js";
import { createServer } from "../src/server.js";
import { harness, until } from "./helpers.js";

test("timeouts, shared cancellation, predicate errors and close release all wait state", async () => {
  const emitter = new EventEmitter(),
    waiters = new EventWaiters(emitter);
  await waiters.wait({ timeoutMs: 1 });
  assert.equal(emitter.listenerCount("event"), 0);
  const abort = new AbortController();
  const pending = Array.from({ length: 40 }, () =>
    assert.rejects(waiters.wait({ signal: abort.signal, timeoutMs: 30000 }), {
      name: "AbortError",
    }),
  );
  assert.equal(getEventListeners(abort.signal, "abort").length, 1);
  abort.abort();
  await Promise.all(pending);
  assert.equal(waiters.pending.size, 0);
  assert.equal(waiters.signals.size, 0);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  assert.equal(emitter.listenerCount("event"), 0);
  await assert.rejects(waiters.wait({ signal: abort.signal }), {
    name: "AbortError",
  });
  const bad = assert.rejects(
    waiters.wait({
      matches: () => {
        throw new Error("bad filter");
      },
    }),
    /bad filter/,
  );
  const good = waiters.wait();
  emitter.emit("event", { type: "ready" });
  await bad;
  assert.equal((await good).type, "ready");
  const closing = Array.from({ length: 20 }, () =>
    waiters.wait({ timeoutMs: 30000 }),
  );
  waiters.close();
  assert.deepEqual(await Promise.all(closing), Array(20).fill(null));
  assert.equal(emitter.listenerCount("event"), 0);
  assert.equal(await waiters.wait(), null);
});

test("an HTTP disconnect cancels pending event reads and waits immediately", async (t) => {
  const { o, hub, gateway, config, store, spec, as } = await harness(t);
  const service = await createServer({ config, gateway });
  t.after(() => service.close());
  const baseline = o.listenerCount("event"),
    hubBaseline = hub.listenerCount("event");
  const call = (method, params, signal) =>
    fetch(service.origin + "/api/rpc", {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
    });
  const abort = new AbortController();
  const reads = Array.from({ length: 5 }, () =>
    assert.rejects(
      call("events", { after: store.cursor(), timeoutMs: 30000 }, abort.signal),
      { name: "AbortError" },
    ),
  );
  await until(() => o.eventWaiters.pending.size === 5);
  assert.equal(o.listenerCount("event"), baseline + 1);
  abort.abort();
  await Promise.all(reads);
  await until(() => o.eventWaiters.pending.size === 0);
  assert.equal(o.listenerCount("event"), baseline);
  // A wait on an agent that never finishes, abandoned by its client.
  o.updateSettings({ paused: true });
  const job = await as("lead").spawn(spec("Never runs"));
  const gone = new AbortController();
  const waiting = assert.rejects(
    call("wait", { ids: [job.id], timeoutMs: 60000 }, gone.signal),
    { name: "AbortError" },
  );
  await until(() => hub.listenerCount("event") === hubBaseline + 1);
  gone.abort();
  await waiting;
  await until(() => hub.listenerCount("event") === hubBaseline);
  assert.equal(hub.listenerCount("closing"), 0);
});
