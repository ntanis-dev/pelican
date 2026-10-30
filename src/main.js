import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { Workspaces } from "./workspaces.js";
import { Gateway } from "./gateway.js";
import { CodexAccount } from "./account.js";
import { createServer } from "./server.js";
import { installLogging, pruneLogs } from "./logs.js";
import { acquireServiceLock } from "./service-lock.js";
import { watchIdle } from "./idle.js";

// The Pelican service: every workspace's queue and agents behind one HTTP RPC.
// It starts when a command, the menu or an orchestrator needs it and exits
// once nothing has used it for config.idleMinutes (see idle.js).
const config = await loadConfig();
const nonce = randomUUID();
config.instanceId = nonce;
let lease;
try {
  lease = await acquireServiceLock(config, nonce);
} catch (error) {
  console.error(`Pelican could not start: ${error.message}`);
  process.exit(1);
}
if (!lease.acquired) {
  if (lease.responsive)
    console.log(
      `Pelican is already running at ${lease.url} (process ${lease.pid}).\nTo restart it and stop its agents, run: pelican restart`,
    );
  else
    console.error(
      `Pelican process ${lease.pid} is still alive but its API is not responding.\nIts agents may still be running. The lock was kept to prevent a second service.\nTry pelican restart; if shutdown times out, the service and its agents need recovery before starting again.`,
    );
  process.exit(lease.responsive ? 0 : 1);
}
installLogging(config.dataDir);
const workspaces = await Workspaces.open({ config });
const account = new CodexAccount({ config });
let maintaining;
// Every 15 minutes, and once at the start: the service may not live that long.
function maintain() {
  if (maintaining) return;
  maintaining = (async () => {
    try {
      await workspaces.prune();
      pruneLogs(config.dataDir);
    } catch (error) {
      console.error("History maintenance:", error.message);
    }
  })().finally(() => {
    maintaining = null;
  });
}
const maintenance = setInterval(maintain, 15 * 60000);
maintenance.unref();
let http;
let idle;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  idle?.stop();
  clearInterval(maintenance);
  await workspaces.shutdown();
  await http?.close();
  await account.close();
  await maintaining;
  workspaces.close();
  await lease.release();
}
const gateway = new Gateway(workspaces, {
  account,
  service: { instance: nonce, idleMinutes: config.idleMinutes },
  onShutdown: () => void stop().then(() => process.exit(0)),
});
try {
  http = await createServer({ config, gateway });
  await writeFile(
    resolve(config.dataDir, "connection.json"),
    JSON.stringify({ url: http.origin, pid: process.pid }, null, 2),
    { mode: 0o600 },
  );
  const summary =
    workspaces
      .list()
      .map(
        (w) =>
          `${w.id} (${w.settings.concurrency} at once, network ${w.settings.network ? "on" : "off"}${w.settings.paused ? ", paused" : ""})`,
      )
      .join(", ") || "none yet (pelican workspace add <folder>)";
  console.log(
    `Pelican is listening at ${http.origin}\nAccess token: ${config.tokenPath}\nWorkspaces: ${summary}`,
  );
  workspaces.schedule();
  account.watchUsage();
  maintain();
  idle = watchIdle({
    gateway,
    idleMs: config.idleMinutes * 60000,
    onIdle: () => {
      console.log(
        `Pelican is idle (nothing running or asked for in ${config.idleMinutes} min): exiting. The next command starts it again.`,
      );
      void stop().then(() => process.exit(0));
    },
  });
} catch (error) {
  await workspaces.shutdown();
  workspaces.close();
  await lease.release();
  throw error;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"])
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
