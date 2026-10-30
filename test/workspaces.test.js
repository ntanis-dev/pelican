import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FakeWorker, until } from "./helpers.js";
import { Store } from "../src/store.js";
import { Workspaces } from "../src/workspaces.js";
import { Gateway } from "../src/gateway.js";
import { createServer } from "../src/server.js";

async function setup(t, { legacy = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "pelican-workspaces-"));
  const root = await mkdtemp(join(tmpdir(), "pelican-folders-"));
  const alpha = join(root, "alpha"),
    beta = join(root, "beta"),
    inner = join(root, "alpha", "inner");
  await mkdir(alpha);
  await mkdir(beta);
  await mkdir(inner);
  if (legacy) {
    const store = new Store(dataDir);
    store.setSetting("scheduler", {
      concurrency: 3,
      paused: true,
      defaultCwd: alpha,
    });
    store.close();
  }
  const config = {
    dataDir,
    codexBin: "codex",
    token: "test-only-token-12345678901234567890",
    host: "127.0.0.1",
    port: 0,
  };
  const workers = [];
  const hub = await Workspaces.open({
    config,
    workerFactory: (job) => {
      const worker = new FakeWorker(job);
      workers.push(worker);
      return worker;
    },
  });
  const gateway = new Gateway(hub, { account: { close: async () => {} } });
  t.after(async () => {
    await hub.shutdown();
    hub.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  return {
    hub,
    gateway,
    config,
    workers,
    alpha: await realpath(alpha),
    beta: await realpath(beta),
    inner: await realpath(inner),
  };
}
const spec = (name, extra = {}) => ({
  name,
  prompt: `Complete ${name}`,
  resources: [],
  ...extra,
});

test("existing data becomes the first workspace in place, settings migrated", async (t) => {
  const { hub, config, alpha } = await setup(t, { legacy: true });
  const [first] = hub.list();
  assert.equal(first.name, basename(alpha));
  assert.equal(first.folder, alpha);
  assert.deepEqual(first.settings, {
    concurrency: 3,
    paused: true,
    model: "gpt-6.1-sol",
    effort: "high",
    network: false,
  });
  const saved = JSON.parse(
    readFileSync(join(config.dataDir, "workspaces.json"), "utf8"),
  );
  assert.equal(saved.workspaces[0].dir, null);
  assert.equal(
    hub.fleet(first.id).store.path,
    join(config.dataDir, "pelican.sqlite"),
  );
});

test("adding workspaces checks the folder and name; they survive a reopen", async (t) => {
  const { hub, alpha, beta, inner, config } = await setup(t);
  assert.deepEqual(hub.list(), []);
  assert.throws(() => hub.resolve({}), { statusCode: 409 });
  await assert.rejects(hub.add({ folder: "relative/path" }), /absolute/);
  await assert.rejects(
    hub.add({ folder: join(alpha, "missing") }),
    /does not exist/,
  );
  await assert.rejects(hub.add({ folder: config.dataDir }), /private data/);
  const a = await hub.add({ folder: alpha });
  assert.equal(a.name, "alpha");
  assert.equal(a.settings.concurrency, 4);
  await assert.rejects(
    hub.add({ folder: beta, name: "ALPHA" }),
    /already called/,
  );
  await assert.rejects(
    hub.add({ folder: alpha, name: "Again" }),
    /already uses this folder/,
  );
  const b = await hub.add({ folder: beta, name: "Beta" });
  assert.deepEqual(b.overlaps, []);
  const c = await hub.add({ folder: inner });
  assert.deepEqual(c.overlaps, [a.id]);
  assert.ok(
    existsSync(join(config.dataDir, "workspaces", a.id, "pelican.sqlite")),
  );
  assert.notEqual(hub.fleet(a.id).store.path, hub.fleet(b.id).store.path);
  // By id or name; by folder the most specific one wins.
  assert.equal(hub.record("beta").id, b.id);
  assert.equal(hub.resolve({ paths: [join(inner, "src")] }).id, c.id);
  assert.equal(hub.resolve({ paths: [alpha] }).id, a.id);
  assert.throws(
    () => hub.resolve({ paths: [config.dataDir] }),
    /Choose a workspace/,
  );
  const reopened = await Workspaces.open({ config });
  try {
    assert.deepEqual(
      reopened.list().map((w) => [w.name, w.folder]),
      [
        ["alpha", alpha],
        ["Beta", beta],
        ["inner", inner],
      ],
    );
  } finally {
    await reopened.shutdown();
    reopened.close();
  }
});

test("each workspace keeps its own folder, settings and queue", async (t) => {
  const { hub, gateway, alpha, beta, workers } = await setup(t);
  const a = await hub.add({ folder: alpha });
  const b = await hub.add({ folder: beta });
  const lead = gateway.as("lead");
  await lead.settings({ workspace: a.id, paused: true });
  const changed = await lead.settings({
    workspace: b.id,
    concurrency: 2,
    model: "gpt-6.1-mini",
    effort: "medium",
    network: true,
  });
  assert.deepEqual(changed.settings, {
    concurrency: 2,
    paused: false,
    model: "gpt-6.1-mini",
    effort: "medium",
    network: true,
  });
  await assert.rejects(
    lead.settings({ workspace: b.id, concurrency: 0 }),
    /concurrency/,
  );
  await assert.rejects(
    lead.settings({ workspace: b.id, folder: alpha }),
    /folder/,
  );
  // The agent's cwd picks its workspace, and its folder bounds it.
  const queued = await lead.spawn(spec("Alpha task", { cwd: alpha }));
  assert.equal(queued.workspace, a.id);
  assert.equal(queued.status, "queued");
  await assert.rejects(
    lead.spawn(spec("Escapes", { workspace: b.id, cwd: alpha })),
    /inside this workspace/,
  );
  // New agents take the workspace's model, effort and network.
  const running = await lead.spawn(spec("Beta task", { cwd: beta }));
  assert.equal(running.model, "gpt-6.1-mini");
  assert.equal(running.effort, "medium");
  await until(() => workers.length === 1);
  await until(() => hub.fleet(b.id).get(running.id).status === "running");
  assert.equal(
    workers[0].last("turn/start").params.sandboxPolicy.networkAccess,
    true,
  );
  // Agents are found across workspaces by id, prefix or name.
  assert.equal((await lead.get(queued.id.slice(0, 6))).workspace, a.id);
  assert.equal((await lead.get(running.agentName)).workspace, b.id);
  const rows = await lead.list();
  assert.deepEqual(rows.map((r) => r.workspace).sort(), [a.id, b.id].sort());
  assert.equal((await lead.list({ workspace: a.id })).length, 1);
  assert.equal(
    (await gateway.as("lead", { workspace: b.id }).list()).length,
    1,
  );
  const status = await lead.status();
  assert.equal(status.totals.working, 1);
  assert.equal(status.totals.queued, 1);
  // Events belong to one workspace: named, or found from the caller's folder.
  await assert.rejects(lead.events(), /Choose a workspace/);
  const page = await gateway.as("lead", { cwd: alpha }).events();
  assert.equal(page.workspace, a.id);
  assert.ok(
    page.events.some((e) => e.type === "job.created" && e.jobId === queued.id),
  );
  assert.ok(!page.events.some((e) => e.jobId === running.id));
});

test("only a quiet workspace can be removed; its own data goes with it", async (t) => {
  const { hub, gateway, alpha, beta, config } = await setup(t, {
    legacy: true,
  });
  const [first] = hub.list();
  const b = await hub.add({ folder: beta });
  const lead = gateway.as("lead");
  const job = await lead.spawn(spec("Busy", { cwd: beta }));
  await assert.rejects(lead.removeWorkspace(b.id), /Stop them first/);
  await lead.stop({ id: job.id });
  await until(() => !hub.fleet(b.id).active.size);
  const dir = join(config.dataDir, "workspaces", b.id);
  assert.ok(existsSync(dir));
  const removed = await lead.removeWorkspace(b.id);
  assert.deepEqual(removed.data, { removed: dir });
  assert.ok(!existsSync(dir));
  assert.deepEqual(
    hub.list().map((w) => w.id),
    [first.id],
  );
  await assert.rejects(lead.get(job.id), /No agent/);
  // The first workspace's data lives in Pelican's data folder and stays.
  const kept = await lead.removeWorkspace(first.id);
  assert.deepEqual(kept.data, { kept: config.dataDir });
  assert.ok(existsSync(join(config.dataDir, "pelican.sqlite")));
  const saved = JSON.parse(
    readFileSync(join(config.dataDir, "workspaces.json"), "utf8"),
  );
  assert.deepEqual(saved.workspaces, []);
  await assert.rejects(
    lead.spawn(spec("Nowhere", { cwd: alpha })),
    /No workspace exists/,
  );
});

test("over HTTP a caller's folder picks the workspace", async (t) => {
  const { hub, gateway, config, alpha, beta, inner } = await setup(t);
  await hub.add({ folder: alpha });
  const b = await hub.add({ folder: beta });
  const c = await hub.add({ folder: inner });
  for (const id of [b.id, c.id]) hub.fleet(id).updateSettings({ paused: true });
  const service = await createServer({ config, gateway });
  t.after(() => service.close());
  const call = async (method, params, cwd) => {
    const response = await fetch(service.origin + "/api/rpc", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        "x-pelican-as": "lead",
        ...(cwd ? { "x-pelican-cwd": encodeURIComponent(cwd) } : {}),
      },
      body: JSON.stringify({ method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  const nested = await call("spawn", spec("Nested"), join(inner, "deep"));
  assert.equal(nested.body.result.workspace, c.id);
  assert.equal(hub.fleet(c.id).get(nested.body.result.id).cwd, inner);
  const sibling = await call("spawn", spec("Sibling"), beta);
  assert.equal(sibling.body.result.workspace, b.id);
  const lost = await call("spawn", spec("Lost"));
  assert.equal(lost.status, 409);
  assert.match(lost.body.error, /Choose a workspace/);
});
