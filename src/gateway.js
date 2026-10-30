import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { api, allStatuses, statusGroups } from "./api.js";
import { callerSchema } from "./schema.js";
import { CodexProcess } from "./codex.js";
import { requestQueue } from "./request-queue.js";
import { pelican } from "./fleet.js";
import {
  eventView,
  jobDetail,
  jobRow,
  questionView,
  resultView,
} from "./views.js";
import { journalLine } from "./journal.js";
import {
  byTime,
  formatCursor,
  ownedTypes,
  parseCursor,
  timelineEntry,
  timelineTypes,
} from "./timeline.js";
import { facade } from "./facade.js";
import { Runner } from "./runner.js";
import { metrics } from "./metrics.js";

// The orchestrator's feed: what changes an agent's state or needs an answer.
export const feedTypes = [
  "job.created",
  "job.started",
  "job.finished",
  "job.cancelled",
  "job.stopRequested",
  "job.resumed",
  "job.retrying",
  "job.restarting",
  "job.overloaded",
  "job.throttled",
  "job.recovered",
  "job.owner",
  "agent.question",
  "agent.answered",
  "agent.message",
  "agent.report",
  "message.sent",
  "questions.expired",
  "settings.updated",
  "warning",
  "scheduler.error",
  // Workflow runs, under their owner (runner.js).
  "run.started",
  "run.resumed",
  "run.stopped",
  "run.finished",
  "run.agent",
  "run.note",
];
// One agent's journal, for tail.
const tailTypes = [
  ...feedTypes.filter((t) => t !== "settings.updated"),
  "item/started",
  "item/completed",
];
const handlers = {
  status: "status",
  workspaces: "workspaces",
  "workspace.add": "addWorkspace",
  "workspace.remove": "removeWorkspace",
  settings: "settings",
  spawn: "spawn",
  batch: "batch",
  get: "get",
  list: "list",
  wait: "wait",
  message: "message",
  resume: "resume",
  answer: "answer",
  questions: "questions",
  stop: "stop",
  events: "events",
  tail: "tail",
  note: "note",
  feed: "feed",
  metrics: "metrics",
  models: "models",
  account: "account",
  usage: "usage",
  shutdown: "shutdown",
  "runs.start": "startRun",
  "runs.list": "listRuns",
  "runs.get": "getRun",
  "runs.stop": "stopRun",
  "runs.resume": "resumeRun",
  "runs.wait": "waitRun",
};
const failure = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode });
// The one API behind the CLI, the HTTP RPC, the MCP server and workflows.
// Every call carries a context: who is calling (as), the workspace it named,
// and the folder it works in (cwd), which picks the workspace when none is
// named.
export class Gateway {
  constructor(hub, { account, service = {}, onShutdown } = {}) {
    this.hub = hub;
    // Not this.account: that would hide the account() method.
    this.accountAdapter = account;
    this.service = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...service,
    };
    this.onShutdown = onShutdown;
    // Calls in flight and when one last started or ended: what keeps the
    // service up (see idle.js).
    this.calls = 0;
    this.lastCall = Date.now();
    hub.setMaxListeners(0);
    // Workflow runs (runner.js): scripts that drive agents through this
    // gateway as the orchestrator that started them.
    this.runner = new Runner(this);
  }
  // What the service is doing for anyone: calls in flight, agents running
  // or queued to run, workflow runs, and when a call last started or ended.
  busy() {
    return {
      calls: this.calls,
      agents: this.hub.busy(),
      runs: this.runner.live.size,
      lastCall: this.lastCall,
    };
  }
  invoke(method, params, context, options) {
    this.calls++;
    this.lastCall = Date.now();
    return this.dispatch(method, params, context, options).finally(() => {
      this.calls--;
      this.lastCall = Date.now();
    });
  }
  async dispatch(method, params = {}, context = {}, { signal } = {}) {
    const entry = Object.hasOwn(api, method) ? api[method] : null;
    if (!entry) throw failure(404, `Unknown method: ${method}`);
    const parsed = entry.params.safeParse(params ?? {});
    if (!parsed.success)
      throw failure(400, `${method}: ${z.prettifyError(parsed.error)}`);
    const caller = this.caller(context, entry.caller);
    return this[handlers[method]](parsed.data, caller, { signal });
  }
  // The same calls as methods, in process (workflows, tests); the same
  // facade as client.connect over HTTP.
  as(name, defaults = {}) {
    const context = { as: name, ...defaults };
    return facade(
      (method, params, options) =>
        this.invoke(method, params, context, options),
      context,
    );
  }
  caller({ as, workspace, cwd } = {}, required = false) {
    let name = typeof as === "string" ? as.trim() : "";
    if (name) {
      const checked = callerSchema.safeParse(name);
      if (!checked.success) throw failure(400, checked.error.issues[0].message);
      if (name.toLowerCase() === pelican)
        throw failure(
          400,
          `"${pelican}" is Pelican's own name; choose another.`,
        );
    } else if (required)
      throw failure(
        400,
        "Name yourself first: --as <name>, PELICAN_AS, or the x-pelican-as header. Your agents' questions come back to that name.",
      );
    return {
      as: name || null,
      workspace:
        typeof workspace === "string" && workspace.trim()
          ? workspace.trim()
          : null,
      cwd: typeof cwd === "string" && isAbsolute(cwd) ? cwd : null,
    };
  }
  workspaceFor(caller, named, paths = []) {
    return this.hub.resolve({
      workspace: named ?? caller.workspace,
      paths: [...paths, caller.cwd].filter(Boolean),
    });
  }
  // Workspaces a read spans: the one named, else all of them.
  scope(caller, named) {
    const wanted = named ?? caller.workspace;
    return wanted ? [this.hub.record(wanted)] : this.hub.records;
  }
  // Directing someone else's agent takes an explicit takeover.
  own(found, caller, takeover) {
    const { job, fleet } = found;
    if (job.owner === caller.as) return;
    if (!takeover)
      throw failure(
        403,
        `${job.agentName} (${job.id}) belongs to ${job.owner}. Pass takeover to direct it yourself.`,
      );
    const previous = job.owner;
    job.owner = caller.as;
    for (const q of job.pending) q.owner = caller.as;
    fleet.save(job, "job.owner", {
      from: previous,
      to: caller.as,
      by: caller.as,
    });
  }
  absolute(caller, path) {
    if (path === undefined || isAbsolute(path)) return path;
    if (!caller.cwd)
      throw failure(400, `${path} is relative; give an absolute path.`);
    return resolve(caller.cwd, path);
  }
  status() {
    const workspaces = this.hub.list();
    const total = (key) => workspaces.reduce((sum, w) => sum + w[key], 0);
    return {
      service: {
        ...this.service,
        uptimeMs: Date.now() - Date.parse(this.service.startedAt),
      },
      totals: {
        agents: total("agents"),
        working: total("working"),
        queued: total("queued"),
        questions: total("questions"),
      },
      workspaces,
    };
  }
  workspaces() {
    return this.hub.list();
  }
  addWorkspace({ folder, name }, caller) {
    return this.hub.add({ folder: this.absolute(caller, folder), name });
  }
  async removeWorkspace({ workspace }) {
    const record = this.hub.record(workspace);
    const runs = this.runner.running(record.id);
    if (runs.length)
      throw failure(
        409,
        `${record.name} has ${runs.length} workflow run${runs.length === 1 ? "" : "s"} running. Stop ${runs.length === 1 ? "it" : "them"} first: ${runs.map((r) => `pelican run-stop ${r.id.slice(0, 8)}`).join("; ")}`,
      );
    const removed = await this.hub.remove(workspace);
    this.runner.expire();
    return removed;
  }
  settings({ workspace, ...changes }, caller) {
    const record = this.workspaceFor(caller, workspace);
    const fleet = this.hub.fleets.get(record.id);
    const settings = fleet.updateSettings(changes, caller.as ?? "anonymous");
    return {
      workspace: record.id,
      name: record.name,
      folder: record.folder,
      settings,
    };
  }
  async spawn({ workspace, ...brief }, caller) {
    brief.cwd = this.absolute(caller, brief.cwd);
    const record = this.workspaceFor(caller, workspace, [brief.cwd]);
    const job = await this.hub.fleets.get(record.id).create(brief, caller.as);
    return jobRow(job, record.id);
  }
  async batch({ workspace, jobs }, caller) {
    for (const job of jobs) job.cwd = this.absolute(caller, job.cwd);
    const record = this.workspaceFor(
      caller,
      workspace,
      jobs.map((job) => job.cwd),
    );
    const created = await this.hub.fleets
      .get(record.id)
      .createBatch(jobs, caller.as);
    return created.map((job) => jobRow(job, record.id));
  }
  get({ id }) {
    const { job, fleet, record } = this.hub.find(id);
    return jobDetail(job, record.id, { done: fleet.done(job) });
  }
  list({ workspace, status, owner, limit }, caller) {
    const wanted = new Set();
    for (const entry of status ?? [])
      for (const word of entry
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const group =
          statusGroups[word] ??
          (word === "finished" ? statusGroups.done : null);
        if (group) group.forEach((s) => wanted.add(s));
        else if (allStatuses.includes(word)) wanted.add(word);
        else
          throw failure(
            400,
            `Unknown status ${word}. Use ${allStatuses.join(", ")} or active, live, done.`,
          );
      }
    const rows = [];
    for (const record of this.scope(caller, workspace))
      for (const job of this.hub.fleets.get(record.id).jobs.values())
        if (
          (!wanted.size || wanted.has(job.status)) &&
          (!owner || job.owner === owner)
        )
          rows.push(jobRow(job, record.id));
    return rows
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  // Until every agent is done (or any, with any), or one asks a question.
  async wait({ ids, any, timeoutMs }, caller, { signal } = {}) {
    const targets = [
      ...new Map(
        ids.map((id) => {
          const found = this.hub.find(id);
          return [found.job.id, found];
        }),
      ).values(),
    ];
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const done = targets.map((t) => t.fleet.done(t.job));
      if (any ? done.some(Boolean) : done.every(Boolean)) return "done";
      if (targets.some((t, i) => !done[i] && t.job.pending.length))
        return "question";
      return null;
    };
    let reason = check();
    while (!reason && Date.now() < deadline && !this.hub.closing) {
      await this.news(
        new Set(targets.map((t) => t.job.id)),
        deadline - Date.now(),
        signal,
      );
      reason = check();
    }
    return {
      reason: reason ?? "timeout",
      agents: targets.map((t) =>
        resultView(t.job, t.record.id, { done: t.fleet.done(t.job) }),
      ),
    };
  }
  // The next journal entry about one of these agents.
  news(jobIds, timeoutMs, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        this.hub.off("event", listen);
        this.hub.off("closing", wake);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const listen = (_, event) => {
        if (jobIds.has(event.jobId)) finish();
      };
      const wake = () => finish();
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(), Math.max(0, timeoutMs));
      timer.unref?.();
      this.hub.on("event", listen);
      this.hub.once("closing", wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async message({ id, text, mode, takeover }, caller) {
    const found = this.hub.find(id);
    this.own(found, caller, takeover);
    const sent = await found.fleet.message(found.job.id, text, mode, caller.as);
    return {
      delivery: sent.delivery,
      messageId: sent.messageId,
      agent: jobRow(found.job, found.record.id),
    };
  }
  resume({ id, takeover, ...overrides }, caller) {
    const found = this.hub.find(id);
    this.own(found, caller, takeover);
    const job = found.fleet.resume(found.job.id, overrides, caller.as);
    return jobRow(job, found.record.id);
  }
  async answer({ id, requestId, answer, takeover }, caller) {
    const found = this.hub.find(id);
    const { job } = found;
    const matches = job.pending.filter(
      (q) => q.id === requestId || q.id.startsWith(requestId.toLowerCase()),
    );
    const request =
      matches.find((q) => q.id === requestId) ??
      (matches.length === 1 ? matches[0] : null);
    if (!request)
      throw failure(
        matches.length ? 409 : 404,
        matches.length
          ? `requestId ${requestId} matches several questions; use more of it.`
          : `${job.agentName} has no pending question ${requestId}.`,
      );
    this.own(found, caller, takeover);
    await found.fleet.answer(job.id, request.id, answer, caller.as);
    return { answered: request.id, agent: jobRow(job, found.record.id) };
  }
  questions({ workspace, owner }, caller) {
    const all = [];
    for (const record of this.scope(caller, workspace)) {
      const fleet = this.hub.fleets.get(record.id);
      for (const q of requestQueue(fleet.jobs.values())) {
        const view = questionView(fleet.get(q.jobId), q, record.id);
        if (!owner || view.owner === owner) all.push(view);
      }
    }
    return all.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence,
    );
  }
  async stop({ id, all, owner, workspace, reason, force }, caller) {
    if (id && all) throw failure(400, "Name one agent or pass all, not both.");
    if (id) {
      const found = this.hub.find(id);
      await found.fleet.stop(found.job.id, reason, force, caller.as);
      return { stopped: [jobRow(found.job, found.record.id)], runs: [] };
    }
    if (!all) throw failure(400, "Name an agent to stop, or pass all.");
    // Workflow runs first, so their scripts do not start replacements.
    const runs = await this.runner.stopAll({
      workspaces: this.scope(caller, workspace).map((record) => record.id),
      owner,
      reason,
      by: caller.as ?? "anonymous",
    });
    const stopped = [];
    for (const record of this.scope(caller, workspace)) {
      const jobs = await this.hub.fleets
        .get(record.id)
        .stopAll({ owner, reason, by: caller.as });
      stopped.push(...jobs.map((job) => jobRow(job, record.id)));
    }
    return { stopped, runs };
  }
  // A workspace's journal (or one agent's) after a cursor.
  async events(
    { workspace, after, jobId, owner, raw, limit, last, timeoutMs },
    caller,
    { signal } = {},
  ) {
    const found = jobId ? this.hub.find(jobId) : null;
    const record = found?.record ?? this.workspaceFor(caller, workspace);
    const fleet = this.hub.fleets.get(record.id);
    const query = {
      after,
      jobId: found?.job.id,
      owner,
      limit,
      last,
      types: raw ? undefined : feedTypes,
    };
    const deadline = Date.now() + timeoutMs;
    let events;
    do {
      events = await fleet.events(query, {
        timeoutMs: Math.max(0, deadline - Date.now()),
        signal,
      });
    } while (
      !events.length &&
      !last &&
      Date.now() < deadline &&
      !fleet.closing
    );
    return {
      workspace: record.id,
      cursor: events.at(-1)?.seq ?? after,
      events: events.map(eventView),
    };
  }
  // One agent's journal as readable lines.
  async tail(
    { id, after, limit, last, timeoutMs, full },
    caller,
    { signal } = {},
  ) {
    const { job, fleet, record } = this.hub.find(id);
    const deadline = Date.now() + timeoutMs;
    let cursor = after,
      lines = [];
    for (;;) {
      const events = await fleet.events(
        { after: cursor, jobId: job.id, limit, last, types: tailTypes },
        { timeoutMs: Math.max(0, deadline - Date.now()), signal },
      );
      cursor = events.at(-1)?.seq ?? cursor;
      lines = events
        .map((event) => journalLine(event, { full }))
        .filter(Boolean);
      if (
        lines.length ||
        last ||
        Date.now() >= deadline ||
        fleet.closing ||
        events.length >= limit
      )
        break;
    }
    return {
      id: job.id,
      agentName: job.agentName,
      workspace: record.id,
      status: job.status,
      done: fleet.done(job),
      cursor,
      lines,
    };
  }
  // A note from the caller, journaled in its workspace for its timeline.
  note({ text, workspace }, caller) {
    const record = this.workspaceFor(caller, workspace);
    const event = this.hub.fleets
      .get(record.id)
      .emitEvent(null, "orchestrator.note", {
        by: caller.as,
        owner: caller.as,
        text,
      });
    return {
      noted: event.seq,
      workspace: record.id,
      at: event.at,
      by: caller.as,
    };
  }
  // One orchestrator's timeline (or everyone's) from every workspace's
  // journal, merged by time. The cursor holds each workspace's position.
  async feed(
    { as, all, workspace, after, limit, last, timeoutMs },
    caller,
    { signal } = {},
  ) {
    const who = all ? null : (as ?? caller.as);
    if (!all && !who)
      throw failure(
        400,
        "Name the orchestrator (as), or pass all for everyone's timeline.",
      );
    const records = this.scope(caller, workspace);
    const cursors = parseCursor(after);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const read = records.map((record) => ({
        record,
        events: this.hub.fleets.get(record.id).store.events({
          after: cursors[record.id] ?? 0,
          limit,
          last,
          types: timelineTypes,
          ...(who ? { actor: who, ownedTypes } : {}),
        }),
      }));
      let entries = read
        .flatMap(({ record, events }) =>
          events.map((event) => timelineEntry(event, record.id)),
        )
        .filter(Boolean)
        .sort(byTime);
      const next = Object.fromEntries(
        records.map((r) => [r.id, cursors[r.id] ?? 0]),
      );
      if (last) {
        entries = entries.slice(-last);
        for (const { record, events } of read)
          if (events.length)
            next[record.id] = Math.max(next[record.id], events.at(-1).seq);
      } else {
        // Each workspace's cursor stops at its last entry handed out.
        entries = entries.slice(0, limit);
        for (const entry of entries)
          next[entry.workspace] = Math.max(next[entry.workspace], entry.seq);
      }
      if (entries.length || last || Date.now() >= deadline || this.hub.closing)
        return {
          as: who,
          cursor: formatCursor(next),
          entries,
        };
      await this.timelineNews(deadline - Date.now(), signal);
    }
  }
  // The next journal entry of a timeline type in any workspace.
  timelineNews(timeoutMs, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        this.hub.off("event", listen);
        this.hub.off("closing", wake);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const listen = (_, event) => {
        if (timelineTypes.includes(event.type)) finish();
      };
      const wake = () => finish();
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(), Math.max(0, timeoutMs));
      timer.unref?.();
      this.hub.on("event", listen);
      this.hub.once("closing", wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  // Activity over time, per bucket (src/metrics.js).
  metrics({ workspace, owner, minutes, bucketSeconds }, caller) {
    return metrics({
      records: this.scope(caller, workspace),
      fleets: this.hub.fleets,
      owner: owner ?? null,
      minutes,
      bucketSeconds,
      feedTypes,
      workspace: workspace ?? caller.workspace ?? null,
    });
  }
  async models() {
    if (this.modelCache && Date.now() - this.modelCache.at < 300000)
      return this.modelCache.data;
    const proc = new CodexProcess({ bin: this.hub.config.codexBin });
    try {
      await proc.start();
      let cursor = null;
      const data = [];
      do {
        const page = await proc.request("model/list", { cursor, limit: 100 });
        data.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      this.modelCache = { at: Date.now(), data };
      return data;
    } finally {
      await proc.close();
    }
  }
  account() {
    if (!this.accountAdapter) throw failure(501, "No account adapter.");
    return this.accountAdapter.status();
  }
  usage({ refresh }) {
    if (!this.accountAdapter) throw failure(501, "No account adapter.");
    return this.accountAdapter.usage({ refresh });
  }
  // Workflow runs: the runner does the work.
  startRun(params, caller) {
    return this.runner.start(params, caller);
  }
  listRuns(params, caller) {
    return this.runner.list(params, caller);
  }
  getRun(params) {
    return this.runner.get(params);
  }
  stopRun(params, caller) {
    return this.runner.stop(params, caller);
  }
  resumeRun(params, caller) {
    return this.runner.resume(params, caller);
  }
  waitRun(params, caller, options) {
    return this.runner.wait(params, caller, options);
  }
  shutdown() {
    if (!this.onShutdown)
      throw failure(501, "This Pelican cannot be stopped from here.");
    setTimeout(() => this.onShutdown(), 100).unref();
    return { stopping: true, pid: process.pid };
  }
}
