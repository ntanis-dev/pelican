import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { jobEvent } from "./event-summary.js";
import { EventWaiters } from "./event-waiters.js";
import { requestSummary } from "./request-summary.js";
import { approvalResponse } from "./approvals.js";
import { CodexProcess, dynamicTools, toolResult } from "./codex.js";
import { prepareAgentCodexHome } from "./codex-home.js";
import {
  briefSchema,
  defaultSettings,
  effortSchema,
  settingsSchema,
  textSchema,
} from "./schema.js";
import { allocateName } from "./identity.js";
import {
  permissionParams,
  turnSandbox,
  verifiedPermissions,
} from "./worker-permissions.js";
import { WindowsSandboxPreparation } from "./windows-sandbox.js";
import { checkResult, compileResultSchema } from "./result-schema.js";

// Threads started before this version carry another tool set. Resuming one
// starts a fresh conversation for the same agent instead.
export const toolsVersion = 3;
export const activeStates = new Set([
  "starting",
  "running",
  "waiting",
  "stopping",
]);
export const terminalStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
]);
// Pelican itself, when it acts on an agent (recovery, the automatic result
// retry). Callers name themselves; this name is reserved.
export const pelican = "pelican";
// Fields of features Pelican no longer has. They mean nothing now.
const legacyFields = [
  "goal",
  "goalState",
  "goalProtocol",
  "workBinding",
  "reviewHandoff",
  "assignmentBriefId",
  "assignmentRequestId",
  "usageRunId",
  "verificationWait",
  "eligibilityWait",
  "waitingFor",
  "dispatchPreparing",
  "publicTemplates",
  "boardNoticeSeq",
  "approvalRevision",
  "sandbox",
  "approvalPolicy",
  "agentId",
  "workId",
  "group",
  "instructions",
  "artifacts",
  "createdBy",
  "pendingActor",
  "previewUpdatedAt",
  "maxRuntimeMs",
  "maxTokens",
  "usageBaseline",
];
const settingKeys = Object.keys(defaultSettings);
// The pause before an agent whose Codex crashed while starting starts again.
export const restartDelayMs = 1000;
// Codex errors that pass on their own ("Selected model is at capacity", or the
// model stream refused with 429 Too Many Requests / 503 when the account's
// request budget is spent): the agent waits and continues its conversation
// instead of failing, up to six tries, 30 s doubling to at most 10 minutes
// (config.overloadRetryBaseMs). Returns the cause, or null.
const throttledStatus = (info) =>
  [429, 503].includes(info?.responseStreamDisconnected?.httpStatusCode)
    ? info.responseStreamDisconnected.httpStatusCode
    : null;
const transientCause = (info) =>
  info === "serverOverloaded"
    ? "serverOverloaded"
    : throttledStatus(info)
      ? `HTTP ${throttledStatus(info)}`
      : null;
export const overloadRetries = 6;
const overloadDelayMs = (config, attempt) =>
  Math.min(
    10 * 60000,
    (config.overloadRetryBaseMs ?? 30000) * 2 ** (attempt - 1),
  );
const stamp = () => new Date().toISOString();
const failure = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode });
const safeText = (text) =>
  String(text)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /\b(sk-[a-zA-Z0-9_-]{16,}|Bearer\s+[a-zA-Z0-9._-]{20,})/g,
      "[redacted]",
    );
const safe = (data) => JSON.parse(safeText(JSON.stringify(data ?? null)));
const overlaps = (a, b) =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const pick = (object, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => object?.[key] !== undefined)
      .map((k) => [k, object[k]]),
  );
