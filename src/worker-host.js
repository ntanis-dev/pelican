// A pipe-lifetime supervisor with a recovery window for delayed heartbeats.
// It deliberately has no model logic or controller credentials.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCodexBin } from "./cli-path.js";
import { WorkerLease } from "./worker-lease.js";

const checkMode = process.argv[2] === "--pelican-check";
const [bin, ...args] = process.argv.slice(checkMode ? 3 : 2);
if (!bin) throw new Error("Missing worker executable");
let executable = checkMode ? bin : resolveCodexBin(bin);
let workerArgs = args;
if (process.platform === "win32") {
  if (/\.(cmd|bat)$/i.test(executable)) {
    if (checkMode)
      throw new Error(
        "Use an executable and argument array for verification, or select an interpreter explicitly.",
      );
    const launcher = join(
      dirname(executable),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (!existsSync(launcher))
      throw new Error(
        "Cannot launch this Codex shell shim. Set CODEX_BIN to codex.exe.",
      );
    executable = process.execPath;
    workerArgs = [launcher, ...args];
  }
}
const child = spawn(executable, workerArgs, {
  shell: false,
  windowsHide: true,
  stdio: [checkMode ? "ignore" : "pipe", "pipe", "pipe"],
});
let stopping = false;
let lease;
if (process.connected) {
  lease = new WorkerLease({
    notify: (message) => {
      if (process.connected) process.send(message, () => {});
    },
    expire: (message) => {
      if (process.connected) process.send(message, () => {});
      process.stderr.write(
        "Pelican did not recover during the heartbeat recovery window; interrupting this worker.\n",
      );
      void stop();
    },
  });
  process.on("message", (message) => {
    if (message?.type === "heartbeat") lease.renew(message);
  });
  process.on("disconnect", () => {
    void stop();
  });
}
async function stop() {
  if (stopping) return;
  stopping = true;
  lease?.close();
  if (!child.pid) return process.exit(1);
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const kill = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      kill.on("close", resolve);
      kill.on("error", () => {
        child.kill();
        resolve();
      });
    });
  } else {
    // The host is the process-group leader; this also terminates command descendants.
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  process.exit(0);
}
if (!checkMode) process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin?.on("error", () => {});
process.stdout.on("error", () => {
  void stop();
});
process.stderr.on("error", () => {
  void stop();
});
process.stdin.on("end", () => {
  if (!checkMode) void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
child.on("error", (error) => {
  const message = checkMode
    ? `Could not launch verification command (${error.code ?? "launch failed"}). Check its executable path.`
    : `Could not launch Codex CLI (${error.code ?? "launch failed"}). Install Codex CLI or set CODEX_BIN to its executable.`;
  process.stderr.write(message + "\n");
  if (process.connected)
    process.send({ type: "launchError", message }, () => process.exit(1));
  else process.exit(1);
});
child.on(checkMode ? "close" : "exit", (code) => {
  if (stopping) return;
  // Codex's last words (why it exited) may still be in its stderr pipe: let
  // them through, but never wait on pipes a command it started holds open.
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    process.stderr.write("", () => process.exit(code ?? 1));
  };
  if (checkMode || child.stderr.readableEnded) return exit();
  child.stderr.once("end", exit);
  setTimeout(exit, 500).unref();
});
