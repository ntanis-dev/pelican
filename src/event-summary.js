const clip = (text, limit) => {
  const value = String(text ?? "");
  return value.length > limit ? value.slice(0, limit) : value;
};

export function questionSummary(q) {
  return {
    id: q.id,
    method: q.method,
    owner: q.owner,
    createdAt: q.createdAt,
    sequence: q.sequence,
    question: clip(q.question, 2000),
    truncated: q.question.length > 2000,
  };
}

// The journal's record of an agent's state change. Full prompts, reports and
// results stay on the agent (get).
export function jobEvent(job, type) {
  const data = {
    id: job.id,
    agentName: job.agentName,
    name: job.name,
    owner: job.owner,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
    pendingCount: job.pending.length,
    workingWithQuestion: Boolean(job.workingWithQuestion),
  };
  if (type === "agent.question")
    data.pending = [questionSummary(job.pending.at(-1))];
  if (type === "job.setup") data.setup = job.setup;
  if (type === "job.started") {
    data.model = job.model;
    data.effort = job.effort;
    data.network = job.network;
  }
  if (type === "agent.report") {
    data.report = clip(job.report, 4000);
    data.resultValid = job.resultValid;
    data.resultError = job.resultError;
  }
  if (
    [
      "job.finished",
      "job.recovered",
      "job.cancelled",
      "job.stopRequested",
      "job.retrying",
    ].includes(type)
  ) {
    data.error = job.error;
    data.summary = clip(job.summary, 2000);
    if (job.resultSchema) data.resultValid = job.resultValid;
  }
  return data;
}
