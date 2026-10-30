import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, utimes, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Fleet } from "../src/fleet.js";
import { Store } from "../src/store.js";
import { allocateName } from "../src/identity.js";
import { pruneLogs } from "../src/logs.js";
import { harness } from "./helpers.js";

test("concurrent batches receive distinct durable identities", async (t) => {
  const { o, store, config, spec } = await harness(t);
  o.updateSettings({ paused: true });
  const batches = await Promise.all(
    Array.from({ length: 4 }, () =>
      o.createBatch(
        Array.from({ length: 25 }, () => spec("Same assignment")),
        "lead",
      ),
    ),
  );
  const jobs = batches.flat();
  assert.equal(
    new Set(jobs.map((job) => job.agentName.toLowerCase())).size,
    100,
  );
  const first = jobs[0];
  await o.stop(first.id);
  const again = new Fleet({ store, config });
  assert.equal(again.get(first.id).agentName, first.agentName);
  assert.equal(again.get(first.id).owner, "lead");
  assert.match(again.instructions(first), new RegExp(first.agentName));
  const next = await o.create(spec("Same assignment"), "lead");
  assert.ok(!jobs.some((job) => job.agentName === next.agentName));
});

test("name allocation remains collision-free after exhausting the base pool", () => {
  const reserved = new Set();
  const names = Array.from({ length: 1030 }, () =>
    allocateName("same-seed", reserved),
  );
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.at(-1).endsWith(" 2"));
});

test("the journal filters by type, prefix and owner", async (t) => {
  const { o, store, spec } = await harness(t);
  o.updateSettings({ paused: true });
  const mine = await o.create(spec("Mine"), "lead");
  const theirs = await o.create(spec("Theirs"), "reviewer");
  store.event(mine.id, "item/agentMessage/delta", { delta: "x" });
  store.event(theirs.id, "item/completed", { item: { type: "agentMessage" } });
  const created = store.events({ types: ["job.created"] });
  assert.deepEqual(
    created.map((e) => e.jobId),
    [mine.id, theirs.id],
  );
  assert.deepEqual(
    store.events({ types: ["item/*"] }).map((e) => e.type),
    ["item/agentMessage/delta", "item/completed"],
  );
  assert.deepEqual(
    store.events({ owner: "reviewer" }).map((e) => e.jobId),
    [theirs.id, theirs.id],
  );
  const after = created[0].seq;
  assert.ok(store.events({ after }).every((e) => e.seq > after));
});

test("retention expires week-old payloads and logs but keeps identities and newer history", async (t) => {
  const { o, store, dir, spec } = await harness(t);
  o.updateSettings({ paused: true });
  const job = await o.create(spec("Old agent"), "lead");
  await o.stop(job.id);
  job.finishedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  store.save(job);
  store.db.prepare("UPDATE events SET at=?").run(job.finishedAt);
  const current = store.event(null, "recent", {});
  await writeFile(join(dir, "service-2000-01-01.log"), "old");
  await utimes(join(dir, "service-2000-01-01.log"), new Date(0), new Date(0));
  await writeFile(join(dir, "unrelated.txt"), "keep");
  await o.prune();
  pruneLogs(dir);
  assert.deepEqual(
    store.events().map((event) => event.seq),
    [current.seq],
  );
  assert.equal(store.jobs()[0].agentName, job.agentName);
  assert.ok(job.historyExpiredAt);
  assert.equal(job.messages.length, 0);
  assert.ok(!(await readdir(dir)).includes("service-2000-01-01.log"));
  assert.ok((await readdir(dir)).includes("unrelated.txt"));
});

test("unchanged settings record nothing; cancellation and reassignment are journaled", async (t) => {
  const { o, store, spec } = await harness(t);
  o.updateSettings({ paused: true });
  const cursor = store.cursor();
  o.updateSettings({ paused: true, concurrency: o.settings.concurrency });
  assert.equal(store.cursor(), cursor);
  const job = await o.create(spec("Lifecycle"), "lead");
  await o.stop(job.id, "Not needed", true, "lead");
  o.resume(job.id, { prompt: "New work" }, "lead");
  const events = store.events({ after: cursor });
  assert.ok(events.some((e) => e.type === "job.created"));
  assert.equal(events.find((e) => e.type === "job.cancelled").data.by, "lead");
  assert.equal(
    events.find((e) => e.type === "job.resumed").data.prompt,
    "New work",
  );
});

test("saved data from the dashboard era migrates: settings, results and removed tables", async (t) => {
  const { dir, config } = await harness(t);
  const legacyDir = join(dir, "legacy");
  await import("node:fs/promises").then((fs) => fs.mkdir(legacyDir));
  const old = new Store(legacyDir);
  old.setSetting("scheduler", {
    concurrency: 3,
    paused: true,
    defaultCwd: dir,
  });
  old.setSetting("controller", { status: "idle" });
  old.db.exec(
    "CREATE TABLE board_threads (id TEXT); CREATE TABLE uploads (id TEXT, data TEXT);",
  );
  old.saveWork("work-item", { id: "w1" });
  old.saveWork("agent-request", { id: "q1" });
  old.save({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Old",
    prompt: "Old work",
    cwd: dir,
    resources: [],
    dependsOn: [],
    priority: 0,
    status: "completed",
    result: "It worked.",
    createdBy: { role: "orchestrator" },
    workId: "x",
    artifacts: [],
    createdAt: "2026-10-20T00:00:00.000Z",
    queuedAt: "2026-10-20T00:00:00.000Z",
  });
  old.close();
  const store = new Store(legacyDir);
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(!tables.includes("board_threads") && !tables.includes("uploads"));
  assert.equal(store.setting("controller", null), null);
  assert.equal(store.workRecord("work-item", "w1"), null);
  assert.ok(store.workRecord("agent-request", "q1"));
  const fleet = new Fleet({
    store,
    config: { ...config, workspaceDir: legacyDir },
  });
  assert.deepEqual(fleet.settings, {
    concurrency: 3,
    paused: true,
    model: "gpt-6.1-sol",
    effort: "high",
    network: false,
  });
  assert.equal(store.setting("scheduler", null), null);
  const job = fleet.get("11111111-1111-4111-8111-111111111111");
  assert.equal(job.summary, "It worked.");
  assert.equal(job.result, null);
  assert.equal(job.owner, "orchestrator");
  assert.equal(job.workId, undefined);
  assert.equal(job.artifacts, undefined);
  await fleet.shutdown();
  store.close();
});
