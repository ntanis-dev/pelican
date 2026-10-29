import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { connect } from "../src/client.js";
import { serviceState, startService, stopService } from "../src/service.js";
import { processAlive } from "../src/service-lock.js";
import { until } from "./helpers.js";

// Real service processes: Pelican starts when a call needs it, stays while it
// is used and exits when idle. Each runs in a data folder of its own with
// Codex missing (the usage read then fails quietly) and a three-second idle
// time.
const idleMinutes = 0.05;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockGone = () =>
  readFile(join(process.env.PELICAN_DATA_DIR, "service.lock")).then(
    () => false,
    (error) => error.code === "ENOENT",
  );

test(
  "the service starts when a call needs it, stays while it is used and exits when idle",
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pelican-life-"));
    Object.assign(process.env, {
      PELICAN_DATA_DIR: dir,
      PELICAN_PORT: "0",
      PELICAN_IDLE_MINUTES: String(idleMinutes),
      CODEX_BIN: join(dir, "no-codex"),
    });
    delete process.env.PELICAN_URL;
    t.after(async () => {
      await stopService().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    });
    assert.equal((await serviceState()).running, false);

    // The first call starts it.
    const pelican = connect({ as: "lead", cwd: dir });
    const status = await pelican.status();
    assert.equal(status.service.idleMinutes, idleMinutes);
    const first = await serviceState();
    assert.ok(first.responsive);
    assert.notEqual(first.pid, process.pid);

    // It stays while it is used, longer than the idle time.
    for (let i = 0; i < 6; i++) {
      await wait(1000);
      await pelican.status();
    }
    assert.equal((await serviceState()).pid, first.pid);

    // Left alone, it exits, and its lock goes with it.
    await until(() => !processAlive(first.pid), 20000);
    assert.ok(await lockGone());

    // pelican status says so without starting it.
    const out = [];
    const code = await main(["status"], {
      print: (text) => out.push(text),
      error: (text) => out.push(text),
    });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /Pelican is not running\. It starts when/);
    assert.equal((await serviceState()).running, false);

    // The next call that needs it starts another.
    await pelican.status();
    const second = await serviceState();
    assert.ok(second.responsive);
    assert.notEqual(second.pid, first.pid);
    await until(() => !processAlive(second.pid), 20000);

    // stop-service ends a running one at once.
    const third = await startService();
    assert.equal(third.started, true);
    assert.equal((await stopService()).stopped, true);
    assert.equal((await serviceState()).running, false);
  },
);
