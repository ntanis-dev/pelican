// An orchestrator's timeline (the feed method): its notes, what it did, and
// what its agents sent it, from every workspace's journal, oldest first.
// Entries are { workspace, seq, at, type, kind, by, jobId, agentName, runId,
// title, body, text, data }: kind is note (the orchestrator's own words),
// action (something it did), run (its workflow run at work) or agent (an
// agent's question, note, report or finish, addressed to it); by is the
// orchestrator; text is title and body on one line.
const clip = (value, limit = 4000) => {
  const text = String(value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const firstLines = (text, lines = 3, limit = 600) =>
  clip(
    String(text ?? "")
      .trim()
      .split(/\r?\n/)
      .slice(0, lines)
      .join("\n"),
    limit,
  );
const answerText = (answer) =>
  typeof answer === "string"
    ? answer
    : JSON.stringify(answer?.decision ?? answer);

// Its own entries carry its name as by, from or to.
export const actionTypes = [
  "orchestrator.note",
  "job.created",
  "message.sent",
  "job.resumed",
  "agent.answered",
  "job.stopRequested",
  "job.cancelled",
  "job.owner",
  "settings.updated",
  "run.started",
  "run.resumed",
  "run.stopped",
  "run.finished",
  "run.agent",
  "run.note",
];
// Its agents' entries carry it as owner.
export const ownedTypes = [
  "agent.question",
  "agent.message",
  "agent.report",
  "job.finished",
  "job.restarting",
  "job.overloaded",
  "job.throttled",
  "job.recovered",
];
export const timelineTypes = [...actionTypes, ...ownedTypes];

const kinds = {
  "orchestrator.note": "note",
  "run.agent": "run",
  "run.note": "run",
  "run.finished": "run",
};

// [title, body] of one entry, or null for an entry that is not on timelines.
function words(event, workspace) {
  const d = event.data ?? {};
  const agent =
    d.agentName ?? (event.jobId ? String(event.jobId).slice(0, 8) : "an agent");
  const run = d.name ? `the run ${d.name}` : "a run";
  switch (event.type) {
    case "orchestrator.note":
      return ["note", clip(d.text, 20000)];
    case "job.created":
      return [
        `spawned ${agent}${d.name ? ` (${clip(d.name, 140)})` : ""}`,
        firstLines(d.prompt),
      ];
    case "message.sent":
      return [
        `messaged ${agent} (${d.mode}${d.delivery ? `, ${d.delivery}` : ""})`,
        clip(d.text),
      ];
    case "job.resumed":
      return [`resumed ${agent}`, clip(d.prompt)];
    case "agent.answered":
      return [
        `answered ${agent}${d.question ? ` (${firstLines(d.question, 1, 200)})` : ""}`,
        clip(answerText(d.answer)),
      ];
    case "job.stopRequested":
      return [`stopped ${agent}`, clip(d.error, 600)];
    case "job.cancelled":
      return [`cancelled ${agent} before it started`, clip(d.error, 600)];
    case "job.owner":
      return [`${d.to} took over ${agent} from ${d.from}`, ""];
    case "settings.updated":
      return [
        `changed the settings of ${workspace}`,
        Object.entries(d.changes ?? {})
          .map(([k, v]) => `${k} ${v}`)
          .join(", "),
      ];
    case "run.started":
      return [`started ${run}`, d.file ?? ""];
    case "run.resumed":
      return [`resumed ${run}`, ""];
    case "run.stopped":
      return [`stopped ${run}`, clip(d.reason, 600)];
    case "run.finished":
      return [`${run} ${d.status}`, clip(d.error, 600)];
    case "run.agent":
      return [
        `${run} ${d.continued ? "continued" : "started"} ${d.agentName ?? String(d.jobId ?? "").slice(0, 8)}${d.label ? ` (${d.label})` : ""}`,
        "",
      ];
    case "run.note":
      return [run, clip(d.text, 2000)];
    case "agent.question":
      return [`${agent} asks`, clip(d.pending?.[0]?.question)];
    case "agent.message":
      return [agent, clip(d.message)];
    case "agent.report":
      return [
        `${agent} reported${d.resultValid === false && d.resultError ? " (result rejected)" : ""}`,
        clip(d.report),
      ];
    case "job.finished":
      return [`${agent} ${d.status}`, clip(d.error, 600)];
    case "job.restarting":
      return [
        `${agent} crashed while starting; Pelican starts it once more`,
        clip(d.reason, 600),
      ];
    case "job.overloaded":
      return [
        `${agent} stopped by the model service; Pelican continues it in ${Math.round((d.retryInMs ?? 0) / 1000)} s (try ${d.attempt} of ${d.of})`,
        clip(d.reason, 300),
      ];
    case "job.throttled":
      return [
        `${agent} is throttled by the model service (HTTP ${d.httpStatus}); Codex retries`,
        clip(d.reason, 200),
      ];
    case "job.recovered":
      return [
        `${agent} was interrupted by a Pelican restart`,
        "resume it to continue",
      ];
    default:
      return null;
  }
}

export function timelineEntry(event, workspace) {
  const said = words(event, workspace);
  if (!said) return null;
  const [title, body] = said;
  const d = event.data ?? {};
  const owned = ownedTypes.includes(event.type);
  const by = owned
    ? (d.owner ?? null)
    : event.type === "job.owner"
      ? d.to
      : (d.by ?? d.from ?? d.owner ?? null);
  return {
    workspace,
    seq: event.seq,
    at: event.at,
    type: event.type,
    kind: kinds[event.type] ?? (owned ? "agent" : "action"),
    by,
    jobId: event.jobId ?? d.jobId ?? null,
    agentName: d.agentName ?? null,
    runId: d.runId ?? null,
    title,
    body,
    text:
      event.type === "orchestrator.note"
        ? body
        : body
          ? `${title}: ${body}`
          : title,
    data: d,
  };
}

// The cursor is each workspace's last journal position: "id:seq,id:seq".
export function parseCursor(cursor) {
  const out = {};
  for (const part of String(cursor ?? "").split(",")) {
    const at = part.lastIndexOf(":");
    if (at <= 0) continue;
    const seq = Number(part.slice(at + 1));
    if (Number.isInteger(seq) && seq >= 0) out[part.slice(0, at)] = seq;
  }
  return out;
}
export const formatCursor = (cursors) =>
  Object.entries(cursors)
    .map(([id, seq]) => `${id}:${seq}`)
    .join(",");

export const byTime = (a, b) =>
  String(a.at).localeCompare(String(b.at)) ||
  a.workspace.localeCompare(b.workspace) ||
  a.seq - b.seq;
