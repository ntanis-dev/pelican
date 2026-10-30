import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { liveSeries, metricWindow, metrics } from "../src/metrics.js";
import { feedTypes } from "../src/gateway.js";
import { api, reads } from "../src/api.js";
import { main } from "../src/cli.js";
import * as format from "../src/format.js";
import { harness, until } from "./helpers.js";

// metrics: time series from the journal. The synthetic journals below are
// written with chosen times, so every number is known.
const minute = 60000;
const now = Date.parse("2026-10-24T20:00:30.000Z");
const iso = (ms) => new Date(ms).toISOString();

async function journal(t) {
  const dir = await mkdtemp(join(tmpdir(), "pelican-metrics-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const insert = store.db.prepare(
    "INSERT INTO events(job_id,type,at,data) VALUES (?,?,?,?)",
  );
  const write = (msAgo, jobId, type, data = {}) =>
    insert.run(jobId, type, iso(now - msAgo), JSON.stringify(data));
  return { store, write };
}
const fleetOf = (store, jobs = [], concurrency = 4) => ({
  store,
  jobs: new Map(jobs.map((j) => [j.id, { pending: [], ...j }])),
  settings: { concurrency },
});
const read = (fleet, extra = {}) =>
  metrics({
    records: [{ id: "ws", name: "Workspace" }],
    fleets: new Map([["ws", fleet]]),
    feedTypes,
    minutes: 10,
    bucketSeconds: 60,
    now,
    ...extra,
  });

test("the window is aligned to the clock and refuses too many buckets", () => {
  const w = metricWindow({ minutes: 10, bucketSeconds: 60, now });
  assert.equal(w.count, 10);
  assert.equal(iso(w.from), "2026-10-24T19:51:00.000Z");
  assert.equal(w.to, now);
  // The default: the window in 60 buckets, at least 5 seconds each.
  assert.equal(metricWindow({ minutes: 60, now }).bucketSeconds, 60);
  assert.equal(metricWindow({ minutes: 1, now }).bucketSeconds, 5);
  assert.throws(
    () => metricWindow({ minutes: 10080, bucketSeconds: 60, now }),
    (error) => error.statusCode === 400 && /too many/.test(error.message),
  );
});

test("agents live is the most at once in each bucket", () => {
  const from = 0,
    bucketMs = 10,
    count = 4;
  // [0,15] and [12,35] overlap in the second bucket; [30,30] lives for an
  // instant; [38,60] runs past the window.
  const live = liveSeries(
    [
      [0, 15],
      [12, 35],
      [30, 30],
      [38, 60],
    ],
    { from, to: 40, bucketMs, count },
  );
  assert.deepEqual(live, [1, 2, 1, 2]);
  assert.deepEqual(
    liveSeries([], { from, to: 40, bucketMs, count }),
    [0, 0, 0, 0],
  );
});

test("series from a journal: starts, ends, failures, tokens, events and questions per bucket", async (t) => {
  const { store, write } = await journal(t);
  // Before the window: A starts (and used 1000 tokens); B starts and finishes.
  write(20 * minute, "A", "job.started", { owner: "lead", status: "starting" });
  write(19 * minute, "A", "thread/tokenUsage/updated", {
    tokenUsage: { total: { totalTokens: 1000 } },
  });
  write(18 * minute, "B", "job.started", { owner: "lead" });
  write(17 * minute, "B", "job.finished", {
    owner: "lead",
    status: "completed",
  });
  // In the window (19:51:00 to 20:00:30, buckets of a minute).
  write(8 * minute, "A", "thread/tokenUsage/updated", {
    tokenUsage: { total: { totalTokens: 1500 } },
  });
  write(7 * minute, "C", "job.created", { owner: "reviewer" });
  write(7 * minute - 1000, "C", "job.started", { owner: "reviewer" });
  write(6 * minute, "C", "thread/tokenUsage/updated", {
    tokenUsage: { total: { totalTokens: 300 } },
  });
  write(5 * minute, "C", "agent.question", { owner: "reviewer" });
  write(4 * minute, "A", "job.finished", { owner: "lead", status: "failed" });
  // A followup: C's turn ends with its next assignment, which starts again.
  write(3 * minute, "C", "job.resumed", { owner: "reviewer", by: "reviewer" });
  write(3 * minute - 500, "C", "job.started", { owner: "reviewer" });
  write(2 * minute, null, "orchestrator.note", { by: "lead", owner: "lead" });
  // Raw Codex events are not feed events.
  write(1 * minute, "C", "item/agentMessage/delta", { delta: "x" });
  const fleet = fleetOf(store, [
    {
      id: "A",
      owner: "lead",
      status: "failed",
      startedAt: iso(now - 20 * minute),
    },
    { id: "B", owner: "lead", status: "completed" },
    {
      id: "C",
      owner: "reviewer",
      status: "running",
      startedAt: iso(now - 3 * minute),
    },
  ]);
  const m = read(fleet);
  assert.equal(m.buckets.length, 10);
  assert.equal(m.buckets[0], "2026-10-24T19:51:00.000Z");
  assert.equal(m.bucketSeconds, 60);
  // Buckets: 0 = 19:51 ... 9 = 20:00 (the current one).
  assert.deepEqual(m.series.live, [1, 1, 2, 2, 2, 2, 1, 1, 1, 1]);
  assert.deepEqual(m.series.started, [0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(m.series.finished, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(m.series.failed, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  // A's 500 tokens since the window began (its total was 1000 before), and
  // C's first 300.
  assert.deepEqual(m.series.tokens, [0, 500, 0, 300, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(m.series.questions, [0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  // created, started, question, finished, resumed, started, note.
  assert.deepEqual(m.series.events, [0, 0, 2, 0, 1, 1, 2, 1, 0, 0]);
  assert.deepEqual(m.totals, {
    peak: 2,
    started: 2,
    finished: 1,
    failed: 1,
    tokens: 800,
    events: 7,
    questions: 1,
  });
  assert.deepEqual(m.now, {
    working: 1,
    queued: 0,
    questions: 0,
    concurrency: 4,
  });
  // The same per workspace and per orchestrator, the busiest first.
  assert.equal(m.workspaces.length, 1);
  assert.deepEqual(m.workspaces[0].series, m.series);
  assert.deepEqual(
    m.owners.map((o) => [o.name, o.totals.events, o.totals.tokens]),
    [
      ["reviewer", 5, 300],
      ["lead", 2, 500],
    ],
  );
  assert.deepEqual(
    m.owners.find((o) => o.name === "lead").series.live,
    [1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
  );
  assert.deepEqual(m.owners.find((o) => o.name === "reviewer").now, {
    working: 1,
    queued: 0,
    questions: 0,
    concurrency: 0,
  });
  // owner narrows everything to one orchestrator's agents and entries.
  const lead = read(fleet, { owner: "lead" });
  assert.equal(lead.owner, "lead");
  assert.deepEqual(lead.totals, {
    peak: 1,
    started: 0,
    finished: 1,
    failed: 1,
    tokens: 500,
    events: 2,
    questions: 0,
  });
  assert.deepEqual(
    lead.owners.map((o) => o.name),
    ["lead"],
  );
});

test("an agent live through the whole window counts in every bucket", async (t) => {
  const { store, write } = await journal(t);
  write(30 * minute, "A", "job.started", { owner: "lead" });
  const fleet = fleetOf(store, [
    {
      id: "A",
      owner: "lead",
      status: "running",
      startedAt: iso(now - 30 * minute),
    },
  ]);
  const m = read(fleet);
  assert.deepEqual(m.series.live, new Array(10).fill(1));
  assert.equal(m.totals.started, 0);
  // A resume long after a finish does not make the agent live before it.
  const { store: other, write: log } = await journal(t);
  log(30 * minute, "B", "job.started", { owner: "lead" });
  log(25 * minute, "B", "job.finished", { owner: "lead", status: "completed" });
  log(5 * minute, "B", "job.resumed", { owner: "lead", by: "lead" });
  log(5 * minute - 100, "B", "job.started", { owner: "lead" });
  const resumed = read(
    fleetOf(other, [
      {
        id: "B",
        owner: "lead",
        status: "running",
        startedAt: iso(now - 5 * minute),
      },
    ]),
  );
  assert.deepEqual(resumed.series.live, [0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
});

test("seqAt finds the first entry at or after a time, across gaps", async (t) => {
  const { store, write } = await journal(t);
  assert.equal(store.seqAt(iso(now)), 1);
  for (let i = 10; i >= 1; i--) write(i * minute, null, "warning", {});
  store.db.prepare("DELETE FROM events WHERE seq IN (3,4,5)").run();
  // seq n was written (11 - n) minutes ago.
  assert.equal(store.seqAt(iso(now - 20 * minute)), 1);
  assert.equal(store.seqAt(iso(now - 8 * minute)), 3);
  const first = store.db
    .prepare("SELECT MIN(seq) AS s FROM events WHERE seq >= ?")
    .get(store.seqAt(iso(now - 8 * minute))).s;
  assert.equal(first, 6);
  assert.equal(store.seqAt(iso(now - 2 * minute)), 9);
  assert.equal(store.seqAt(iso(now)), 11);
});

test("the gateway, the CLI and MCP offer metrics", async (t) => {
  assert.ok(api.metrics && reads.has("metrics"));
  const { o, as, spec, workers, gateway, dir } = await harness(t);
  const lead = as("lead", { cwd: dir });
  const job = await lead.spawn(spec("Count", { name: "Count the TODOs" }));
  await until(() => o.get(job.id).status === "running");
  workers[0].emit("notification", {
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { total: { totalTokens: 4200 } } },
  });
  workers[0].call("pelican_ask", { question: "Which folder?" }, "ask-1");
  await until(() => o.get(job.id).pending.length === 1);
  const m = await lead.metrics({ minutes: 5, bucketSeconds: 30 });
  assert.equal(m.buckets.length, 10);
  assert.equal(m.totals.started, 1);
  assert.equal(m.totals.tokens, 4200);
  assert.equal(m.totals.questions, 1);
  assert.equal(m.series.live.at(-1), 1);
  assert.deepEqual(m.now, {
    working: 1,
    queued: 0,
    questions: 1,
    concurrency: o.settings.concurrency,
  });
  assert.deepEqual(
    m.owners.map((x) => x.name),
    ["lead"],
  );
  assert.equal(m.workspaces[0].id, "test-ws");
  // Bad parameters are refused.
  await assert.rejects(
    gateway.invoke("metrics", { minutes: 0 }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    gateway.invoke("metrics", { minutes: 10080, bucketSeconds: 5 }),
    (error) => error.statusCode === 400 && /too many/.test(error.message),
  );
  // pelican metrics prints sparklines.
  const out = [];
  const code = await main(["metrics", "--minutes", "5", "--bucket", "30"], {
    print: (text) => out.push(text),
    error: (text) => out.push(text),
    client: gateway.as("lead", { cwd: dir }),
  });
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(
    text,
    /^Activity of every workspace, \d\d:\d\d to \d\d:\d\d \(10 buckets of 30s\):/,
  );
  assert.match(text, /^ {2}tokens {5}[▁-█]{10} {2}4\.2k$/m);
  assert.match(text, /^ {2}questions {2}[▁-█]{10} {2}1, 1 open now$/m);
  assert.match(
    text,
    /^By orchestrator:\n {2}lead {2}live [▁-█]{10} {2}peak 1 · 1 working · 4\.2k tokens · \d+ events$/m,
  );
  assert.equal(format.spark([0, 1, 2, 4]), "▁▃▅█");
});
