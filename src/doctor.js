import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAccount } from "./account.js";
import { codexLaunch } from "./cli-path.js";
import { runCommand, WindowsSandboxPreparation } from "./windows-sandbox.js";
import { serviceState } from "./service.js";

// What Pelican needs to run agents: Node 24+, the Codex CLI, a ChatGPT
// sign-in, the service, and on Windows a working sandbox. Each check is
// { name, ok (true, false, or null when it does not apply), detail }.
export async function doctor(config, { platform = process.platform } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const major = Number(process.versions.node.split(".")[0]);
  add(
    "Node.js",
    major >= 24,
    `${process.version}${major >= 24 ? "" : " (Pelican needs 24 or later)"}`,
  );
  let launch = null;
  try {
    launch = codexLaunch(config.codexBin);
    const result = await runCommand(
      {
        command: launch.command,
        args: [...launch.prefix, "--version"],
        timeoutMs: 20000,
      },
      process.cwd(),
    ).promise;
    const version = result.output.trim().split(/\r?\n/).at(-1);
    add(
      "Codex CLI",
      result.exitCode === 0,
      result.exitCode === 0
        ? `${version} (${launch.command})`
        : `${launch.command} did not run: ${result.error ?? version ?? `exit ${result.exitCode}`}. Install it or set CODEX_BIN.`,
    );
  } catch (error) {
    add("Codex CLI", false, error.message);
  }
  const account = new CodexAccount({ config });
  try {
    const state = await Promise.race([
      account.status(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("no answer within 30 s")),
          30000,
        ).unref(),
      ),
    ]);
    add(
      "ChatGPT sign-in",
      state.connected,
      state.connected
        ? `signed in${state.account?.plan ? ` (${state.account.plan})` : ""}`
        : "not signed in: run pelican login",
    );
  } catch (error) {
    add("ChatGPT sign-in", false, `could not ask Codex: ${error.message}`);
  } finally {
    await account.close();
  }
  const service = await serviceState();
  add(
    "Service",
    service.responsive ? true : service.running ? false : null,
    service.responsive
      ? `running at ${service.url} (process ${service.pid}, ${service.active} active agents)`
      : service.running
        ? `process ${service.pid} holds the lock but does not answer`
        : "not running (it starts when a command needs it)",
  );
  if (platform !== "win32") {
    add("Windows sandbox", null, "not Windows; Codex's own sandbox applies");
    return checks;
  }
  let records = [];
  try {
    records =
      JSON.parse(readFileSync(join(config.dataDir, "workspaces.json"), "utf8"))
        .workspaces ?? [];
  } catch {
    /* No workspaces yet. */
  }
  const sandbox = new WindowsSandboxPreparation(config);
  for (const record of records) {
    const home = join(
      record.dir ? resolve(config.dataDir, record.dir) : config.dataDir,
      "codex-home",
    );
    const name = `Windows sandbox (${record.id})`;
    if (!existsSync(home)) {
      add(name, null, "set up when its first agent starts");
      continue;
    }
    try {
      const result = await sandbox.check({ home, cwd: record.folder });
      add(
        name,
        result.ready,
        result.ready
          ? `ready (${result.implementation})`
          : `${result.implementation} not ready: ${result.detail}. The next agent sets it up (an administrator prompt may appear).`,
      );
    } catch (error) {
      add(name, false, error.message);
    }
  }
  if (!records.length) add("Windows sandbox", null, "no workspaces yet");
  return checks;
}
