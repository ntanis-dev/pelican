import { spawn } from "node:child_process";
import { join } from "node:path";
import { codexLaunch } from "./cli-path.js";

// Runs one Codex sandbox command with an argument array, never a shell.
export function runCommand(
  { command, args, timeoutMs },
  cwd,
  { env = {} } = {},
) {
  let child, timer;
  const stop = () =>
    new Promise((done) => {
      if (!child?.pid || child.exitCode !== null) return done();
      if (process.platform === "win32") {
        const kill = spawn(
          "taskkill.exe",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, shell: false, stdio: "ignore" },
        );
        kill.once("error", () => {
          child.kill();
          done();
        });
        kill.once("close", done);
      } else {
        child.kill("SIGKILL");
        done();
      }
    });
  const promise = new Promise((done) => {
    let output = "",
      error = null,
      timedOut = false;
    const environment = { ...process.env, ...env };
    for (const name of Object.keys(environment))
      if (name.startsWith("PELICAN_")) delete environment[name];
    try {
      child = spawn(command, args, {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      done({ exitCode: null, error: e.message, output });
      return;
    }
    const append = (bytes) => {
      output = (output + bytes.toString()).slice(-64000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (e) => {
      error = e.message;
    });
    timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, timeoutMs);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      done({ exitCode, error, timedOut, output });
    });
  });
  return { promise, stop };
}

