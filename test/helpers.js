import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Store } from "../src/store.js";
import { Fleet } from "../src/fleet.js";
import { Workspaces } from "../src/workspaces.js";
import { Gateway } from "../src/gateway.js";
import { networkKey } from "../src/worker-permissions.js";

export async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A Codex app-server stand-in: it records requests and lets a test drive
// notifications, tool calls and turn completion.
export class FakeWorker extends EventEmitter {
  constructor(job) {
    super();
    this.child = { pid: 42 };
    this.requests = [];
    this.replies = [];
    this.closed = false;
    this.job = job;
    this.turns = 0;
  }
  async start() {
    return this;
  }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start" || method === "thread/resume")
      return {
        thread: { id: params.threadId ?? "thread-" + Math.random() },
        cwd: params.cwd,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandbox: {
          type: {
            "read-only": "readOnly",
            "workspace-write": "workspaceWrite",
            "danger-full-access": "dangerFullAccess",
          }[params.sandbox],
          writableRoots: [],
          networkAccess: params.config?.[networkKey] === true,
        },
      };
    if (method === "turn/start") {
      this.turnId = `turn-${++this.turns}`;
      this.emit("notification", {
        method: "turn/started",
        params: { turn: { id: this.turnId } },
      });
      return { turn: { id: this.turnId } };
    }
    if (method === "turn/interrupt") this.complete("interrupted");
    return {};
  }
  last(method) {
    return this.requests.findLast((r) => r.method === method);
  }
  // A worker's tool call or approval request, as Codex sends it.
  call(tool, args = {}, id = `call-${Math.random()}`) {
    this.emit("request", {
      id,
      method: "item/tool/call",
      params: { tool, arguments: args },
    });
    return id;
  }
  reply(id, result) {
    this.replies.push({ id, result });
  }
  reject(id, error) {
    this.replies.push({ id, error });
  }
  answer(id) {
    return this.replies.find((r) => r.id === id);
  }
  say(text, phase = "final_answer") {
    this.emit("notification", {
      method: "item/completed",
      params: {
        item: { id: `msg-${Math.random()}`, type: "agentMessage", text, phase },
      },
    });
  }
  complete(status = "completed") {
    this.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: this.turnId || "turn-1", status } },
    });
  }
  async close() {
    this.closed = true;
  }
}

// One workspace on a temporary folder, with fake Codex workers, and the
// gateway over it. as(name) calls the gateway under an orchestrator's name.
export async function harness(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pelican-test-"));
  const store = new Store(dir),
    workers = [];
  const config = {
    dataDir: dir,
    codexBin: "codex",
    token: "test-only-token-12345678901234567890",
    host: "127.0.0.1",
    port: 0,
    workspace: { id: "test-ws", name: "Test", folder: dir },
  };
  const o = new Fleet({
    store,
    config,
    workerFactory: (job) => {
      const worker = new FakeWorker(job);
      workers.push(worker);
      return worker;
    },
    ...overrides,
  });
  const hub = Workspaces.single(o);
  // What the account adapter says about usage, and how it was asked.
  const usageCalls = [];
  const usage = {
    at: new Date(Date.now() - 12 * 60000).toISOString(),
    error: null,
    plan: "pro",
    allowed: true,
    reached: null,
    credits: { unlimited: false, has: false, balance: null },
    limits: [
      {
        id: "codex",
        name: "codex",
        windows: [
          {
            usedPercent: 34.5,
            windowMinutes: 300,
            resetsAt: new Date(Date.now() + 130 * 60000).toISOString(),
          },
          {
            usedPercent: 12,
            windowMinutes: 10080,
            resetsAt: new Date(
              Date.now() + 3 * 86400000 + 4 * 3600000,
            ).toISOString(),
          },
        ],
      },
    ],
  };
  const gateway = new Gateway(hub, {
    account: {
      status: async () => ({ connected: true }),
      usage: async (params) => {
        usageCalls.push(params);
        return usage;
      },
      close: async () => {},
    },
  });
  t.after(async () => {
    await o.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    o,
    hub,
    gateway,
    usage,
    usageCalls,
    as: (name, context = {}) => gateway.as(name, context),
    store,
    dir,
    workers,
    config,
    spec: (name, extra = {}) => ({
      name,
      prompt: `Complete ${name}`,
      cwd: dir,
      // Fixtures do not edit files, so they share the folder.
      resources: [],
      ...extra,
    }),
  };
}
