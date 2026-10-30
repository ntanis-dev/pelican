import test from "node:test";
import assert from "node:assert/strict";
import { watchIdle } from "../src/idle.js";
import { harness, until } from "./helpers.js";

// A clock the test moves, and a gateway that says what is going on.
function fixture(t, idleMs = 1000) {
  let time = 10000;
  const busy = { calls: 0, agents: 0, runs: 0, lastCall: 10000 };
  const exits = [];
  const watch = watchIdle({
    gateway: { busy: () => ({ ...busy }) },
    idleMs,
    onIdle: () => exits.push(time),
    now: () => time,
  });
  t.after(() => watch.stop());
  return {
    busy,
    exits,
    // The clock moves, and the watch looks.
    advance: (ms) => {
      time += ms;
      watch.check();
    },
    at: () => time,
  };
}

test("the service exits once nothing has used it for the idle time", (t) => {
  const { advance, exits } = fixture(t);
  advance(999);
  assert.deepEqual(exits, []);
  advance(1);
  assert.equal(exits.length, 1);
});

test("a call in flight, agents running or queued, or a workflow run keep it up", (t) => {
  for (const [key, value] of [
    ["calls", 1],
    ["agents", 2],
    ["runs", 1],
  ]) {
    const { advance, busy, exits } = fixture(t);
    busy[key] = value;
    advance(5000);
    advance(5000);
    assert.deepEqual(exits, [], key);
    // The idle time counts from when it stopped.
    busy[key] = 0;
    advance(999);
    assert.deepEqual(exits, [], key);
    advance(1);
    assert.equal(exits.length, 1, key);
  }
});

test("a call made lately keeps it up for the idle time after it ended", (t) => {
  const { advance, busy, exits, at } = fixture(t);
  advance(900);
  busy.lastCall = at();
  advance(900);
  assert.deepEqual(exits, []);
  advance(100);
  assert.equal(exits.length, 1);
});

test("the gateway counts calls in flight, agents running or queued to run, and the last call", async (t) => {
  const { gateway, as, spec, o, workers } = await harness(t);
  const lead = as("lead");
  const quiet = gateway.busy();
  assert.deepEqual([quiet.calls, quiet.agents, quiet.runs], [0, 0, 0]);

  const job = await lead.spawn(spec("Busy"));
  await until(() => o.get(job.id).status === "running");
  assert.equal(gateway.busy().agents, 1);
  // A wait holds its call open.
  const waiting = lead.wait([job.id], { timeoutMs: 5000 });
  await until(() => gateway.busy().calls === 1);
  const before = gateway.busy().lastCall;
  workers[0].complete();
  await waiting;
  await until(() => gateway.busy().calls === 0);
  assert.ok(gateway.busy().lastCall >= before);
  await until(() => gateway.busy().agents === 0);

  // Queued agents will run, unless their workspace is paused.
  await lead.settings({ paused: true });
  await lead.spawn(spec("Paused one"));
  assert.equal(gateway.busy().agents, 0);
  await lead.settings({ paused: false });
  await until(() => gateway.busy().agents === 1);
});
