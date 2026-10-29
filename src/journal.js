// One journal entry as a readable line for tail: assignments, commands,
// edits, messages, questions, reports and finishes. Other entries are null.
const clip = (value, limit = 2000) => {
  const text = String(value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const seconds = (ms) =>
  typeof ms === "number" ? `, ${(ms / 1000).toFixed(1)}s` : "";
const command = (item) =>
  Array.isArray(item.command) ? item.command.join(" ") : item.command;

function text(event) {
  const d = event.data ?? {};
  const item = d.item ?? {};
  switch (event.type) {
    case "job.created":
      return `Assignment from ${d.by ?? d.owner}: ${clip(d.prompt)}`;
    case "job.resumed":
      return `New assignment from ${d.by}: ${clip(d.prompt)}`;
    case "job.retrying":
      return `Pelican resumes it once for a valid result: ${clip(d.prompt, 600)}`;
    case "job.throttled":
      return `The model service is throttling it (HTTP ${d.httpStatus}); Codex retries: ${clip(d.reason, 200)}`;
    case "job.overloaded":
      return `The model service refused the turn (${clip(d.reason, 300)}); Pelican continues it in ${Math.round((d.retryInMs ?? 0) / 1000)} s (try ${d.attempt} of ${d.of})`;
    case "job.restarting":
      return `Codex stopped while starting (${clip(d.reason, 600)}); Pelican starts it once more`;
    case "job.started":
      return `Started (${d.model}, ${d.effort}, network ${d.network ? "on" : "off"})`;
    case "job.finished":
      return `Finished: ${d.status}${d.error ? `. ${clip(d.error, 600)}` : ""}`;
    case "job.cancelled":
      return `Cancelled by ${d.by}: ${clip(d.error, 600)}`;
    case "job.stopRequested":
      return `Stop requested by ${d.by}: ${clip(d.error, 600)}`;
    case "job.recovered":
      return "Interrupted by a Pelican restart";
    case "job.owner":
      return `Owner changed from ${d.from} to ${d.to}`;
    case "agent.question": {
      const q = d.pending?.[0];
      return q ? `Asks ${d.owner} (${q.id}): ${clip(q.question)}` : null;
    }
    case "agent.answered":
      return `Answered by ${d.by}: ${clip(typeof d.answer === "string" ? d.answer : JSON.stringify(d.answer))}`;
    case "agent.message":
      return `Note to ${d.owner}: ${clip(d.message)}`;
    case "agent.report":
      return `Report${d.resultValid === false && d.resultError ? " (result rejected)" : ""}: ${clip(d.report)}`;
    case "message.sent":
      return `Message from ${d.from} (${d.mode}, ${d.delivery}): ${clip(d.text)}`;
    case "questions.expired":
      return `${d.ids?.length ?? 0} open question(s) expired`;
    case "warning":
    case "scheduler.error":
      return `Warning: ${clip(d.message, 600)}`;
    case "item/started":
      return item.type === "commandExecution"
        ? `$ ${clip(command(item), 600)}`
        : null;
    case "item/completed":
      if (item.type === "commandExecution")
        return `  exit ${item.exitCode ?? "?"}${seconds(item.durationMs)}${item.status && item.status !== "completed" ? ` (${item.status})` : ""}`;
      if (item.type === "fileChange")
        return `Edited ${(item.changes ?? []).map((c) => c.path).join(", ") || "files"}`;
      if (item.type === "agentMessage")
        return `${item.phase && item.phase !== "final_answer" ? "Agent (progress)" : "Agent"}: ${clip(item.text)}`;
      return null;
    default:
      return null;
  }
}

// With full (the menu's agent chat), a line also says what it is (kind) and
// who it is from or to, and carries the whole text, a command's output or an
// edit's diff as detail; the agent's reasoning summaries become lines too.
const tailOf = (value, limit = 12000) => {
  const text = String(value ?? "");
  return text.length > limit ? `…${text.slice(-limit)}` : text;
};
const changeKind = (c) =>
  typeof c.kind === "string" ? c.kind : (c.kind?.type ?? "change");
function chat(event) {
  const d = event.data ?? {};
  const item = d.item ?? {};
  switch (event.type) {
    case "job.created":
      return { kind: "brief", from: d.by ?? d.owner, detail: d.prompt };
    case "job.resumed":
      return { kind: "brief", from: d.by, detail: d.prompt };
    case "job.retrying":
      return { kind: "brief", from: "pelican", detail: d.prompt };
    case "message.sent":
      return { kind: "message", from: d.from, mode: d.mode, detail: d.text };
    case "agent.question":
      return {
        kind: "question",
        to: d.owner,
        detail: d.pending?.[0]?.question,
      };
    case "agent.answered":
      return {
        kind: "answer",
        from: d.by,
        detail:
          typeof d.answer === "string"
            ? d.answer
            : JSON.stringify(d.answer, null, 2),
      };
    case "agent.message":
      return { kind: "note", to: d.owner, detail: d.message };
    case "agent.report":
      return { kind: "report", to: d.owner, detail: d.report };
    case "item/started":
      return { kind: "command", item: item.id, command: command(item) };
    case "item/completed":
      if (item.type === "commandExecution")
        return {
          kind: "command",
          item: item.id,
          command: command(item),
          exitCode: item.exitCode ?? null,
          durationMs: item.durationMs ?? null,
          status: item.status ?? null,
          detail: tailOf(item.aggregatedOutput),
        };
      if (item.type === "fileChange")
        return {
          kind: "edit",
          item: item.id,
          detail: tailOf(
            (item.changes ?? [])
              .map(
                (c) =>
                  `${changeKind(c)} ${c.path}${c.diff ? `\n${c.diff}` : ""}`,
              )
              .join("\n"),
          ),
        };
      if (item.type === "agentMessage")
        return { kind: "agent", phase: item.phase ?? null, detail: item.text };
      return { kind: "status" };
    default:
      return { kind: "status" };
  }
}
function reasoning(event) {
  const item = event.data?.item;
  if (event.type !== "item/completed" || item?.type !== "reasoning")
    return null;
  const summary = (item.summary ?? []).join("\n").trim();
  if (!summary) return null;
  return {
    seq: event.seq,
    at: event.at,
    type: event.type,
    text: `Thinking: ${clip(summary, 600)}`,
    kind: "reasoning",
    detail: summary,
  };
}

export function journalLine(event, { full = false } = {}) {
  const line = text(event);
  if (line === null) return full ? reasoning(event) : null;
  const base = { seq: event.seq, at: event.at, type: event.type, text: line };
  return full ? { ...base, ...chat(event) } : base;
}
