import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  agentCodexHome,
  sharedCodexHome,
  agentRollout,
  prepareAgentCodexHome,
  removeAgentCodexHome,
  wipeAgentCodexHomes,
} from "../src/codex-home.js";
import { Fleet } from "../src/fleet.js";
import { root } from "../src/config.js";
import { harness, until } from "./helpers.js";

async function fixture(t) {
  const fixture = await harness(t);
  const source = join(fixture.dir, "original-cli-home");
  mkdirSync(source);
  writeFileSync(join(source, "auth.json"), '{"token":"test-only-source"}');
  writeFileSync(join(source, "config.toml"), "do_not_copy = true");
  fixture.config.codexSourceHome = source;
  return { ...fixture, source };
}

test("workers share one Pelican home and sign-in refresh while the desktop home stays untouched", async (t) => {
  const { config, source } = await fixture(t);
  const first = { id: randomUUID() };
  const second = { id: randomUUID() };
  const a = prepareAgentCodexHome(config, first);
  const b = prepareAgentCodexHome(config, second);
  assert.equal(a, resolve(config.dataDir, "codex-home"));
  assert.equal(a, b);
  assert.equal(first.codexHomeLayout, "shared");
  assert.equal(first.privateCodexHome, true);
  assert.equal(existsSync(join(a, "config.toml")), false);
  assert.equal(
    readFileSync(join(a, "auth.json"), "utf8"),
    readFileSync(join(source, "auth.json"), "utf8"),
  );
  writeFileSync(join(a, "auth.json"), '{"token":"worker-refresh"}');
  prepareAgentCodexHome(config, first);
  assert.match(readFileSync(join(a, "auth.json"), "utf8"), /worker-refresh/);
  assert.match(
    readFileSync(join(source, "auth.json"), "utf8"),
    /test-only-source/,
  );
  assert.match(readFileSync(join(b, "auth.json"), "utf8"), /worker-refresh/);
  writeFileSync(join(source, "auth.json"), '{"token":"new-login"}');
  prepareAgentCodexHome(config, first);
  assert.match(readFileSync(join(a, "auth.json"), "utf8"), /new-login/);
  rmSync(join(source, "auth.json"));
  prepareAgentCodexHome(config, first);
  assert.equal(existsSync(join(a, "auth.json")), false);
});

test("legacy resume imports only its saved rollout and reuses the shared copy", async (t) => {
  const { config, source } = await fixture(t);
  const threadId = randomUUID();
  const relativeRollout = join(
    "sessions",
    "2026",
    "10",
    "10",
    `rollout-now-${threadId}.jsonl`,
  );
  mkdirSync(join(source, "sessions", "2026", "10", "10"), { recursive: true });
  writeFileSync(join(source, relativeRollout), "saved transcript\n");
  writeFileSync(join(source, "sessions", "unrelated.jsonl"), "unrelated chat");
  const job = { id: randomUUID(), threadId };
  const home = prepareAgentCodexHome(config, job);
  assert.equal(
    readFileSync(join(home, relativeRollout), "utf8"),
    "saved transcript\n",
  );
  assert.equal(existsSync(join(home, "sessions", "unrelated.jsonl")), false);
  assert.equal(existsSync(join(source, relativeRollout)), true);
  writeFileSync(join(home, relativeRollout), "resumed transcript\n");
  prepareAgentCodexHome(config, job);
  assert.equal(
    readFileSync(join(home, relativeRollout), "utf8"),
    "resumed transcript\n",
  );
  await removeAgentCodexHome(config.dataDir, job.id, {
    shared: true,
    threadId,
    deleteThread: async (target, id) => {
      assert.equal(target, home);
      assert.equal(id, threadId);
      rmSync(join(home, relativeRollout));
    },
  });
  prepareAgentCodexHome(config, job);
  assert.equal(existsSync(join(home, relativeRollout)), false);
  const missing = { id: randomUUID(), threadId: randomUUID() };
  assert.throws(
    () => prepareAgentCodexHome(config, missing),
    /Saved Codex session was not found/,
  );
  assert.equal(missing.privateCodexHome, undefined);
});

