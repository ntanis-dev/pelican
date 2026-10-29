import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireServiceLock } from "../src/service-lock.js";
import { harness, until } from "./helpers.js";
import { createServer } from "../src/server.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { root } from "../src/config.js";
import { loadConfig } from "../src/config.js";

test(
  "restart replaces the verified service, retains fleet state and releases the old lock",
  { timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pelican-restart-"));
    const folder = await mkdtemp(join(tmpdir(), "pelican-restart-work-"));
    const config = await loadConfig({ dataDir: dir });
    await writeFile(
      join(dir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: "restart",
            name: "Restart",
            folder,
            dir: "workspaces/restart",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await until(() =>
        children.every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
      );
      await rm(dir, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    });
    const launch = (entry) => {
      const env = {
        ...process.env,
        PELICAN_DATA_DIR: dir,
        PELICAN_PORT: "0",
        PELICAN_TOKEN: config.token,
      };
      delete env.PELICAN_URL;
      const child = spawn(process.execPath, [join(root, entry)], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.output = "";
      child.stdout.on("data", (chunk) => {
        child.output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        child.output += chunk;
      });
      return child;
    };
    const ready = async (child) => {
      await until(
        () =>
          child.output.includes("Pelican is listening") ||
          child.exitCode !== null,
        10000,
      );
      assert.equal(child.exitCode, null, child.output);
      return JSON.parse(await readFile(join(dir, "connection.json"), "utf8"));
    };
    const call = async (url, method, params = {}) => {
      const response = await fetch(url + "/api/rpc", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const first = launch("src/main.js");
    const before = await ready(first);
    await call(before.url, "settings", {
      workspace: "restart",
      concurrency: 7,
    });
    const replacement = launch("scripts/restart.js");
    const after = await ready(replacement);
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.pid, replacement.pid);
    assert.equal(first.exitCode, 0);
    assert.match(replacement.output, /Stopping Pelican process/);
    assert.equal(
      JSON.parse(await readFile(join(dir, "service.lock"), "utf8")).pid,
      after.pid,
    );
    const status = await call(after.url, "status");
    assert.equal(status.workspaces[0].settings.concurrency, 7);
    assert.equal(status.totals.working, 0);
    await call(after.url, "shutdown");
    await until(() => replacement.exitCode !== null);
    assert.equal(replacement.exitCode, 0);
    await assert.rejects(readFile(join(dir, "service.lock")), {
      code: "ENOENT",
    });
  },
);

test("a healthy existing service returns its verified identity without acquiring another lock", async (t) => {
  const { o, config } = await harness(t);
  config.instanceId = "existing-instance";
  const service = await createServer({ config, fleet: o });
  t.after(() => service.close());
  const path = join(config.dataDir, "service.lock");
  const original = JSON.stringify({
    pid: process.pid,
    nonce: config.instanceId,
  });
  await writeFile(path, original);
  await writeFile(
    join(config.dataDir, "connection.json"),
    JSON.stringify({ pid: process.pid, url: service.origin }),
  );
  const duplicate = await acquireServiceLock(config, "new-instance");
  assert.deepEqual(duplicate, {
    acquired: false,
    pid: process.pid,
    url: service.origin,
    responsive: true,
  });
  assert.equal(await readFile(path, "utf8"), original);
  const startedAgain = await promisify(execFile)(
    process.execPath,
    [join(root, "src/main.js")],
    {
      env: {
        ...process.env,
        PELICAN_DATA_DIR: config.dataDir,
        PELICAN_TOKEN: config.token,
      },
      windowsHide: true,
    },
  );
  assert.match(startedAgain.stdout, /Pelican is already running/);
  assert.equal(startedAgain.stderr, "");
});

test("a live unresponsive owner keeps its lock; a dead owner can be recovered and released", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pelican-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    token: "test-only",
  };
  const path = join(dir, "service.lock"),
    original = JSON.stringify({ pid: 12345, nonce: "old" });
  await writeFile(path, original);
  const held = await acquireServiceLock(config, "new", () => true);
  assert.equal(held.acquired, false);
  assert.equal(held.responsive, false);
  assert.equal(await readFile(path, "utf8"), original);
  const recovered = await acquireServiceLock(config, "new", () => false);
  assert.equal(recovered.acquired, true);
  assert.equal(JSON.parse(await readFile(path, "utf8")).nonce, "new");
  await recovered.release();
  await assert.rejects(readFile(path), { code: "ENOENT" });
});
