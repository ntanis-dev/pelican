import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ProtocolPump } from "./protocol-pump.js";
import { heartbeatTimeoutMs, heartbeatRecoveryMs } from "./worker-lease.js";

export class CodexProcess extends EventEmitter {
  constructor({
    bin = "codex",
    args,
    cwd,
    env,
    prepareHome,
    prepareSandbox,
    timeoutMs = 45000,
    leaseTimeoutMs = heartbeatTimeoutMs,
    leaseRecoveryMs = heartbeatRecoveryMs,
  } = {}) {
    super();
    this.options = {
      bin,
      args,
      cwd,
      env,
      prepareHome,
      prepareSandbox,
      timeoutMs,
      leaseTimeoutMs,
      leaseRecoveryMs,
    };
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.closing = false;
    this.preparationAbort = new AbortController();
  }
  async start() {
    const { bin, args, cwd, env, prepareHome, prepareSandbox, timeoutMs } =
      this.options;
    const privateHome = prepareHome?.();
    this.preparation = prepareSandbox?.(
      privateHome,
      this.preparationAbort.signal,
    );
    const sandboxConfig = await this.preparation;
    this.preparationAbort.signal.throwIfAborted();
    const childEnv = {
      ...process.env,
      ...env,
      ...(privateHome ? { CODEX_HOME: privateHome } : {}),
    };
    if (privateHome) delete childEnv.CODEX_SQLITE_HOME;
    for (const name of Object.keys(childEnv))
      if (name.startsWith("PELICAN_") || name === "CODEX_THREAD_ID")
        delete childEnv[name];
    const workerArgs = args ?? [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "agents.enabled=false",
      "-c",
      'mcp_servers.pelican={enabled=false,command="node",args=[]}',
      ...Object.entries(sandboxConfig || {}).flatMap(([key, value]) => [
        "-c",
        `${key}=${JSON.stringify(value)}`,
      ]),
      ...(privateHome
        ? [
            "-c",
            `sqlite_home=${JSON.stringify(privateHome)}`,
            "-c",
            `log_dir=${JSON.stringify(join(privateHome, "log"))}`,
            "-c",
            'cli_auth_credentials_store="file"',
          ]
        : []),
    ];
    this.child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./worker-host.js", import.meta.url)),
        bin,
        ...workerArgs,
      ],
      {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    const heartbeat = () => {
      if (this.child.connected)
        this.child.send(
          {
            type: "heartbeat",
            timeoutMs: this.options.leaseTimeoutMs,
            recoveryMs: this.options.leaseRecoveryMs,
          },
          () => {},
        );
    };
    heartbeat();
    this.leaseTimer = setInterval(
      heartbeat,
      Math.min(2000, Math.max(50, this.options.leaseTimeoutMs / 4)),
    );
    this.leaseTimer.unref();
    this.child.on("message", (message) => {
      if (message?.type === "launchError")
        this.supervisorError = message.message;
      if (["heartbeatDelayed", "heartbeatRecovered"].includes(message?.type))
        this.emit("diagnostic", {
          ...message,
          message:
            message.type === "heartbeatRecovered"
              ? `Pelican heartbeat recovered after ${Math.round(message.silenceMs / 1000)}s; the worker kept running.`
              : `Pelican heartbeat is delayed; allowing ${Math.round(message.recoveryMs / 1000)}s to recover before interrupting the worker.`,
        });
      if (message?.type === "leaseExpired") {
        this.supervisorInterrupted = true;
        this.supervisorError = `Pelican did not respond for ${Math.round(message.silenceMs / 1000)}s; the supervisor interrupted this agent. Review its changes before resuming.`;
      }
    });
    this.child.stdin.on("error", (error) =>
      this.emit("diagnostic", { message: error.message }),
    );
    this.child.on("error", (error) => this.finish(error));
    this.child.on("close", (code, signal) => {
      this.output.end(() => {
        // Codex says why it stopped on stderr; the exit code alone does not.
        const cause = this.stderrError ? `: ${this.stderrError}` : "";
        this.finish(
          new Error(
            this.supervisorError ?? `Codex exited (${code ?? signal})${cause}`,
          ),
        );
      });
    });
    this.output = new ProtocolPump(
      this.child.stdout,
      (message) => {
        if (message.method && message.id !== undefined)
          this.emit("request", message);
        else if (message.method) this.emit("notification", message);
        else if (message.id !== undefined) {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(message.id);
          if (message.error)
            entry.reject(
              Object.assign(new Error(message.error.message), {
                rpcCode: message.error.code,
              }),
            );
          else entry.resolve(message.result);
        }
      },
      (data) => this.emit("diagnostic", data),
    );
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      if (
        /\berror\b|\bfailed\b|panick/i.test(line) &&
        !/^\s*warning\b/i.test(line)
      )
        this.stderrError = line.trim().slice(0, 500);
      this.emit("diagnostic", { message: line.slice(0, 8000) });
    });
    await this.request(
      "initialize",
      {
        clientInfo: { name: "pelican", title: "Pelican", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      timeoutMs,
    );
    this.send({ method: "initialized", params: {} });
    return this;
  }
  send(message) {
    if (this.closed || !this.child?.stdin.writable)
      throw new Error("Codex connection is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params = {}, timeoutMs = this.options.timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  reply(id, result) {
    this.send({ id, result });
  }
  reject(id, message) {
    this.send({ id, error: { code: -32601, message } });
  }
  finish(error) {
    if (this.closed) return;
    clearInterval(this.leaseTimer);
    this.output?.close();
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit("exit", {
      message: error.message,
      expected: this.closing,
      interrupted: this.supervisorInterrupted === true,
    });
  }
  async close() {
    if (this.closed) return;
    this.closing = true;
    this.preparationAbort.abort(
      new Error("Windows sandbox preparation cancelled"),
    );
    await this.preparation?.catch(() => {});
    const child = this.child;
    if (!child?.pid) {
      this.finish(new Error("Closed"));
      return;
    }
    // Kill only our tracked process tree, never other Codex sessions.
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const kill = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        kill.once("error", () => {
          child.kill();
          resolve();
        });
        kill.once("close", resolve);
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
      if (!this.closed) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }
    if (!this.closed)
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    this.finish(new Error("Closed by Pelican"));
  }
}