test("production worker launch overrides inherited home and resume reuses it", async (t) => {
  const { config, store, spec } = await fixture(t);
  const o = new Fleet({ config, store });
  t.after(() => o.shutdown());
  o.windowsSandbox.prepare = async () => "mxc";
  const factory = o.workerFactory;
  // Run the real supervisor and environment assembly with a deterministic CLI.
  o.workerFactory = (job) => {
    const proc = factory(job);
    proc.options.bin = process.execPath;
    proc.options.args = [join(root, "test/fixtures/fake-codex.js")];
    proc.options.env = { CODEX_HOME: config.codexSourceHome };
    return proc;
  };
  const jobs = await o.createBatch(
    [spec("First", { resources: [] }), spec("Second", { resources: [] })],
    "lead",
  );
  await until(() => jobs.every((job) => job.status === "running"));
  for (const job of jobs) {
    const actual = await o.active.get(job.id).proc.request("test/home");
    assert.deepEqual(actual, { home: sharedCodexHome(config.dataDir) });
  }
  const job = jobs[0];
  const home = sharedCodexHome(config.dataDir);
  writeFileSync(join(home, "retained-session"), "resume marker");
  const threadId = job.threadId;
  await o.stop(job.id);
  o.resume(job.id, {}, "lead");
  await until(() => job.status === "running");
  assert.equal(job.threadId, threadId);
  assert.equal(
    readFileSync(join(home, "retained-session"), "utf8"),
    "resume marker",
  );
  assert.equal(
    (await o.active.get(job.id).proc.request("test/home")).home,
    home,
  );
  await o.shutdown();
});

test("legacy worker migration preserves each exact conversation and unrelated shared state", async (t) => {
  const { config } = await fixture(t);
  const first = {
    id: randomUUID(),
    threadId: randomUUID(),
    privateCodexHome: true,
  };
  const second = {
    id: randomUUID(),
    threadId: randomUUID(),
    privateCodexHome: true,
  };
  for (const job of [first, second]) {
    const sessions = join(
      agentCodexHome(config.dataDir, job.id),
      "sessions",
      "2026",
    );
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `rollout-old-${job.threadId}.jsonl`), job.id);
    writeFileSync(
      join(sessions, `rollout-unrelated-${randomUUID()}.jsonl`),
      "unrelated",
    );
  }
  const shared = prepareAgentCodexHome(config, first);
  writeFileSync(join(shared, "state.sqlite"), "existing shared index");
  prepareAgentCodexHome(config, second);
  for (const job of [first, second]) {
    assert.equal(
      readFileSync(agentRollout(config.dataDir, job), "utf8"),
      job.id,
    );
    assert.ok(agentRollout(config.dataDir, job).startsWith(shared));
  }
  const secondRollout = agentRollout(config.dataDir, second);
  await removeAgentCodexHome(config.dataDir, first.id, {
    shared: true,
    threadId: first.threadId,
    deleteThread: async () => rmSync(agentRollout(config.dataDir, first)),
  });
  assert.equal(readFileSync(secondRollout, "utf8"), second.id);
  assert.equal(
    readFileSync(join(shared, "state.sqlite"), "utf8"),
    "existing shared index",
  );
  assert.equal(existsSync(agentCodexHome(config.dataDir, first.id)), false);
  assert.equal(existsSync(agentCodexHome(config.dataDir, second.id)), true);
});

test("a redirected shared home is rejected before migration or deletion", async (t) => {
  const { config, source } = await fixture(t);
  const shared = sharedCodexHome(config.dataDir);
  symlinkSync(
    source,
    shared,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => prepareAgentCodexHome(config, { id: randomUUID() }),
    /ordinary directory/,
  );
  await assert.rejects(
    wipeAgentCodexHomes(config.dataDir),
    /ordinary directory/,
  );
  await assert.rejects(
    removeAgentCodexHome(config.dataDir, randomUUID(), {
      shared: true,
      threadId: randomUUID(),
      deleteThread: async () =>
        assert.fail("Must not call Codex on a redirected home"),
    }),
    /ordinary directory/,
  );
  assert.ok(existsSync(join(source, "auth.json")));
  rmSync(shared);
});

test("invalid IDs and redirected home parents cannot escape Pelican cleanup", async (t) => {
  const { config, source } = await fixture(t);
  assert.throws(
    () => agentCodexHome(config.dataDir, "../original-cli-home"),
    /Invalid agent ID/,
  );
  const homes = join(config.dataDir, "codex-homes");
  symlinkSync(source, homes, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => prepareAgentCodexHome(config, { id: randomUUID() }),
    /ordinary directories/,
  );
  await assert.rejects(
    () => wipeAgentCodexHomes(config.dataDir),
    /ordinary directories/,
  );
  assert.match(
    readFileSync(join(source, "auth.json"), "utf8"),
    /test-only-source/,
  );
  rmSync(homes);
});

test("worker authentication refuses linked files", async (t) => {
  const { config, source } = await fixture(t);
  const job = { id: randomUUID() };
  const home = sharedCodexHome(config.dataDir);
  mkdirSync(home, { recursive: true });
  linkSync(join(source, "auth.json"), join(home, "auth.json"));
  assert.throws(
    () => prepareAgentCodexHome(config, job),
    /linked or invalid file/,
  );
  await wipeAgentCodexHomes(config.dataDir);
  assert.ok(existsSync(join(source, "auth.json")));
});
