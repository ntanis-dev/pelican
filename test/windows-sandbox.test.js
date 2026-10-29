import test from "node:test";
import assert from "node:assert/strict";
import { WindowsSandboxPreparation } from "../src/windows-sandbox.js";
import { CodexProcess } from "../src/codex.js";
import { until } from "./helpers.js";

const ready = { exitCode: 0, output: "PELICAN_SANDBOX_READY\r\n" };
const unavailable = {
  exitCode: 1,
  output: "MXC is not supported on this device",
};
const input = (home = "private-home") => ({
  home,
  cwd: "workspace",
  sandbox: "workspace-write",
});
function fixture(implementation = "auto", answer = () => ready) {
  const calls = [];
  const manager = new WindowsSandboxPreparation(
    { codexBin: process.execPath, windowsSandbox: implementation },
    {
      platform: "win32",
      run: (spec, cwd, options) => {
        calls.push({ spec, cwd, options });
        return {
          promise: Promise.resolve().then(() => answer(spec, cwd, options)),
          stop: async () => {},
        };
      },
    },
  );
  return { manager, calls };
}

test("auto uses MXC in the exact private home and workspace without elevated setup", async () => {
  const { manager, calls } = fixture();
  const statuses = [];
  assert.equal(
    await manager.prepare({ ...input(), onStatus: (s) => statuses.push(s) }),
    "mxc",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, "workspace");
  assert.equal(calls[0].options.env.CODEX_HOME, "private-home");
  assert.ok(calls[0].spec.args.includes("windows.sandbox=mxc"));
  assert.ok(calls[0].spec.args.includes("--include-managed-config"));
  assert.ok(calls[0].spec.args.includes(":workspace"));
  assert.deepEqual(
    statuses.map((s) => s.status),
    ["checking", "ready"],
  );
  await manager.prepare({ ...input(), sandbox: "read-only" });
  assert.ok(calls[1].spec.args.includes(":read-only"));
});

test("known MXC unavailability prepares elevated before checking it; resumes recheck readiness", async () => {
  const { manager, calls } = fixture("auto", (spec) =>
    spec.args.includes("windows.sandbox=mxc") ? unavailable : ready,
  );
  assert.equal(await manager.prepare(input()), "elevated");
  assert.ok(calls[1].spec.args.includes("setup"));
  assert.ok(calls[1].spec.args.includes("--current-user"));
  assert.ok(calls[2].spec.args.includes("windows.sandbox=elevated"));
  await manager.prepare(input());
  assert.equal(calls.filter((c) => c.spec.args.includes("setup")).length, 1);
  assert.equal(calls.length, 5);
});

test("timeouts, permissions failures and explicit MXC refusals never switch implementations", async () => {
  for (const result of [
    { exitCode: null, timedOut: true, output: "MXC unavailable" },
    { exitCode: 1, output: "Access denied while preparing MXC" },
    { exitCode: 0, output: "" },
  ]) {
    const { manager, calls } = fixture("auto", () => result);
    await assert.rejects(manager.prepare(input()), /No model turn was started/);
    assert.equal(calls.length, 1);
  }
  const { manager, calls } = fixture("mxc", () => unavailable);
  await assert.rejects(manager.prepare(input()), /not supported/);
  assert.equal(calls.length, 1);
});

test("legacy preparation serializes launches and shares failures with the existing queue", async () => {
  let finish;
  const { manager, calls } = fixture(
    "elevated",
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const first = manager.prepare(input("first"));
  const second = manager.prepare(input("second"));
  const results = Promise.allSettled([first, second]);
  await until(() => calls.length === 1);
  finish({ exitCode: 1, output: "Administrator setup declined" });
  assert.deepEqual(
    (await results).map((r) => r.status),
    ["rejected", "rejected"],
  );
  assert.equal(
    calls.length,
    1,
    "the queued worker must not open another UAC prompt",
  );
  assert.match(
    (await results)[1].reason.message,
    /Administrator setup declined/,
  );
  const retry = manager.prepare(input("second"));
  await until(() => calls.length === 2);
  finish(ready);
  await until(() => calls.length === 3);
  finish(ready);
  assert.equal(await retry, "elevated");
});

test("cancelling a queued preparation is immediate without letting successors overtake", async () => {
  let finish;
  const { manager, calls } = fixture(
    "elevated",
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const abort = new AbortController();
  const first = manager.prepare(input("first"));
  const second = manager.prepare({ ...input("second"), signal: abort.signal });
  const cancelled = assert.rejects(second, /Cancelled/);
  const third = manager.prepare(input("third"));
  await until(() => calls.length === 1);
  abort.abort(new Error("Cancelled"));
  await cancelled;
  assert.equal(calls.length, 1);
  finish(ready);
  await until(() => calls.length === 2);
  finish(ready);
  await first;
  await until(() => calls.length === 3);
  assert.equal(calls[2].options.env.CODEX_HOME, "third");
  finish(ready);
  await until(() => calls.length === 4);
  finish(ready);
  await third;
});

test("stopping Codex during preparation stops the owned check without launching app-server", async () => {
  let stopCount = 0,
    finish;
  const manager = new WindowsSandboxPreparation(
    { codexBin: process.execPath },
    {
      platform: "win32",
      run: () => ({
        promise: new Promise((r) => {
          finish = r;
        }),
        stop: async () => {
          stopCount++;
          finish({ exitCode: null });
        },
      }),
    },
  );
  const proc = new CodexProcess({
    prepareSandbox: (_, signal) => manager.prepare({ ...input(), signal }),
  });
  const starting = assert.rejects(proc.start(), /cancelled/);
  await until(() => !!finish);
  await proc.close();
  await starting;
  assert.equal(stopCount, 1);
  assert.equal(proc.child, undefined);
  assert.equal(proc.closed, true);
});

test("setup errors prevent app-server launch; non-Windows and full-access jobs do not prepare a sandbox", async () => {
  const proc = new CodexProcess({
    prepareSandbox: async () => {
      throw new Error("Setup failed");
    },
  });
  await assert.rejects(proc.start(), /Setup failed/);
  await proc.close();
  assert.equal(proc.child, undefined);
  const { manager, calls } = fixture();
  assert.equal(
    await manager.prepare({ ...input(), sandbox: "danger-full-access" }),
    null,
  );
  manager.platform = "linux";
  assert.equal(await manager.prepare(input()), null);
  assert.equal(calls.length, 0);
});