const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
// The only tools an agent gets from Pelican. Everything else it does with its
// own shell inside the sandbox.
export const dynamicTools = [
  {
    name: "pelican_report",
    description:
      "Hand your final report to your orchestrator when the assignment is done: report says what you changed, what you ran and what happened, and anything unresolved. If your instructions give a result schema, result is JSON text that must validate against it; Pelican checks it and tells you what to fix. Call it once at the end, then finish your turn.",
    inputSchema: object(
      {
        report: string,
        result: {
          type: "string",
          description:
            "The structured result as JSON text, when your instructions ask for one.",
        },
      },
      ["report"],
    ),
  },
  {
    name: "pelican_ask",
    description:
      "Ask your orchestrator a question that blocks your assignment, and wait for its answer. There is no human to ask. Make ordinary decisions yourself and keep working on anything that does not depend on the answer.",
    inputSchema: object({ question: string }),
  },
  {
    name: "pelican_message",
    description:
      "Send your orchestrator a short note (progress, a finding, a heads-up). It does not wait for a reply and does not end your turn.",
    inputSchema: object({ message: string }),
  },
  {
    name: "pelican_inbox",
    description:
      "Read messages your orchestrator sent you: unread ones, or specific ids in full. New messages also arrive by themselves; do not poll.",
    inputSchema: object(
      { ids: { type: "array", items: string, maxItems: 20 } },
      [],
    ),
  },
].map((tool) => ({ type: "function", ...tool }));

export const toolResult = (value) => ({
  contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  success: true,
});
