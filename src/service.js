import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { root } from "./config.js";
import { dataDir, health, rpc } from "./client.js";
import { processAlive } from "./service-lock.js";

// Starting and stopping the on-demand service. The service lock names the
// process; /api/health must confirm it before anything is stopped.
const entry = resolve(root, "src/main.js");

export async function serviceState() {
  let lock = null;
  try {
    lock = JSON.parse(await readFile(join(dataDir(), "service.lock"), "utf8"));
  } catch {
    /* No lock: nothing runs. */
  }
  if (!lock || !processAlive(lock.pid))
    return { running: false, responsive: false, pid: null, url: null };
  const live = await health();
  const responsive = Boolean(
    live && live.pid === lock.pid && live.instance === lock.nonce,
  );
  return {
    running: true,
    responsive,
    pid: lock.pid,
    url: live?.url ?? null,
    active: live?.active ?? null,
    workspaces: live?.workspaces ?? null,
  };
}

export async function stopService({ timeoutMs = 20000, log = () => {} } = {}) {
  const state = await serviceState();
  if (!state.running) return { stopped: false, running: false };
  if (!state.responsive)
    throw new Error(
      `Pelican process ${state.pid} is alive but does not answer as the service that holds the lock; it was not stopped.`,
    );
  log(
    `Stopping Pelican process ${state.pid} and its ${state.active} active agent${state.active === 1 ? "" : "s"}.`,
  );
  await rpc("shutdown");
  const deadline = Date.now() + timeoutMs;
  while (processAlive(state.pid)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Process ${state.pid} has not stopped after ${Math.round(timeoutMs / 1000)} s. Its lock and agents were left alone.`,
      );
    await sleep(100);
  }
  return { stopped: true, pid: state.pid };
}

// Makes sure a service answers, and starts one when none does: in the
// background, without a window on Windows. A service that is starting is
// waited for; so is one that is stopping (it exits when idle), after which a
// new one starts. Startup errors land in
// .pelican/service.stderr.log; the service logs the rest itself.
export async function startService({ timeoutMs = 20000 } = {}) {
  const errors = join(dataDir(), "service.stderr.log");
  const deadline = Date.now() + timeoutMs;
  let child = null,
    exited = null;
  const launch = () => {
    let stderr = "ignore";
    try {
      stderr = openSync(errors, "a");
    } catch {
      /* The data folder may not exist before the first start. */
    }
    child = spawn(process.execPath, [entry], {
      cwd: root,
      env: process.env,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", stderr],
    });
    child.once("exit", (code) => {
      exited = code ?? 1;
    });
    child.unref();
    if (typeof stderr === "number") closeSync(stderr);
  };
  for (;;) {
    const state = await serviceState();
    if (state.responsive)
      return child
        ? { started: true, ...state }
        : { started: false, already: true, ...state };
    if (!state.running) {
      if (!child) launch();
      else if (exited !== null)
        throw new Error(
          `Pelican exited during startup (code ${exited}). See ${errors}.`,
        );
    }
    if (Date.now() >= deadline)
      throw new Error(
        `Pelican did not answer within ${Math.round(timeoutMs / 1000)} s (process ${state.pid ?? child?.pid}). See ${errors}.`,
      );
    await sleep(200);
  }
}