async function canonical(path) {
  let result;
  try {
    result = await realpath(path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const parent = dirname(path);
    if (parent === path) throw e;
    result = resolve(await canonical(parent), basename(path));
  }
  return process.platform === "win32" ? result.toLowerCase() : result;
}
// Saved jobs from before structured results and owners.
function upgrade(job) {
  let changed = false;
  for (const field of legacyFields)
    if (field in job) {
      if (field === "createdBy" && !job.owner)
        job.owner =
          job.createdBy?.role === "coordinator" ? "human" : "orchestrator";
      delete job[field];
      changed = true;
    }
  if (typeof job.result === "string") {
    job.summary ??= job.result;
    job.result = null;
    changed = true;
  }
  for (const [key, value] of Object.entries({
    owner: "orchestrator",
    summary: "",
    report: "",
    result: null,
    resultValid: false,
    resultError: null,
    resultRetried: false,
    resultSchema: null,
    notes: [],
    followups: [],
    messages: [],
    pending: [],
  }))
    if (job[key] === undefined) {
      job[key] = structuredClone(value);
      changed = true;
    }
  return changed;
}

// One workspace's agents: the queue, the Codex workers, their questions and
// results. Whoever spawns an agent owns it; Pelican has no orchestrator of
// its own.
export class Fleet extends EventEmitter {
  constructor({ store, config, workerFactory }) {
    super();
    this.eventWaiters = new EventWaiters(this);
    this.store = store;
    this.config = config;
    this.folder = config.workspace?.folder ?? resolve(config.dataDir, "../..");
    this.windowsSandbox = new WindowsSandboxPreparation(config);
    this.workerFactory =
      workerFactory ??
      ((job) =>
        new CodexProcess({
          bin: config.codexBin,
          cwd: job.cwd,
          prepareHome: () => prepareAgentCodexHome(config, job),
          prepareSandbox: async (home, signal) => {
            job.windowsSandbox = await this.windowsSandbox.prepare({
              home,
              cwd: job.cwd,
              signal,
              onStatus: (setup) => {
                job.setup = setup;
                this.save(job, "job.setup");
              },
            });
            return permissionParams(job, config, { network: job.network })
              .config;
          },
        }));
    this.jobs = new Map(store.jobs().map((job) => [job.id, job]));
    const reserved = new Set(
      [...this.jobs.values()]
        .map((job) => job.agentName?.toLowerCase())
        .filter(Boolean),
    );
    for (const job of this.jobs.values()) {
      let changed = upgrade(job);
      if (!job.agentName) {
        job.agentName = allocateName(job.id, reserved);
        changed = true;
      }
      if (changed) store.save(job);
    }
    this.active = new Map();
    // Codex processes start one at a time (startSlot).
    this.starting = Promise.resolve();
    // Settings from before model, effort and network were per workspace.
    const legacy = store.setting("scheduler", null);
    const saved = store.setting("settings", null) ?? {
      ...defaultSettings,
      ...pick(legacy, ["concurrency", "paused"]),
    };
    this.settings = { ...defaultSettings, ...pick(saved, settingKeys) };
    store.setSetting("settings", this.settings);
    if (legacy) store.deleteSetting("scheduler");
    this.closing = false;
    this.scheduled = false;
    // A restart interrupts whatever was running. Its owner decides what to
    // resume; nothing is replayed implicitly.
    for (const job of this.jobs.values())
      if (activeStates.has(job.status) || job.restartPending) {
        job.status = "interrupted";
        job.pid = null;
        job.turnId = null;
        job.error =
          "Pelican restarted while this agent was working. Its changes so far are in the workspace.";
        if (job.pending.length)
          this.emitEvent(job.id, "questions.expired", {
            ids: job.pending.map((q) => q.id),
          });
        job.pending = [];
        job.finishedAt = stamp();
        delete job.restartPending;
        this.save(job, "job.recovered", { by: pelican });
      }
  }
  emitEvent(jobId, type, data) {
    const event = this.store.event(jobId, type, safe(data));
    this.emit("event", event);
    return event;
  }
  save(job, type = "job.updated", extra) {
    job.updatedAt = stamp();
    this.store.save(job);
    this.emitEvent(job.id, type, { ...jobEvent(job, type), ...extra });
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw failure(404, "Agent not found");
    return job;
  }
  // Settled: it will not run again unless someone resumes it.
  done(job) {
    return terminalStates.has(job.status) && !this.active.has(job.id);
  }
  async prepare(input, owner, extra = {}) {
    const brief = briefSchema.parse(input);
    compileResultSchema(brief.resultSchema);
    const requested = brief.cwd ?? this.folder;
    if (!isAbsolute(requested)) throw new Error("cwd must be an absolute path");
    let cwd;
    try {
      cwd = await realpath(requested);
      if (!(await stat(cwd)).isDirectory()) throw new Error();
    } catch {
      throw new Error(`cwd ${requested} is not an existing directory.`);
    }
    const home = await canonical(this.folder),
      place = await canonical(cwd);
    if (place !== home && !place.startsWith(home + sep))
      throw new Error(
        `cwd must be inside this workspace's folder (${this.folder}).`,
      );
    const resources = [];
    for (const path of brief.resources ?? [cwd]) {
      const p = resolve(cwd, path);
      const r = relative(cwd, p);
      if (r === ".." || r.startsWith(".." + sep) || isAbsolute(r))
        throw new Error("Resources must be inside cwd");
      const c = await canonical(p);
      if (c !== place && !c.startsWith(place + sep))
        throw new Error("Resource resolves outside cwd");
      resources.push(c);
    }
    return {
      id: extra.id ?? randomUUID(),
      name: brief.name,
      prompt: brief.prompt,
      cwd,
      resources: [...new Set(resources)],
      dependsOn: brief.dependsOn,
      priority: brief.priority,
      model: brief.model ?? this.settings.model,
      effort: brief.effort ?? this.settings.effort,
      resultSchema: brief.resultSchema ?? null,
      owner,
      status: "queued",
      createdAt: stamp(),
      queuedAt: stamp(),
      updatedAt: stamp(),
      startedAt: null,
      finishedAt: null,
      threadId: null,
      privateCodexHome: true,
      turnId: null,
      pid: null,
      attempts: 0,
      network: null,
      pending: [],
      messages: [],
      notes: [],
      followups: [],
      progress: "",
      currentActivity: "",
      summary: "",
      report: "",
      result: null,
      resultValid: false,
      resultError: null,
      resultRetried: false,
      error: null,
      usage: null,
      pendingPrompt: `Assignment from ${owner}:\n${brief.prompt}`,
      plan: [],
    };
  }
  async create(input, owner) {
    return (await this.createBatch([input], owner))[0];
  }
  async createBatch(inputs, owner) {
    if (this.closing) throw failure(409, "Pelican is stopping.");
    owner = textSchema.parse(owner);
    if (!Array.isArray(inputs) || !inputs.length)
      throw new Error("Provide a nonempty jobs array");
    const keys = new Map();
    for (const [index, input] of inputs.entries()) {
      const key = input?.key ?? String(index + 1);
      if (keys.has(key)) throw new Error(`Duplicate batch key: ${key}`);
      keys.set(key, randomUUID());
    }
    const jobs = await Promise.all(
      inputs.map((input, index) => {
        const { key, ...spec } = input;
        const dependsOn = (spec.dependsOn ?? []).map(
          (id) => keys.get(id) ?? id,
        );
        return this.prepare({ ...spec, dependsOn }, owner, {
          id: keys.get(key ?? String(index + 1)),
        });
      }),
    );
    const combined = new Map([
      ...this.jobs,
      ...jobs.map((job) => [job.id, job]),
    ]);
    const visiting = new Set(),
      visited = new Set();
    function visit(id) {
      if (visiting.has(id)) throw new Error("Dependency cycle");
      if (visited.has(id)) return;
      const job = combined.get(id);
      if (!job) throw new Error(`Unknown dependency: ${id}`);
      visiting.add(id);
      job.dependsOn.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    }
    jobs.forEach((job) => visit(job.id));
    const reserved = new Set(
      [...this.jobs.values()].map((job) => job.agentName.toLowerCase()),
    );
    // Keep FIFO order within a batch even when path validation resolves out of order.
    const enqueuedAt = stamp();
    for (const job of jobs) {
      job.agentName = allocateName(job.id, reserved);
      job.createdAt = job.queuedAt = enqueuedAt;
    }
    this.store.transaction(() => {
      for (const job of jobs) this.store.save(job);
    });
    for (const job of jobs) {
      this.jobs.set(job.id, job);
      this.emitEvent(job.id, "job.created", {
        ...jobEvent(job, "job.created"),
        by: owner,
        prompt: job.prompt,
      });
    }
    this.schedule();
    return jobs;
  }
  updateSettings(input, by = pelican) {
    const changes = settingsSchema.parse(input ?? {});
    if (
      Object.entries(changes).every(
        ([key, value]) => this.settings[key] === value,
      )
    )
      return this.settings;
    this.settings = { ...this.settings, ...changes };
    this.store.setSetting("settings", this.settings);
    this.emitEvent(null, "settings.updated", {
      settings: this.settings,
      changes,
      by,
    });
    this.schedule();
    return this.settings;
  }
  async prune() {
    if (this.closing) return;
    const retention = await this.store.prune();
    if (this.closing) return retention;
    for (const job of this.jobs.values()) {
      if (
        !this.done(job) ||
        !job.finishedAt ||
        job.finishedAt >= retention.cutoff ||
        job.historyExpiredAt
      )
        continue;
      Object.assign(job, {
        prompt: "History expired after seven days.",
        messages: [],
        notes: [],
        followups: [],
        pending: [],
        plan: [],
        summary: "",
        report: "",
        result: null,
        progress: "",
        currentActivity: "",
        pendingPrompt: "",
        error: job.error?.slice(0, 500) ?? null,
        historyExpiredAt: stamp(),
      });
      this.store.save(job);
    }
    return retention;
  }
  // Agents that need the process: those running, and those queued to run
  // (a paused workspace starts none).
  busy() {
    let n = 0;
    for (const job of this.jobs.values())
      if (
        activeStates.has(job.status) ||
        this.active.has(job.id) ||
        (job.status === "queued" && !this.settings.paused)
      )
        n++;
    return n;
  }
  schedule() {
    if (this.scheduled || this.closing) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.tick();
    });
  }
  tick() {
    if (this.settings.paused || this.closing) return;
    const waiting = [...this.jobs.values()]
      .filter((j) => j.status === "queued" && !(j.notBefore > Date.now()))
      .sort(
        (a, b) =>
          b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
      );
    for (const job of waiting) {
      if (this.active.size >= this.settings.concurrency) break;
      const deps = job.dependsOn.map((id) => this.jobs.get(id));
      if (
        deps.some(
          (dep) =>
            !dep ||
            (terminalStates.has(dep.status) && dep.status !== "completed"),
        )
      ) {
        job.status = "blocked";
        job.error = "A dependency did not complete successfully";
        job.finishedAt = stamp();
        this.save(job, "job.finished");
        continue;
      }
      if (deps.some((dep) => dep.status !== "completed")) continue;
      if (
        [...this.active.keys()].some((id) =>
          this.get(id).resources.some((a) =>
            job.resources.some((b) => overlaps(a, b)),
          ),
        )
      )
        continue;
      this.launch(job).catch((error) =>
        this.emitEvent(job.id, "scheduler.error", { message: error.message }),
      );
    }
  }
  instructions(job) {
    const schema = job.resultSchema
      ? `, and result: JSON text that validates against this JSON Schema:\n${JSON.stringify(job.resultSchema)}\nPelican checks the result and tells you what to fix; call pelican_report again until it is accepted`
      : "";
    return `You are ${job.agentName}, a Codex agent run by Pelican. Job ID: ${job.id}. Assignment: ${job.name}.
${job.owner} is the orchestrator that gave you this assignment, and your only point of contact. There is no human to ask: make ordinary engineering decisions yourself, within the assignment. Use pelican_ask only for a decision you truly cannot make; it waits for the answer, so keep working on anything that does not depend on it. pelican_message sends ${job.owner} a short note without waiting. Messages for you arrive by themselves; pelican_inbox reads them again.
You run in Codex auto mode and write freely inside your workspace. ${job.network ? "Network access is on: commands may use the network and local servers without approval." : "Commands that need network access, other folders or escalation are reviewed automatically; if one is denied, find another way or report what you could not do."}
Work in the existing checkout. Other agents may be editing other files in it: do not reset, discard or overwrite their changes. Do not create branches, commits, pushes, pull requests or worktrees unless the assignment asks for them. Do not start other agents or Codex processes.
Paths reserved for you: ${job.resources.length ? job.resources.join(", ") : "none (do not edit files)"}. Ask before changing shared files outside them.
Check your own work before you finish: run the relevant tests or checks and look at the results.
When you are done, call pelican_report once with report: what you changed, what you ran and what happened, and anything unresolved${schema}. Then end your turn with a one-line final reply.
Do not change global Codex settings or read unrelated credentials. Never include secrets in reports.`;
  }
  async launch(job) {
    const proc = this.workerFactory(job),
      runtime = { proc, finishing: false };
    this.active.set(job.id, runtime);
    job.network = this.settings.network === true;
    Object.assign(job, {
      status: "starting",
      error: null,
      progress: "",
      pending: [],
      startedAt: stamp(),
      setup: null,
      windowsSandbox: null,
      finishedAt: null,
      notBefore: null,
    });
    job.attempts++;
    this.save(job, "job.started");
    const alive = () =>
      this.active.get(job.id) === runtime && !runtime.finishing;
    proc.on("notification", (message) => {
      if (alive()) this.notification(job, runtime, message);
    });
    proc.on("request", (request) => {
      if (alive())
        void this.requestFromWorker(job, runtime, request).catch((error) => {
          if (!this.store.closed)
            this.emitEvent(job.id, "warning", { message: error.message });
        });
    });
    proc.on("diagnostic", (data) => {
      if (alive()) this.emitEvent(job.id, "worker.diagnostic", data);
    });
    proc.on("exit", (data) => {
      if (alive())
        void this.finish(
          job,
          runtime,
          data.interrupted ? "interrupted" : "failed",
          data.message,
        );
    });
    // The workspace's agents share one Codex home, and two Codex processes
    // that start at the same moment can race on its state database ("failed
    // to initialize sqlite state runtime"): each holds the start slot until
    // its thread is open.
    let release = await this.startSlot();
    try {
      if (!alive()) return;
      await proc.start();
      if (!alive()) return;
      job.pid = proc.child?.pid ?? null;
      this.save(job);
      let fresh = "";
      if (job.threadId && job.toolsVersion !== toolsVersion) {
        job.threadId = null;
        fresh =
          "(Your earlier conversation ran on an older Pelican, so this one starts fresh. Inspect the workspace for your previous work.)\n";
      }
      const permissions = permissionParams(job, this.config, {
        network: job.network,
      });
      const params = {
        model: job.model,
        cwd: job.cwd,
        ...permissions,
        developerInstructions: this.instructions(job),
      };
      const response = job.threadId
        ? await proc.request("thread/resume", {
            ...params,
            threadId: job.threadId,
            excludeTurns: true,
          })
        : await proc.request("thread/start", {
            ...params,
            dynamicTools,
            serviceName: "pelican",
            ephemeral: false,
          });
      release();
      release = null;
      if (!alive()) return;
      runtime.threadReady = true;
      job.startRetried = false;
      job.threadId = response.thread.id;
      job.toolsVersion = toolsVersion;
      runtime.threadId = job.threadId;
      job.permissions = verifiedPermissions(response);
      if (job.permissions.networkAccess !== job.network)
        this.emitEvent(job.id, "warning", {
          message: `The workspace's network switch is ${job.network ? "on" : "off"} but Codex started this thread with network access ${job.permissions.networkAccess ? "on" : "off"}; Pelican sets it again for the turn.`,
        });
      this.save(job);
      const turn = await proc.request("turn/start", {
        threadId: job.threadId,
        input: [
          {
            type: "text",
            text: `${fresh}${job.pendingPrompt || `Assignment from ${job.owner}:\n${job.prompt}`}`,
            text_elements: [],
          },
        ],
        model: job.model,
        effort: job.effort,
        cwd: job.cwd,
        sandboxPolicy: turnSandbox(job.permissions, job.network),
        approvalPolicy: permissions.approvalPolicy,
        approvalsReviewer: permissions.approvalsReviewer,
      });
      if (!alive()) return;
      job.turnId = turn.turn.id;
      job.pendingPrompt = null;
      if (job.status === "starting") job.status = "running";
      this.save(job);
      // Messages that arrived while it was starting.
      await this.steerWaiting(job);
    } catch (error) {
      release?.();
      release = null;
      if (alive()) await this.finish(job, runtime, "failed", error.message);
    } finally {
      release?.();
    }
  }
  // One Codex start at a time in this workspace: resolves with the release
  // once every earlier start has released.
  async startSlot() {
    const previous = this.starting;
    let release;
    this.starting = new Promise((resolve) => (release = resolve));
    await previous;
    return release;
  }
  notification(job, runtime, { method, params = {} }) {
    if (
      params.threadId &&
      (runtime.threadId || job.threadId) &&
      params.threadId !== (runtime.threadId || job.threadId)
    )
      return;
    // Raw deltas and completed items stay available in the durable journal.
    this.emitEvent(job.id, method, params);
    if (method === "turn/started") {
      job.turnId = params.turn.id;
      if (!job.pending.length) job.status = "running";
      this.save(job);
    } else if (
      method === "item/started" &&
      ["commandExecution", "fileChange"].includes(params.item?.type)
    ) {
      if (job.pending.length) {
        job.workingWithQuestion = true;
        job.status = "running";
      }
      job.currentActivity =
        params.item.type === "commandExecution"
          ? params.item.command
          : "Editing " +
            (params.item.changes ?? []).map((c) => c.path).join(", ");
      this.save(job);
    } else if (
      method === "item/completed" &&
      ["commandExecution", "fileChange"].includes(params.item?.type)
    ) {
      job.currentActivity = "";
      this.save(job);
    } else if (
      method === "item/completed" &&
      params.item?.type === "agentMessage"
    ) {
      if (params.item.phase === "final_answer" || !params.item.phase)
        job.summary = params.item.text ?? "";
      else job.progress = params.item.text ?? "";
      this.save(job);
    } else if (method === "turn/plan/updated") {
      job.plan = params.plan ?? [];
      this.save(job);
    } else if (method === "thread/tokenUsage/updated") {
      job.usage = params.tokenUsage;
      this.save(job);
    } else if (method === "turn/completed") {
      if (job.turnId && params.turn.id !== job.turnId) return;
      const status = params.turn.status;
      if (status === "failed")
        runtime.transient = transientCause(params.turn.error?.codexErrorInfo);
      void this.finish(
        job,
        runtime,
        status === "completed"
          ? "completed"
          : status === "interrupted"
            ? "interrupted"
            : "failed",
        params.turn.error?.message ?? job.error,
      );
    } else if (method === "error" && params.willRetry !== true) {
      job.error = safeText(
        params.error?.message ?? params.message ?? "Codex reported an error",
      );
      this.save(job);
    } else if (
      method === "error" &&
      throttledStatus(params.error?.codexErrorInfo)
    ) {
      // Codex retries a refused model stream on its own, minutes apart and
      // silently; the journal (and pelican watch) says so at once.
      this.emitEvent(job.id, "job.throttled", {
        ...jobEvent(job, "job.throttled"),
        reason: safeText(params.error.message ?? "Reconnecting"),
        httpStatus: throttledStatus(params.error.codexErrorInfo),
      });
    }
  }
  async requestFromWorker(job, runtime, request) {
    const { id, method, params = {} } = request;
    const reply = (result) => {
      if (!runtime.finishing && !this.store.closed)
        runtime.proc.reply(id, result);
    };
    const refuse = (message) =>
      reply({
        contentItems: [{ type: "inputText", text: message }],
        success: false,
      });
    try {
      if (method === "currentTime/read")
        return reply({ currentTimeAt: Math.floor(Date.now() / 1000) });
      // Nobody is there to fill in an MCP server's form.
      if (method === "mcpServer/elicitation/request")
        return reply({ action: "decline" });
      if (method === "item/tool/call") {
        const args = params.arguments ?? {};
        switch (params.tool) {
          case "pelican_report": {
            const report =
              typeof args.report === "string" ? args.report.trim() : "";
            if (!report)
              return refuse(
                "Give report: what you changed, what you ran and what happened, and anything unresolved.",
              );
            const check = checkResult(job.resultSchema, args.result);
            job.report = report;
            job.resultValid = check.ok;
            job.resultError = check.error;
            if (check.ok) job.result = check.value;
            this.save(job, "agent.report");
            if (!check.ok) return refuse(check.error);
            return reply(
              toolResult({
                accepted: true,
                ...(job.resultSchema ? { result: "valid" } : {}),
              }),
            );
          }
          case "pelican_message": {
            const note = {
              id: randomUUID(),
              text: textSchema.parse(args.message),
              at: stamp(),
            };
            job.notes = [...job.notes, note].slice(-50);
            this.save(job, "agent.message", { message: note.text });
            return reply(toolResult({ delivered: true, to: job.owner }));
          }
          case "pelican_inbox": {
            const ids = Array.isArray(args.ids) ? args.ids.slice(0, 20) : null;
            const messages = job.messages
              .filter((m) => (ids ? ids.includes(m.id) : !m.readAt))
              .slice(0, 20);
            for (const m of messages) m.readAt ??= stamp();
            this.save(job);
            return reply(
              toolResult({
                messages: messages.map(({ id, from, text, createdAt }) => ({
                  id,
                  from,
                  text,
                  createdAt,
                })),
              }),
            );
          }
          case "pelican_ask":
            textSchema.parse(args.question);
            break;
          default:
            throw new Error(`Unknown tool: ${params.tool}`);
        }
      } else if (
        ![
          "item/tool/requestUserInput",
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/permissions/requestApproval",
        ].includes(method)
      )
        return runtime.proc.reject(id, `Unsupported client request: ${method}`);
      // Questions and the rare approval that reaches Pelican go to the
      // agent's owner, who answers them.
      const pending = {
        id: randomUUID(),
        rpcId: id,
        method,
        params: safe(params),
        createdAt: stamp(),
        turnId: job.turnId,
        owner: job.owner,
        question: requestSummary({ method, params }),
        sequence: this.store.cursor() + 1,
      };
      this.store.saveWork("agent-request", {
        ...pending,
        jobId: job.id,
        assignment: job.queuedAt,
      });
      job.pending.push(pending);
      job.workingWithQuestion = false;
      job.status = "waiting";
      this.save(job, "agent.question");
    } catch (error) {
      refuse(error.message);
    }
  }
  async answer(jobId, requestId, answer, by) {
    const job = this.get(jobId),
      runtime = this.active.get(jobId);
    const request = job.pending.find((p) => p.id === requestId);
    if (!runtime || runtime.finishing || !request)
      throw failure(409, "Question is no longer pending");
    let response;
    if (request.method === "item/tool/call")
      response = toolResult({
        answer: textSchema.parse(
          typeof answer === "string" ? answer : JSON.stringify(answer),
        ),
        from: by,
      });
    else if (request.method === "item/tool/requestUserInput") {
      const text = typeof answer === "string" ? answer : null;
      response = text
        ? {
            answers: Object.fromEntries(
              (request.params.questions ?? []).map((q) => [
                q.id,
                { answers: [text] },
              ]),
            ),
          }
        : answer;
      if (!response?.answers)
        throw new Error("Answer with plain text or {answers: {...}}");
    } else if (request.method === "item/permissions/requestApproval") {
      const decision = typeof answer === "string" ? answer : answer?.decision;
      if (!["accept", "decline"].includes(decision))
        throw new Error("Answer accept or decline");
      response =
        decision === "accept"
          ? { permissions: request.params.permissions, scope: "turn" }
          : { permissions: {} };
    } else response = approvalResponse(request, answer);
    runtime.proc.reply(request.rpcId, response);
    const saved = this.store.workRecord("agent-request", requestId);
    if (saved)
      this.store.saveWork("agent-request", {
        ...saved,
        answeredAt: stamp(),
        answer: safe(answer),
        answeredBy: by,
      });
    job.pending = job.pending.filter((p) => p.id !== requestId);
    if (!job.pending.length) job.workingWithQuestion = false;
    job.status = job.pending.length ? "waiting" : "running";
    this.save(job, "agent.answered", {
      requestId,
      method: request.method,
      question: request.question,
      answer,
      by,
    });
    return job;
  }
  // A message from an orchestrator. steer reaches the running turn now;
  // followup becomes the next assignment once the turn ends. A finished agent
  // takes either as a new assignment; a queued one has it added to its brief.
  async message(id, text, mode = "steer", by) {
    const job = this.get(id);
    text = textSchema.parse(text);
    if (!["steer", "followup"].includes(mode))
      throw new Error("Choose steer or followup.");
    const runtime = this.active.get(id);
    if (runtime?.finishing || job.status === "stopping")
      throw failure(
        409,
        "The agent is stopping. Wait until it has stopped, then resume it.",
      );
    const mail = {
      id: randomUUID(),
      from: by,
      text,
      mode,
      createdAt: stamp(),
      readAt: null,
      deliveredAt: null,
    };
    job.messages = [...job.messages, mail].slice(-200);
    let delivery;
    if (runtime) {
      if (mode === "followup") {
        job.followups.push({ id: mail.id, text, by });
        delivery = "followup";
      } else if (job.turnId && job.status !== "starting")
        delivery = (await this.steer(job, runtime, [mail]))
          ? "steered"
          : "followup";
      else delivery = "pending";
    } else if (job.status === "queued") {
      job.pendingPrompt = `${job.pendingPrompt || `Assignment from ${job.owner}:\n${job.prompt}`}\n\n${mode === "followup" ? "Follow-up" : "Update"} from ${by}:\n${text}`;
      mail.deliveredAt = stamp();
      delivery = "queued";
    } else {
      mail.deliveredAt = stamp();
      this.resume(id, { prompt: text }, by);
      delivery = "resumed";
    }
    this.save(job, "message.sent", {
      messageId: mail.id,
      from: by,
      mode,
      delivery,
      text,
    });
    return { delivery, messageId: mail.id, job };
  }
  // Into the running turn; a steer that misses the turn becomes a followup.
  async steer(job, runtime, mails) {
    try {
      await runtime.proc.request("turn/steer", {
        threadId: job.threadId,
        expectedTurnId: job.turnId,
        input: mails.map((mail) => ({
          type: "text",
          text: `Message ${mail.id} from ${mail.from}:\n${mail.text}`,
          text_elements: [],
        })),
      });
      for (const mail of mails) mail.deliveredAt = stamp();
      return true;
    } catch {
      for (const mail of mails)
        if (!job.followups.some((f) => f.id === mail.id))
          job.followups.push({ id: mail.id, text: mail.text, by: mail.from });
      return false;
    }
  }
  async steerWaiting(job) {
    const mails = job.messages.filter(
      (m) =>
        m.mode === "steer" &&
        !m.deliveredAt &&
        !job.followups.some((f) => f.id === m.id),
    );
    const runtime = this.active.get(job.id);
    if (!mails.length || !runtime || runtime.finishing) return;
    await this.steer(job, runtime, mails);
    this.save(job);
  }
  resume(id, overrides = {}, by, { retry = false } = {}) {
    const job = this.get(id);
    if (this.closing) throw failure(409, "Pelican is stopping.");
    if (this.active.has(id) || job.status === "queued")
      throw failure(409, "The agent is already running or queued.");
    for (const key of Object.keys(overrides))
      if (!["prompt", "model", "effort"].includes(key))
        throw new Error(`Unknown override: ${key}`);
    const prompt = textSchema.parse(
      overrides.prompt ??
        "Continue the assignment from the existing state. Inspect previous work before proceeding.",
    );
    const model = overrides.model
      ? textSchema.parse(overrides.model)
      : job.model;
    const effort = overrides.effort
      ? effortSchema.parse(overrides.effort)
      : job.effort;
    Object.assign(job, {
      model,
      effort,
      pendingPrompt: `${retry ? "Pelican" : `Assignment from ${by}`}:\n${prompt}`,
      status: "queued",
      queuedAt: stamp(),
      error: null,
      pending: [],
      finishedAt: null,
    });
    // A new assignment reports again; the automatic retry keeps its count.
    if (!retry)
      Object.assign(job, {
        summary: "",
        report: "",
        result: null,
        resultValid: false,
        resultError: null,
        resultRetried: false,
      });
    this.save(job, retry ? "job.retrying" : "job.resumed", { by, prompt });
    this.schedule();
    return job;
  }
  async cancel(id, reason, by) {
    const job = this.get(id);
    if (job.status !== "queued" || this.active.has(id))
      throw failure(409, "This agent is no longer queued.");
    return this.stop(id, reason, false, by);
  }
  async stop(id, reason, force = false, by = pelican) {
    reason = textSchema.parse(reason || `Stopped by ${by}`);
    const job = this.get(id),
      runtime = this.active.get(id);
    if (!runtime) {
      if (job.status === "queued" || job.status === "blocked") {
        job.status = "cancelled";
        job.error = reason;
        job.finishedAt = stamp();
        this.save(job, "job.cancelled", { by });
        this.schedule();
      }
      return job;
    }
    if (runtime.finishing) {
      await runtime.done;
      return job;
    }
    runtime.stopReason = reason;
    job.status = "stopping";
    job.error = reason;
    this.save(job, "job.stopRequested", { by });
    if (!force && job.threadId && job.turnId) {
      try {
        await runtime.proc.request(
          "turn/interrupt",
          { threadId: job.threadId, turnId: job.turnId },
          2500,
        );
      } catch {
        /* Escalate only this tracked process. */
      }
    }
    await this.finish(job, runtime, "interrupted", reason);
    return job;
  }
  // Every agent, or one owner's: queued ones first so a freed slot does not
  // start another.
  async stopAll({ owner, reason, by = pelican } = {}) {
    const jobs = [...this.jobs.values()].filter(
      (j) =>
        (activeStates.has(j.status) || j.status === "queued") &&
        (!owner || j.owner === owner),
    );
    reason ||= `Stopped by ${by} (stop all)`;
    for (const job of jobs.filter((j) => j.status === "queued"))
      await this.stop(job.id, reason, false, by);
    await Promise.all(
      jobs
        .filter((j) => j.status !== "cancelled")
        .map((j) => this.stop(j.id, reason, true, by)),
    );
    return jobs;
  }
  async finish(job, runtime, status, error) {
    if (runtime.finishing || this.active.get(job.id) !== runtime)
      return runtime.done;
    runtime.finishing = true;
    runtime.done = this.finalize(job, runtime, status, error);
    return runtime.done;
  }
  async finalize(job, runtime, status, error) {
    await runtime.proc.close();
    if (runtime.stopReason) {
      status = "interrupted";
      error = runtime.stopReason;
    }
    // A result schema decides whether a completed turn is done: without a
    // valid result Pelican resumes the agent once with the reason.
    let retry = null;
    if (status === "completed" && job.resultSchema && !job.resultValid) {
      const reason =
        job.resultError ??
        "pelican_report was not called with a result before the turn ended.";
      if (!job.resultRetried && !this.closing) retry = reason;
      else {
        status = "failed";
        error = `Finished without a valid result${job.resultRetried ? " after one automatic retry" : ""}: ${reason}`;
      }
    }
    // A worker that dies before its thread opens (a start-up crash) is started
    // once more; a second crash in a row fails the agent.
    if (
      status === "failed" &&
      !runtime.threadReady &&
      !job.startRetried &&
      !this.closing
    ) {
      Object.assign(job, {
        status: "queued",
        error: null,
        pid: null,
        turnId: null,
        currentActivity: "",
        startRetried: true,
      });
      this.active.delete(job.id);
      this.save(job, "job.restarting", {
        reason: safeText(error || "Codex stopped while starting"),
      });
      setTimeout(() => this.tick(), restartDelayMs).unref();
      return;
    }
    const expired = job.pending.map((q) => q.id);
    // A turn the model service failed for capacity continues the same
    // conversation after a pause; a run waiting on the agent keeps waiting.
    if (
      status === "failed" &&
      runtime.transient &&
      !this.closing &&
      (job.overloadRetries ?? 0) < overloadRetries
    ) {
      const attempt = (job.overloadRetries ?? 0) + 1;
      const delay = overloadDelayMs(this.config, attempt);
      Object.assign(job, {
        status: "queued",
        queuedAt: stamp(),
        notBefore: Date.now() + delay,
        overloadRetries: attempt,
        pendingPrompt: `Pelican:\nThe model service refused your turn (${runtime.transient}: at capacity or rate-limited). Continue the assignment where you left off: inspect your previous work first and do not redo finished steps.`,
        error: null,
        pid: null,
        turnId: null,
        currentActivity: "",
        workingWithQuestion: false,
        pending: [],
      });
      this.active.delete(job.id);
      this.save(job, "job.overloaded", {
        reason: safeText(error || runtime.transient),
        attempt,
        of: overloadRetries,
        retryInMs: delay,
      });
      if (expired.length)
        this.emitEvent(job.id, "questions.expired", { ids: expired });
      setTimeout(() => this.tick(), delay + 50).unref();
      return;
    }
    if (status === "completed") job.overloadRetries = 0;
    Object.assign(job, {
      status,
      error: error ? safeText(error) : null,
      finishedAt: stamp(),
      pid: null,
      turnId: null,
      currentActivity: "",
      workingWithQuestion: false,
      pending: [],
    });
    this.active.delete(job.id);
    this.next(job, status, retry);
    if (expired.length)
      this.emitEvent(job.id, "questions.expired", { ids: expired });
  }
  // What follows a finished turn: the automatic result retry, a followup, or
  // nothing (the agent is done).
  next(job, status, retry) {
    if (retry) {
      job.resultRetried = true;
      this.resume(
        job.id,
        {
          prompt: `Your turn ended without a valid structured result. ${retry}\nCall pelican_report again with report and result (JSON text that matches the result schema in your instructions), then end your turn. Do not redo work that is already done.`,
        },
        pelican,
        { retry: true },
      );
      return;
    }
    const followup =
      status === "completed" && !this.closing ? job.followups.shift() : null;
    if (status !== "completed") job.followups = [];
    if (followup) {
      for (const mail of job.messages)
        if (mail.id === followup.id) mail.deliveredAt = stamp();
      this.resume(job.id, { prompt: followup.text }, followup.by);
      return;
    }
    this.save(job, "job.finished");
    this.schedule();
  }
  // Journal entries after a cursor; with timeoutMs, waits for the next one.
  async events(query = {}, { timeoutMs = 0, signal } = {}) {
    signal?.throwIfAborted();
    const existing = this.store.events(query);
    if (existing.length || !timeoutMs || this.closing) return existing;
    const types = query.types ?? null;
    await this.eventWaiters.wait({
      matches: (event) =>
        (!query.jobId || event.jobId === query.jobId) &&
        (!types ||
          types.some((t) =>
            t.endsWith("*")
              ? event.type.startsWith(t.slice(0, -1))
              : event.type === t,
          )),
      timeoutMs,
      signal,
    });
    return this.store.events(query);
  }
  async shutdown() {
    this.closing = true;
    this.eventWaiters.close();
    // Agents stopped here are reported as interrupted after the restart.
    for (const id of this.active.keys()) this.get(id).restartPending = true;
    await Promise.all(
      [...this.active.keys()].map((id) =>
        this.stop(id, "Pelican shut down", false, pelican),
      ),
    );
  }
}
