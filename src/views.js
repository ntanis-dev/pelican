// The JSON shapes the gateway returns. The CLI (--json), the HTTP RPC and the
// MCP server all hand these out unchanged.
export const liveStates = new Set([
  "queued",
  "starting",
  "running",
  "waiting",
  "stopping",
]);
const clip = (value, limit) => {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const kinds = {
  "item/tool/call": "question",
  "item/tool/requestUserInput": "question",
  "item/commandExecution/requestApproval": "approval",
  "item/fileChange/requestApproval": "approval",
  "item/permissions/requestApproval": "permissions",
};

export function questionView(job, q, workspace) {
  return {
    jobId: job.id,
    requestId: q.id,
    agentName: job.agentName,
    name: job.name,
    owner: job.owner,
    ...(workspace ? { workspace } : {}),
    kind: kinds[q.method] ?? "question",
    question: q.question,
    ...(Array.isArray(q.params?.availableDecisions)
      ? { decisions: q.params.availableDecisions }
      : q.method === "item/permissions/requestApproval"
        ? { decisions: ["accept", "decline"] }
        : {}),
    createdAt: q.createdAt,
    sequence: q.sequence,
  };
}

const latest = (job) =>
  job.pending[0]?.question ||
  job.error ||
  job.currentActivity ||
  job.progress ||
  job.summary ||
  "";

export function jobRow(job, workspace) {
  return {
    id: job.id,
    agentName: job.agentName,
    name: job.name,
    owner: job.owner,
    workspace,
    status: job.status,
    model: job.model,
    effort: job.effort,
    tokens: job.usage?.total?.totalTokens ?? 0,
    questions: job.pending.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    latest: clip(latest(job), 300),
  };
}

// What an orchestrator reads about one agent.
export function jobDetail(job, workspace, { done } = {}) {
  return {
    ...jobRow(job, workspace),
    done: Boolean(done),
    cwd: job.cwd,
    resources: job.resources,
    dependsOn: job.dependsOn,
    priority: job.priority,
    network: job.network,
    attempts: job.attempts,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    prompt: job.prompt,
    setup: job.setup ?? null,
    activity: {
      current: job.currentActivity,
      progress: job.progress,
      plan: job.plan,
      updatedAt: job.updatedAt,
    },
    questions: job.pending.map((q) => questionView(job, q)),
    notes: job.notes.slice(-10),
    messages: job.messages.slice(-20).map((m) => ({
      id: m.id,
      from: m.from,
      mode: m.mode,
      text: clip(m.text, 2000),
      createdAt: m.createdAt,
      delivered: Boolean(m.deliveredAt),
      read: Boolean(m.readAt),
    })),
    usage: job.usage?.total ?? null,
    hasResultSchema: Boolean(job.resultSchema),
    resultValid: job.resultSchema ? job.resultValid : null,
    resultError: job.resultError,
    result: job.result,
    report: job.report,
    summary: job.summary,
    error: job.error,
  };
}

// What wait returns for each agent: its final state and what it handed back.
export function resultView(job, workspace, { done } = {}) {
  return {
    id: job.id,
    agentName: job.agentName,
    name: job.name,
    owner: job.owner,
    workspace,
    status: job.status,
    done: Boolean(done),
    result: job.result,
    report: job.report,
    summary: job.summary,
    error: job.error,
    questions: job.pending.map((q) => questionView(job, q)),
  };
}

export function eventView(event) {
  return {
    seq: event.seq,
    at: event.at,
    jobId: event.jobId,
    type: event.type,
    data: event.data,
  };
}
