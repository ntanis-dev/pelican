import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { CodexProcess } from "../src/codex.js";
import { root } from "../src/config.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { until } from "./helpers.js";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("a missing CLI reports the launch cause instead of only an exit code", async () => {
  const proc = new CodexProcess({
    bin: join(root, "test/fixtures/missing-codex.exe"),
  });
  try {
    await assert.rejects(proc.start(), /Could not launch Codex CLI \(ENOENT\)/);
    assert.equal(proc.closed, true);
  } finally {
    await proc.close();
  }
});

test("CLI transport handles RPC, notifications, server questions, errors, timeout and process termination", async () => {
  const proc = new CodexProcess({
    bin: process.execPath,
    args: [join(root, "test/fixtures/fake-codex.js")],
    timeoutMs: 3000,
  });
  try {
    await proc.start();
    const notification = once(proc, "notification");
    assert.deepEqual(
      await proc.request("echo", { literal: "$() ` not a shell command" }),
      { literal: "$() ` not a shell command" },
    );
    assert.equal((await notification)[0].method, "test/notification");
    const question = once(proc, "request");
    await proc.request("ask");
    assert.equal((await question)[0].id, 100);
    await assert.rejects(proc.request("fail"), /Expected failure/);
    await assert.rejects(proc.request("hang", {}, 30), /timed out/);
    const pending = proc.request("hang").catch((error) => error.message);
    await proc.close();
    assert.match(await pending, /exited|Closed/);
    assert.equal(proc.closed, true);
    assert.throws(() => process.kill(proc.child.pid, 0));
  } finally {
    await proc.close();
  }
});

test("a Codex crash reports its stderr cause with the exit code", async () => {
  const proc = new CodexProcess({
    bin: process.execPath,
    args: [join(root, "test/fixtures/fake-codex.js")],
    timeoutMs: 3000,
  });
  try {
    await proc.start();
    const exit = once(proc, "exit");
    await assert.rejects(
      proc.request("die"),
      /^Error: Codex exited \(1\): Error: failed to initialize sqlite state runtime/,
    );
    const [{ message }] = await exit;
    assert.match(message, /failed to initialize sqlite state runtime/);
    assert.doesNotMatch(message, /warning/);
  } finally {
    await proc.close();
  }
});

test("worker supervisor terminates its CLI when its controller disappears", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(root, "test/fixtures/orphan-parent.js")],
    { windowsHide: true },
  );
  const ids = JSON.parse(stdout);
  const alive = (id) => {
    try {
      process.kill(id, 0);
      return true;
    } catch {
      return false;
    }
  };
  await until(() => !alive(ids.host) && !alive(ids.cli), 5000);
});

test("worker supervisor interrupts its CLI only after the heartbeat recovery window expires", async () => {
  const proc = new CodexProcess({
    bin: process.execPath,
    args: [join(root, "test/fixtures/fake-codex.js")],
    leaseTimeoutMs: 400,
    leaseRecoveryMs: 600,
  });
  try {
    await proc.start();
    const { pid: cliPid } = await proc.request("pid");
    const hostPid = proc.child.pid;
    const exited = once(proc, "exit");
    clearInterval(proc.leaseTimer);
    const [result] = await exited;
    assert.match(result.message, /supervisor interrupted this agent/);
    assert.equal(result.interrupted, true);
    assert.throws(() => process.kill(hostPid, 0));
    assert.throws(() => process.kill(cliPid, 0));
  } finally {
    await proc.close();
  }
});

test("a stalled service event loop does not kill its workers and records recovery", async () => {
  const workers = Array.from(
    { length: 3 },
    () =>
      new CodexProcess({
        bin: process.execPath,
        args: [join(root, "test/fixtures/fake-codex.js")],
        leaseTimeoutMs: 200,
        leaseRecoveryMs: 3000,
      }),
  );
  const diagnostics = [];
  for (const proc of workers)
    proc.on("diagnostic", (event) => diagnostics.push(event));
  try {
    await Promise.all(workers.map((proc) => proc.start()));
    // Reproduce a synchronous DB/CPU stall: the supervisors continue running
    // while the real controller thread cannot send any heartbeat.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
    await until(
      () =>
        diagnostics.filter((d) => d.type === "heartbeatRecovered").length === 3,
    );
    for (const proc of workers) {
      assert.equal(proc.closed, false);
      assert.deepEqual(await proc.request("echo", { recovered: true }), {
        recovered: true,
      });
    }
    assert.equal(
      diagnostics.filter((d) => d.type === "heartbeatDelayed").length,
      3,
    );
  } finally {
    await Promise.all(workers.map((proc) => proc.close()));
  }
});

test(
  "Windows npm Codex launcher runs through Node without executing its shell shim",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pelican-shim-"));
    const packageDir = join(dir, "node_modules", "@openai", "codex", "bin");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(dir, "codex.cmd"), "exit /b 99");
    await writeFile(
      join(packageDir, "..", "package.json"),
      '{"type":"module"}',
    );
    await copyFile(
      join(root, "test/fixtures/fake-codex.js"),
      join(packageDir, "codex.js"),
    );
    const proc = new CodexProcess({
      bin: join(dir, "codex.cmd"),
      timeoutMs: 3000,
    });
    try {
      await proc.start();
      assert.deepEqual(await proc.request("echo", { ok: true }), { ok: true });
    } finally {
      await proc.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