async function waitForLane(previous, signal) {
  signal?.throwIfAborted();
  let cancel;
  try {
    await Promise.race([
      previous,
      new Promise((_, reject) => {
        cancel = () => reject(signal.reason);
        signal?.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

// Only a capability/configuration refusal permits a legacy fallback. Timeouts,
// access errors and failed commands must stay visible, never silently downgrade.
export function mxcUnavailable(result) {
  return (
    !result.timedOut &&
    !result.error &&
    result.exitCode !== 0 &&
    /(?:mxc|execution containers?).{0,180}(?:not supported|unsupported|unavailable|not available|not enabled|disabled|not allowed|not permitted)|(?:unknown variant|invalid value)[^\n]*["']mxc["']/is.test(
      result.output || "",
    )
  );
}

// The command that proves a sandbox works: echo a marker inside it.
export const probeArgs = (implementation, sandbox = "workspace-write") => [
  "-c",
  `windows.sandbox=${implementation}`,
  "-c",
  `features.prefer_mxc=${implementation === "mxc"}`,
  "sandbox",
  "--include-managed-config",
  "--permission-profile",
  sandbox === "read-only" ? ":read-only" : ":workspace",
  "--",
  "cmd.exe",
  "/d",
  "/c",
  "echo PELICAN_SANDBOX_READY",
];
const probeReady = (result) =>
  result.exitCode === 0 &&
  !result.error &&
  !result.timedOut &&
  /(?:^|\r?\n)PELICAN_SANDBOX_READY\s*(?:\r?\n|$)/.test(result.output);

export class WindowsSandboxPreparation {
  constructor(config, { platform = process.platform, run = runCommand } = {}) {
    this.config = config;
    this.platform = platform;
    this.run = run;
    this.legacyLane = Promise.resolve();
    this.legacyFailure = null;
    this.prepared = new Set();
  }
  // Whether agents' sandbox works for a Codex home, without setting anything
  // up (so no administrator prompt). For pelican doctor.
  async check({ home, cwd }) {
    if (this.platform !== "win32") return { ready: true, implementation: null };
    const requested = this.config.windowsSandbox || "auto";
    const { command, prefix } = codexLaunch(this.config.codexBin || "codex");
    const probe = (implementation) =>
      this.run(
        {
          command,
          args: [...prefix, ...probeArgs(implementation)],
          timeoutMs: 45000,
        },
        cwd,
        { env: { CODEX_HOME: home, CODEX_SQLITE_HOME: home } },
      ).promise;
    let implementation = requested === "auto" ? "mxc" : requested;
    let result = await probe(implementation);
    if (requested === "auto" && mxcUnavailable(result)) {
      implementation = "elevated";
      result = await probe(implementation);
    }
    return {
      ready: probeReady(result),
      implementation,
      detail: probeReady(result)
        ? null
        : result.timedOut
          ? "timed out"
          : result.error ||
            result.output?.trim().slice(-600) ||
            `exit ${result.exitCode}`,
    };
  }
  async prepare({
    home,
    cwd,
    sandbox = "workspace-write",
    signal,
    onStatus = () => {},
  }) {
    if (this.platform !== "win32" || sandbox === "danger-full-access")
      return null;
    const requested = this.config.windowsSandbox || "auto";
    const startedAt = new Date().toISOString();
    let implementation = requested === "auto" ? "mxc" : requested;
    const update = (status, message) =>
      onStatus({
        status,
        implementation,
        startedAt,
        updatedAt: new Date().toISOString(),
        message,
      });
    const check = () => signal?.throwIfAborted();
    const { command: executable, prefix } = codexLaunch(
      this.config.codexBin || "codex",
    );
    const command = async (args, timeoutMs) => {
      check();
      const runner = this.run(
        { command: executable, args: [...prefix, ...args], timeoutMs },
        cwd,
        {
          env: { CODEX_HOME: home, CODEX_SQLITE_HOME: home },
        },
      );
      const cancel = () => {
        void runner.stop();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await runner.promise;
        check();
        return result;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    };
    const probe = () => command(probeArgs(implementation, sandbox), 45000);
    const requireSuccess = (result, phase) => {
      if (
        result.exitCode === 0 &&
        !result.error &&
        !result.timedOut &&
        (phase === "setup" ||
          /(?:^|\r?\n)PELICAN_SANDBOX_READY\s*(?:\r?\n|$)/.test(result.output))
      )
        return;
      const detail = result.timedOut
        ? "timed out"
        : result.error ||
          result.output?.trim().slice(-1800) ||
          `exit ${result.exitCode}`;
      throw new Error(
        `Windows ${implementation} sandbox ${phase} ${detail}. No model turn was started. ${implementation === "elevated" ? "Check for a Windows administrator prompt; the orchestrator cannot answer UAC. " : ""}Diagnostics: ${join(home, ".sandbox", "sandbox.log")}. Resolve setup, then resume explicitly.`,
      );
    };
    try {
      check();
      if (implementation === "mxc") {
        update("checking", "Checking Windows sandbox (MXC)");
        const result = await probe();
        if (requested === "auto" && mxcUnavailable(result))
          implementation = "elevated";
        else {
          requireSuccess(result, "check");
          update("ready", "Windows sandbox ready (MXC)");
          return implementation;
        }
      }
      // One legacy preparation at a time, including controllers. If it fails,
      // already-waiting launches inherit that failure instead of opening more
      // administrator dialogs. A later explicit launch may try again.
      const priorFailure = this.legacyFailure;
      const previous = this.legacyLane;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      this.legacyLane = previous.then(() => gate);
      update("queued", "Waiting for Windows sandbox setup");
      try {
        await waitForLane(previous, signal);
        check();
        if (this.legacyFailure !== priorFailure) throw this.legacyFailure;
        const key = JSON.stringify([home, cwd, implementation, executable]);
        if (implementation === "elevated" && !this.prepared.has(key)) {
          update(
            "preparing",
            "Preparing Windows sandbox · administrator approval may be required",
          );
          requireSuccess(
            await command(
              [
                "-c",
                "features.prefer_mxc=false",
                "sandbox",
                "setup",
                "--elevated",
                "--current-user",
                "--codex-home",
                home,
              ],
              120000,
            ),
            "setup",
          );
        }
        update("checking", "Checking Windows sandbox");
        requireSuccess(await probe(), "check");
        this.prepared.add(key);
      } catch (error) {
        if (!signal?.aborted) this.legacyFailure = error;
        throw error;
      } finally {
        release();
      }
      update("ready", `Windows sandbox ready (${implementation})`);
      return implementation;
    } catch (error) {
      if (!signal?.aborted) update("failed", error.message);
      throw error;
    }
  }
}
