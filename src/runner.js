import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { effortSchema } from "./schema.js";
import { parseWorkflow } from "./workflow.js";
import { liveStates, questionView } from "./views.js";
import { pelican } from "./fleet.js";

// The built-in workflow runner. A run is a workflow script executing inside
// the service, in its own worker thread, as the orchestrator that started it:
// every agent() call spawns a Codex agent through the gateway under that
// name, so the agents' questions wait for that orchestrator like any other.
//
// The journal (the workspace's store) records each agent() call of each
// execution: its index, a hash of the prompt and the options that shape the
// work (schema, model, effort, resources), the agent's id, its status and
// result. A resume runs the script again and answers a call from the journal
// when an earlier execution completed the same call (the same hash, and the
// same occurrence of it: the third identical call matches the third). A call
// whose agent was cut off (stopped, interrupted by a restart) continues that
// agent; any other call runs live. Runs that were running when the service
// stopped are marked interrupted on the next start, never restarted on their
// own.
export const runStatuses = [
  "running",
  "completed",
  "failed",
  "stopped",
  "interrupted",
];
const settledStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
  "replayed",
]);
const failedStates = new Set(["failed", "cancelled", "interrupted", "blocked"]);
const continuable = new Set(["interrupted", "cancelled"]);
// Model names Claude Code workflows use. They mean nothing to Codex, so a
// ported script's agents take the workspace's model instead.
const claudeModels = new Set(["sonnet", "opus", "haiku", "fable", "inherit"]);
const keepMs = 7 * 86400000;
const logLimit = 200;
export const noPhase = "(no phase)";
const stamp = () => new Date().toISOString();
const short = (id) => String(id ?? "").slice(0, 8);
const failure = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode });
const clip = (value, limit) => {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const firstLine = (text, limit) =>
  String(text).trim().split(/\r?\n/)[0].slice(0, limit);
const fold = (path) =>
  process.platform === "win32" ? path.toLowerCase() : path;
const inside = (folder, path) => {
  const r = relative(fold(folder), fold(path));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const optionsSchema = z
  .object({
    label: z.string().trim().min(1).max(140).optional(),
    phase: z.string().trim().min(1).max(140).optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    effort: effortSchema.optional(),
    name: z.string().trim().min(1).max(140).optional(),
    resources: z.array(z.string().min(1)).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    // Claude Code options without a Pelican counterpart: ignored.
    isolation: z.unknown().optional(),
    agentType: z.unknown().optional(),
  })
  .strict();

// JSON with sorted keys, so equal options hash alike.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
// What decides whether a journal entry answers a call: the prompt and the
// options that shape the agent's work. label, phase, name and priority only
// present or order it, and may change between executions.
export function callHash(prompt, opts = {}) {
  return createHash("sha256")
    .update(
      canonical({
        prompt,
        schema: opts.schema ?? null,
        model: opts.model ?? null,
        effort: opts.effort ?? null,
        resources: opts.resources ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

export class Runner extends EventEmitter {
  constructor(gateway) {
    super();
    this.setMaxListeners(0);
    this.gateway = gateway;
    this.hub = gateway.hub;
    this.runs = new Map();
    this.calls = new Map();
    this.live = new Map();
    this.stopping = new Set();
    this.watchers = new Map();
    this.versions = new Map();
    this.closed = false;
    this.load();
    this.onHubEvent = (_, event) => {
      const watcher = event?.jobId ? this.watchers.get(event.jobId) : null;
      if (!watcher) return;
      if (/^(job|agent|questions)\./.test(event.type)) this.bump(watcher.run);
      if (watcher.fleet.done(watcher.job))
        queueMicrotask(() => {
          if (this.watchers.get(event.jobId) === watcher) this.settle(watcher);
        });
    };
    // Only while a run is live: a shutdown interrupts it.
    this.onClosing = () =>
      this.interruptAll("Pelican shut down while this run was working.");
    this.hub.on("event", this.onHubEvent);
  }
  // Runs from earlier service lifetimes. One that was running did not
  // survive: it is interrupted, and its cut-off calls take their agents'
  // final status.
  load() {
    for (const record of this.hub.records) {
      const fleet = this.hub.fleets.get(record.id);
      for (const run of fleet.store.runs()) {
        if (
          run.endedAt &&
          run.status !== "running" &&
          Date.now() - Date.parse(run.endedAt) > keepMs
        ) {
          fleet.store.deleteRun(run.id);
          continue;
        }
        run.workspace = record.id;
        const calls = fleet.store.runCalls(run.id, run.execution);
        for (const entry of calls)
          if (!settledStates.has(entry.status)) {
            const job = entry.jobId ? fleet.jobs.get(entry.jobId) : null;
            entry.status =
              job && !liveStates.has(job.status) ? job.status : "interrupted";
            entry.endedAt = stamp();
            fleet.store.saveRunCall(run.id, entry);
          }
        this.runs.set(run.id, run);
        this.calls.set(run.id, calls);
        if (run.status === "running") {
          Object.assign(run, {
            status: "interrupted",
            endedAt: stamp(),
            error: `Pelican restarted while this run was working. Resume it: pelican run --resume ${short(run.id)}`,
          });
          this.log(run, run.error, { journal: false });
          this.journal(run, "run.finished", {
            status: run.status,
            error: run.error,
          });
        }
      }
    }
  }
  // What a run does goes into its workspace's journal under its owner (the
  // orchestrator it acts for), so that orchestrator's timeline shows it:
  // run.started, run.resumed, run.stopped, run.finished, run.agent (each
  // agent it starts) and run.note (each log line). Every entry carries runId.
  journal(run, type, data = {}) {
    const fleet = this.hub.fleets.get(run.workspace);
    if (!fleet || !this.storeOf(run)) return;
    fleet.emitEvent(null, type, {
      runId: run.id,
      name: run.name,
      owner: run.owner,
      by: run.owner,
      ...data,
    });
  }
  storeOf(run) {
    const store = this.hub.fleets.get(run.workspace)?.store;
    return store && !store.closed && !this.closed ? store : null;
  }
  save(run) {
    run.updatedAt = stamp();
    this.storeOf(run)?.saveRun(run);
  }
  saveCall(run, entry) {
    this.storeOf(run)?.saveRunCall(run.id, entry);
  }
  version(run) {
    return this.versions.get(run.id) ?? 0;
  }
  bump(run) {
    this.versions.set(run.id, this.version(run) + 1);
    this.emit("change", run.id);
  }
  // A line of the run's log, journaled as a run.note unless a structured
  // entry says the same.
  log(run, text, { journal = true } = {}) {
    const line = { at: stamp(), text: clip(text, 2000) };
    run.log.push(line);
    if (run.log.length > logLimit) run.log.splice(0, run.log.length - logLimit);
    this.save(run);
    if (journal) this.journal(run, "run.note", { text: line.text });
    this.bump(run);
  }
  // Once per execution, for notes about a ported script.
  note(run, runtime, key, text) {
    if (runtime.notes.has(key)) return;
    runtime.notes.add(key);
    this.log(run, text);
  }
  addPhase(run, title) {
    if (title && !run.phases.some((p) => p.title === title))
      run.phases.push({ title });
  }
  drop(id) {
    this.runs.delete(id);
    this.calls.delete(id);
    this.versions.delete(id);
  }
  // Runs are kept seven days after they end, like the journal; runs of a
  // removed workspace went with its data.
  expire(now = Date.now()) {
    for (const run of [...this.runs.values()]) {
      if (!this.hub.fleets.has(run.workspace)) this.drop(run.id);
      else if (
        run.endedAt &&
        !this.live.has(run.id) &&
        now - Date.parse(run.endedAt) > keepMs
      ) {
        this.storeOf(run)?.deleteRun(run.id);
        this.drop(run.id);
      }
    }
  }
  // By id, a unique id prefix (4+ characters), or name (the newest run of it).
  find(ref) {
    const wanted = String(ref ?? "").trim();
    if (!wanted) throw failure(400, "Name a run by its id.");
    this.expire();
    const exact = this.runs.get(wanted);
    if (exact) return exact;
    const all = [...this.runs.values()];
    const lower = wanted.toLowerCase();
    const prefixed =
      wanted.length >= 4 ? all.filter((r) => r.id.startsWith(lower)) : [];
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1)
      throw failure(
        409,
        `"${wanted}" matches ${prefixed.length} runs: ${prefixed
          .slice(0, 5)
          .map((r) => `${r.id} (${r.name})`)
          .join(", ")}. Use more of the id.`,
      );
    const named = all
      .filter((r) => r.name.toLowerCase() === lower)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (named.length) return named[0];
    throw failure(404, `No run "${wanted}".`);
  }
  running(workspace) {
    return [...this.runs.values()].filter(
      (run) => run.workspace === workspace && this.live.has(run.id),
    );
  }
  job(run, id) {
    return id
      ? (this.hub.fleets.get(run.workspace)?.jobs.get(id) ?? null)
      : null;
  }
  callStatus(run, entry) {
    if (settledStates.has(entry.status)) return entry.status;
    return this.job(run, entry.jobId)?.status ?? entry.status;
  }
  // The JSON shapes. runs.list: row; runs.get: detail.
  row(run) {
    const calls = this.calls.get(run.id) ?? [];
    const agents = { total: calls.length, live: 0, done: 0, failed: 0 };
    for (const entry of calls) {
      const status = this.callStatus(run, entry);
      if (status === "completed" || status === "replayed") agents.done++;
      else if (failedStates.has(status)) agents.failed++;
      else agents.live++;
    }
    return {
      id: run.id,
      name: run.name,
      workspace: run.workspace,
      cwd: run.cwd,
      owner: run.owner,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      agents,
    };
  }
  detail(run) {
    const calls = this.calls.get(run.id) ?? [];
    const view = (entry) => ({
      label: entry.label,
      jobId: entry.jobId,
      status: this.callStatus(run, entry),
    });
    const phases = run.phases.map(({ title }) => ({
      title,
      agents: calls.filter((e) => e.phase === title).map(view),
    }));
    for (const entry of calls)
      if (entry.phase && !phases.some((p) => p.title === entry.phase))
        phases.push({
          title: entry.phase,
          agents: calls.filter((e) => e.phase === entry.phase).map(view),
        });
    const loose = calls.filter((e) => !e.phase);
    if (loose.length)
      phases.unshift({ title: noPhase, agents: loose.map(view) });
    return {
      ...this.row(run),
      phases,
      log: run.log.slice(-logLimit),
      result: run.result ?? null,
      error: run.error ?? null,
      questions: this.questions(run),
    };
  }
  questions(run) {
    const out = [];
    for (const entry of this.calls.get(run.id) ?? []) {
      if (settledStates.has(entry.status)) continue;
      const job = this.job(run, entry.jobId);
      for (const q of job?.pending ?? [])
        out.push({
          ...questionView(job, q, run.workspace),
          label: entry.label,
        });
    }
    return out;
  }
  async source(caller, { file, source }) {
    if (file !== undefined && source !== undefined)
      throw failure(400, "Give the workflow as file or as source, not both.");
    if (source !== undefined) return { text: source, path: null };
    if (file === undefined)
      throw failure(
        400,
        "Give the workflow: file (its path) or source (its text).",
      );
    const path = this.gateway.absolute(caller, file);
    try {
      return { text: await readFile(path, "utf8"), path };
    } catch (error) {
      throw failure(
        400,
        `Cannot read the workflow ${path}: ${error.code === "ENOENT" ? "no such file" : error.message}`,
      );
    }
  }
  async start({ file, source, args, workspace, name, cwd }, caller) {
    if (this.hub.closing || this.closed)
      throw failure(409, "Pelican is stopping.");
    this.expire();
    const { text, path } = await this.source(caller, { file, source });
    const script = parseWorkflow(text, path ?? "workflow.js");
    // Its agents work in the workspace's folder unless the caller names
    // another inside it. The folder the caller is in only resolves relative
    // paths: a script kept in a subfolder still drives the whole checkout.
    const named = cwd === undefined ? null : this.gateway.absolute(caller, cwd);
    const record = this.gateway.workspaceFor(
      caller,
      workspace,
      named ? [named] : [],
    );
    const folder = named ?? record.folder;
    if (!inside(record.folder, folder))
      throw failure(
        400,
        `cwd must be inside the workspace's folder (${record.folder}).`,
      );
    if (!(await stat(folder).catch(() => null))?.isDirectory())
      throw failure(400, `cwd ${folder} is not an existing directory.`);
    const now = stamp();
    const run = {
      id: randomUUID(),
      name: name ?? script.meta.name,
      description: script.meta.description,
      file: path,
      ...(args === undefined ? {} : { args }),
      workspace: record.id,
      owner: caller.as,
      cwd: folder,
      status: "running",
      execution: 1,
      createdAt: now,
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      phases: script.meta.phases,
      currentPhase: null,
      log: [],
      result: null,
      error: null,
    };
    this.runs.set(run.id, run);
    this.calls.set(run.id, []);
    this.save(run);
    this.storeOf(run)?.saveRunSource(run.id, text);
    this.log(run, `Started by ${caller.as}${path ? ` from ${path}` : ""}.`, {
      journal: false,
    });
    this.journal(run, "run.started", {
      file: path,
      description: run.description,
      workspace: run.workspace,
    });
    this.launch(run, script, new Map());
    return this.row(run);
  }
  // Runs the script again against its journal: the file as it is now (or the
  // one given, or the source it last ran with when the file is gone).
  async resume({ id, file, source, args, takeover }, caller) {
    const run = this.find(id);
    if (this.hub.closing || this.closed)
      throw failure(409, "Pelican is stopping.");
    if (this.live.has(run.id) || this.stopping.has(run.id))
      throw failure(
        409,
        `Run ${run.name} (${short(run.id)}) is still running. Stop it first: pelican run-stop ${short(run.id)}`,
      );
    if (run.owner !== caller.as && !takeover)
      throw failure(
        403,
        `Run ${run.name} (${short(run.id)}) belongs to ${run.owner}. Pass takeover to resume it yourself.`,
      );
    const store = this.storeOf(run);
    if (!store) throw failure(409, "The run's workspace is not available.");
    let text, path;
    if (file !== undefined || source !== undefined)
      ({ text, path } = await this.source(caller, { file, source }));
    else if (run.file) {
      try {
        text = await readFile(run.file, "utf8");
        path = run.file;
      } catch (error) {
        text = store.runSource(run.id);
        path = null;
        if (text === null)
          throw failure(
            400,
            `Cannot read the workflow ${run.file} (${error.message}), and no copy of it was kept.`,
          );
      }
    } else {
      text = store.runSource(run.id);
      path = null;
      if (text === null)
        throw failure(400, "No copy of the workflow was kept; give file.");
    }
    const script = parseWorkflow(text, path ?? run.file ?? "workflow.js");
    // The best journal entry for each call: a result beats everything,
    // otherwise the latest attempt.
    const pool = new Map();
    for (const entry of store.runCalls(run.id)) {
      if (!entry.hash) continue;
      const key = `${entry.hash}#${entry.occurrence}`;
      if (entry.ok || !pool.get(key)?.ok) pool.set(key, entry);
    }
    const missing = run.file && !path && file === undefined && !source;
    Object.assign(run, {
      execution: run.execution + 1,
      status: "running",
      owner: caller.as,
      description: script.meta.description,
      startedAt: stamp(),
      endedAt: null,
      result: null,
      error: null,
      currentPhase: null,
      phases: script.meta.phases,
      ...(missing ? {} : { file: path }),
      ...(args === undefined ? {} : { args }),
    });
    this.calls.set(run.id, []);
    this.save(run);
    store.saveRunSource(run.id, text);
    const ready = [...pool.values()].filter((e) => e.ok).length;
    if (missing)
      this.log(
        run,
        `${run.file} could not be read; resuming with the copy kept at the last start.`,
      );
    this.log(
      run,
      `Resumed by ${caller.as} (execution ${run.execution}): ${ready} earlier result${ready === 1 ? "" : "s"} can replay.`,
      { journal: false },
    );
    this.journal(run, "run.resumed", {
      execution: run.execution,
      replayable: ready,
      file: run.file,
      workspace: run.workspace,
    });
    this.launch(run, script, pool);
    return this.row(run);
  }
  launch(run, script, pool) {
    const worker = new Worker(
      new URL("./workflow-worker.js", import.meta.url),
      {
        workerData: {
          code: script.code,
          filename: script.filename,
          args: run.args === undefined ? undefined : JSON.stringify(run.args),
        },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      },
    );
    worker.unref();
    const runtime = {
      worker,
      pool,
      occurrences: new Map(),
      notes: new Set(),
      replayed: 0,
      ended: false,
    };
    if (!this.live.size) this.hub.on("closing", this.onClosing);
    this.live.set(run.id, runtime);
    worker.on("message", (message) => this.message(run, runtime, message));
    worker.on("error", (error) =>
      this.end(
        run,
        runtime,
        "failed",
        null,
        `The workflow crashed: ${error.message}`,
      ),
    );
    worker.on("exit", (code) =>
      this.end(
        run,
        runtime,
        "failed",
        null,
        `The workflow stopped unexpectedly (exit code ${code}).`,
      ),
    );
  }
  message(run, runtime, message) {
    if (runtime.ended || this.live.get(run.id) !== runtime) return;
    switch (message?.type) {
      case "agent":
        void this.call(run, runtime, message).catch((error) =>
          this.reply(runtime, message.call, undefined, error.message),
        );
        return;
      case "phase": {
        const title = clip(String(message.title ?? "").trim(), 140);
        if (!title) return;
        run.currentPhase = title;
        this.addPhase(run, title);
        this.log(run, `Phase: ${title}`);
        return;
      }
      case "log":
        this.log(run, message.text);
        return;
      case "done": {
        let result = null;
        try {
          result = JSON.parse(message.result ?? "null");
        } catch {
          /* The worker always sends JSON. */
        }
        this.end(run, runtime, "completed", result, null);
        return;
      }
      case "error":
        this.end(
          run,
          runtime,
          "failed",
          null,
          message.at
            ? `${message.message} (at ${message.at})`
            : message.message,
        );
    }
  }
  reply(runtime, call, value, error) {
    if (runtime.ended) return;
    try {
      runtime.worker.postMessage(
        error === undefined
          ? { type: "reply", call, value: JSON.stringify(value ?? null) }
          : { type: "reply", call, error: String(error) },
      );
    } catch {
      /* The worker is gone. */
    }
  }
  check(run, runtime, input) {
    const prompt = input?.prompt;
    if (typeof prompt !== "string" || !prompt.trim())
      throw new Error("agent() takes a prompt: a nonempty string.");
    if (prompt.length > 150000)
      throw new Error("agent()'s prompt is longer than 150000 characters.");
    const given = input.opts ?? {};
    if (typeof given !== "object" || Array.isArray(given))
      throw new Error("agent()'s options are an object.");
    const parsed = optionsSchema.safeParse(
      Object.fromEntries(Object.entries(given).filter(([, v]) => v !== null)),
    );
    if (!parsed.success)
      throw new Error(`agent() options: ${z.prettifyError(parsed.error)}`);
    const opts = { ...parsed.data };
    if (opts.model && claudeModels.has(opts.model.toLowerCase())) {
      this.note(
        run,
        runtime,
        `model:${opts.model}`,
        `model "${opts.model}" is a Claude Code model name, not a Codex model; those agents take the workspace's model.`,
      );
      delete opts.model;
    }
    for (const key of ["isolation", "agentType"])
      if (key in opts) {
        this.note(
          run,
          runtime,
          key,
          `agent() option ${key} is Claude Code's; Pelican ignores it (reserve paths with resources instead).`,
        );
        delete opts[key];
      }
    return { prompt, opts };
  }
  // One agent() call: answered from the journal, or an agent that runs.
  async call(run, runtime, { call, payload, phase }) {
    const calls = this.calls.get(run.id);
    const entry = {
      execution: run.execution,
      index: calls.length,
      hash: null,
      occurrence: 0,
      label: `call ${calls.length + 1}`,
      phase: null,
      jobId: null,
      status: "queued",
      ok: false,
      result: null,
      error: null,
      startedAt: stamp(),
      endedAt: null,
    };
    calls.push(entry);
    let prompt, opts;
    try {
      ({ prompt, opts } = this.check(run, runtime, JSON.parse(payload)));
    } catch (error) {
      return this.refuse(run, runtime, entry, call, error.message);
    }
    entry.label = clip(opts.label ?? opts.name ?? firstLine(prompt, 80), 140);
    entry.phase =
      opts.phase ??
      (typeof phase === "string" && phase.trim()
        ? clip(phase.trim(), 140)
        : null);
    entry.hash = callHash(prompt, opts);
    entry.occurrence = runtime.occurrences.get(entry.hash) ?? 0;
    runtime.occurrences.set(entry.hash, entry.occurrence + 1);
    this.addPhase(run, entry.phase);
    const prior = runtime.pool.get(`${entry.hash}#${entry.occurrence}`);
    if (prior?.ok) {
      Object.assign(entry, {
        status: "replayed",
        ok: true,
        result: prior.result,
        jobId: prior.jobId,
        endedAt: stamp(),
      });
      runtime.replayed++;
      this.saveCall(run, entry);
      this.save(run);
      this.bump(run);
      return this.reply(runtime, call, entry.result);
    }
    this.saveCall(run, entry);
    this.save(run);
    this.bump(run);
    let job;
    try {
      job = await this.dispatch(run, prior, prompt, opts);
    } catch (error) {
      return this.refuse(run, runtime, entry, call, error.message);
    }
    entry.jobId = job.id;
    entry.status = job.status;
    this.saveCall(run, entry);
    const continued = prior?.jobId === job.id;
    this.journal(run, "run.agent", {
      label: entry.label,
      phase: entry.phase,
      call: entry.index,
      jobId: job.id,
      agentName: job.agentName,
      continued,
    });
    this.bump(run);
    if (continued && !runtime.ended)
      this.log(
        run,
        `${entry.label}: ${job.agentName} (${short(job.id)}) continues where it was cut off.`,
      );
    const fleet = this.hub.fleets.get(run.workspace);
    // The run ended while this agent was being started: nobody waits for it.
    if (runtime.ended && !fleet.done(job))
      void fleet
        .stop(
          job.id,
          "The workflow ended before this agent started.",
          false,
          pelican,
        )
        .catch(() => {});
    const watcher = { run, runtime, entry, call, job, fleet };
    this.watchers.set(job.id, watcher);
    if (fleet.done(job)) this.settle(watcher);
  }
  refuse(run, runtime, entry, call, message) {
    Object.assign(entry, {
      status: "failed",
      error: message,
      endedAt: stamp(),
    });
    this.saveCall(run, entry);
    if (!runtime.ended) this.log(run, `${entry.label}: ${message}`);
    this.reply(runtime, call, undefined, message);
  }
  async dispatch(run, prior, prompt, opts) {
    const fleet = this.hub.fleets.get(run.workspace);
    if (!fleet) throw new Error("The run's workspace no longer exists.");
    const context = {
      as: run.owner,
      workspace: run.workspace,
      cwd: run.cwd,
    };
    const earlier = continuable.has(prior?.status)
      ? fleet.jobs.get(prior.jobId)
      : null;
    if (earlier) {
      if (!fleet.done(earlier) || earlier.status === "completed")
        return earlier;
      if (continuable.has(earlier.status)) {
        await this.gateway.invoke(
          "resume",
          { id: earlier.id, takeover: true },
          context,
        );
        return earlier;
      }
    }
    const row = await this.gateway.invoke(
      "spawn",
      {
        name: opts.name ?? opts.label ?? firstLine(prompt, 140),
        prompt,
        cwd: run.cwd,
        ...(opts.resources ? { resources: opts.resources } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.schema ? { resultSchema: opts.schema } : {}),
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        workspace: run.workspace,
      },
      context,
    );
    return fleet.jobs.get(row.id);
  }
  // The agent is done: its validated result (with a schema), else its
  // summary and report; null when it did not complete.
  settle({ run, runtime, entry, call, job }) {
    this.watchers.delete(job.id);
    const ok = job.status === "completed";
    const result = ok
      ? job.resultSchema
        ? job.result
        : { summary: job.summary, report: job.report }
      : null;
    Object.assign(entry, {
      status: job.status,
      ok,
      result,
      error: ok ? null : job.error,
      endedAt: stamp(),
    });
    this.saveCall(run, entry);
    this.bump(run);
    if (runtime.ended || this.live.get(run.id) !== runtime) return;
    if (!ok)
      this.log(
        run,
        `${entry.label}: ${job.agentName} (${short(job.id)}) ${job.status}${job.error ? `: ${clip(job.error, 300)}` : ""}. agent() returns null.`,
      );
    this.reply(runtime, call, result);
  }
  liveJobs(run) {
    const fleet = this.hub.fleets.get(run.workspace);
    if (!fleet) return [];
    return (this.calls.get(run.id) ?? [])
      .filter((e) => !settledStates.has(e.status) && e.jobId)
      .map((e) => fleet.jobs.get(e.jobId))
      .filter((job) => job && !fleet.done(job))
      .map((job) => ({ job, fleet }));
  }
  end(run, runtime, status, result, error, { by = run.owner, asked } = {}) {
    if (runtime.ended) return false;
    runtime.ended = true;
    if (this.live.get(run.id) === runtime) this.live.delete(run.id);
    if (!this.live.size) this.hub.off("closing", this.onClosing);
    void runtime.worker.terminate().catch(() => {});
    Object.assign(run, {
      status,
      result: result ?? null,
      error: error ?? null,
      endedAt: stamp(),
    });
    const calls = this.calls.get(run.id) ?? [];
    this.log(
      run,
      status === "completed"
        ? `Completed: ${calls.length} agent call${calls.length === 1 ? "" : "s"}, ${runtime.replayed} replayed from the journal.`
        : status === "failed"
          ? `Failed: ${error}`
          : error,
      { journal: false },
    );
    const agents = this.row(run).agents;
    if (status === "stopped")
      this.journal(run, "run.stopped", {
        by,
        to: run.owner,
        reason: asked ?? null,
        error,
        agents,
      });
    else
      this.journal(run, "run.finished", {
        status,
        error: error ?? null,
        agents,
        ...(JSON.stringify(result ?? null).length <= 20000
          ? { result: result ?? null }
          : { resultTruncated: true }),
      });
    // Agents the script did not wait for have nobody to report to.
    if (status === "completed" || status === "failed") {
      const reason =
        status === "completed"
          ? "The workflow ended without waiting for this agent."
          : `The workflow failed: ${clip(error, 300)}`;
      for (const { job, fleet } of this.liveJobs(run))
        void fleet.stop(job.id, reason, false, pelican).catch(() => {});
    }
    return true;
  }
  // The script ends first, so stopped agents do not answer it; then its
  // live agents stop. A stopped run can be resumed.
  async stop({ id, reason }, caller) {
    const run = this.find(id);
    const runtime = this.live.get(run.id);
    if (!runtime) return this.detail(run);
    const by = caller.as ?? "anonymous";
    const why = reason ? `Stopped by ${by}: ${reason}` : `Stopped by ${by}.`;
    this.stopping.add(run.id);
    try {
      this.end(run, runtime, "stopped", null, why, { by, asked: reason });
      await Promise.all(
        this.liveJobs(run).map(({ job, fleet }) =>
          fleet.stop(job.id, why, false, caller.as ?? pelican),
        ),
      );
    } finally {
      this.stopping.delete(run.id);
    }
    return this.detail(run);
  }
  async stopAll({ workspaces, owner, reason, by }) {
    const stopped = [];
    for (const run of [...this.runs.values()])
      if (
        this.live.has(run.id) &&
        workspaces.includes(run.workspace) &&
        (!owner || run.owner === owner)
      ) {
        await this.stop(
          { id: run.id, reason: reason ?? "stop all" },
          { as: by },
        );
        stopped.push(this.row(run));
      }
    return stopped;
  }
  interruptAll(reason) {
    for (const [id, runtime] of [...this.live]) {
      const run = this.runs.get(id);
      if (run)
        this.end(
          run,
          runtime,
          "interrupted",
          null,
          `${reason} Resume it: pelican run --resume ${short(id)}`,
        );
    }
  }
  list({ workspace, status }, caller) {
    this.expire();
    const wanted = new Set();
    for (const word of [status ?? []]
      .flat()
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!runStatuses.includes(word))
        throw failure(
          400,
          `Unknown run status ${word}. Use ${runStatuses.join(", ")}.`,
        );
      wanted.add(word);
    }
    const scope = new Set(
      this.gateway.scope(caller, workspace).map((record) => record.id),
    );
    return [...this.runs.values()]
      .filter(
        (run) =>
          scope.has(run.workspace) && (!wanted.size || wanted.has(run.status)),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((run) => this.row(run));
  }
  get({ id }) {
    return this.detail(this.find(id));
  }
  // Until the run ends, or one of its agents asks a question. With after (a
  // version from an earlier wait), until anything about the run changes.
  async wait({ id, timeoutMs, after }, caller, { signal } = {}) {
    const run = this.find(id);
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (after !== undefined && this.version(run) > after)
        return run.status === "running" ? "change" : "done";
      if (run.status !== "running") return "done";
      if (after === undefined && this.questions(run).length) return "question";
      return null;
    };
    let reason = check();
    while (!reason && Date.now() < deadline && !this.hub.closing) {
      await this.changed(run.id, deadline - Date.now(), signal);
      reason = check();
    }
    return {
      reason: reason ?? "timeout",
      version: this.version(run),
      run: this.detail(run),
    };
  }
  changed(id, timeoutMs, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        this.off("change", listen);
        this.hub.off("closing", wake);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const listen = (changed) => {
        if (changed === id) finish();
      };
      const wake = () => finish();
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(), Math.max(0, timeoutMs));
      timer.unref?.();
      this.on("change", listen);
      this.hub.once("closing", wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  // Ends every script without touching the store, as when the process
  // dies (tests use it; a graceful shutdown interrupts runs instead).
  close() {
    this.closed = true;
    for (const runtime of this.live.values()) {
      runtime.ended = true;
      void runtime.worker.terminate().catch(() => {});
    }
    this.live.clear();
    this.watchers.clear();
    this.hub.off("event", this.onHubEvent);
    this.hub.off("closing", this.onClosing);
  }
}
