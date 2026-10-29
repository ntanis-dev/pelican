import { maxWaitMs } from "./api.js";

// The gateway's calls as methods, the same whether they run in the service
// (gateway.as) or over HTTP (client.connect):
//   const agent = await pelican.spawn({ name, prompt, resultSchema });
//   const { reason, agents } = await pelican.wait([agent.id]);
// call(method, params) does the work. wait keeps waiting past one call's
// limit until timeoutMs (default: no limit) and returns early when an agent
// asks a question.
export function facade(call, context = {}) {
  return {
    context,
    call,
    status: () => call("status"),
    workspaces: () => call("workspaces"),
    addWorkspace: (folder, options = {}) =>
      call("workspace.add", { folder, ...options }),
    removeWorkspace: (workspace) => call("workspace.remove", { workspace }),
    settings: (params = {}) => call("settings", params),
    spawn: (brief) => call("spawn", brief),
    batch: (jobs, options = {}) =>
      call("batch", Array.isArray(jobs) ? { jobs, ...options } : jobs),
    get: (id) => call("get", { id }),
    list: (params = {}) => call("list", params),
    async wait(ids, { any = false, timeoutMs = Infinity } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const slice = Math.min(maxWaitMs, Math.max(0, deadline - Date.now()));
        const outcome = await call("wait", {
          ids: [ids].flat(),
          any,
          timeoutMs: Math.floor(slice),
        });
        if (outcome.reason !== "timeout" || Date.now() >= deadline)
          return outcome;
      }
    },
    message: (id, text, options = {}) =>
      call("message", { id, text, ...options }),
    resume: (id, options = {}) => call("resume", { id, ...options }),
    answer: (id, requestId, answer, options = {}) =>
      call("answer", { id, requestId, answer, ...options }),
    questions: (params = {}) => call("questions", params),
    stop: (id, options = {}) =>
      call("stop", typeof id === "object" && id ? id : { id, ...options }),
    events: (params = {}) => call("events", params),
    tail: (id, params = {}) => call("tail", { id, ...params }),
    // Orchestrator timelines: note(text) journals one of yours; feed() reads
    // yours, feed({ as }) another's, feed({ all: true }) everyone's.
    note: (text, options = {}) => call("note", { text, ...options }),
    feed: (params = {}) => call("feed", params),
    // Activity over time: { workspace, owner, minutes, bucketSeconds }.
    metrics: (params = {}) => call("metrics", params),
    models: () => call("models"),
    account: () => call("account"),
    // The account's usage limits, as last read (every 30 minutes);
    // usage({ refresh: true }) reads them now.
    usage: (params = {}) => call("usage", params),
    shutdown: () => call("shutdown"),
    // Workflow runs. startRun takes { file | source, args, workspace, name, cwd }.
    startRun: (params) => call("runs.start", params),
    runs: (params = {}) => call("runs.list", params),
    getRun: (id) => call("runs.get", { id }),
    stopRun: (id, options = {}) => call("runs.stop", { id, ...options }),
    resumeRun: (id, options = {}) => call("runs.resume", { id, ...options }),
    // Until the run ends or an agent of it asks a question (with after: the
    // next change), past one call's limit until timeoutMs.
    async waitRun(id, { timeoutMs = Infinity, after } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const slice = Math.min(maxWaitMs, Math.max(0, deadline - Date.now()));
        const outcome = await call("runs.wait", {
          id,
          timeoutMs: Math.floor(slice),
          ...(after === undefined ? {} : { after }),
        });
        if (outcome.reason !== "timeout" || Date.now() >= deadline)
          return outcome;
      }
    },
  };
}
