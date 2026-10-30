import { oneLine, short } from "./text.js";
import {
  agentById,
  liveStatuses,
  finishedRun,
  orchestratorByName,
  toast,
} from "./state.js";
import { call, notice, refresh, result } from "./views/common.js";
import { startForm } from "./views/settings.js";

// What a person can do from the menu. Each opens a confirmation or an
// input; its effect is the gateway call the CLI would make, under the
// menu's caller name. Directing an agent another orchestrator owns asks
// for a takeover first (see the reducer). The same key does the same thing
// in the sidebar and the right pane: a answer, m message, x stop, u resume,
// e settings, S stop everyone.
const named = (agent) => agent.agentName ?? short(agent.id);
const why = (state) => `Stopped from the Pelican menu by ${state.as}`;

export function stopAgent(state, agent) {
  if (!agent) return null;
  return result({
    ...state,
    modal: {
      kind: "confirm",
      title: `Stop ${named(agent)}?`,
      lines: [
        oneLine(agent.name),
        `Status ${agent.status}, owner ${agent.owner}. Its changes stay in the workspace.`,
      ],
      effect: call(
        "stop",
        { id: agent.id, reason: why(state) },
        `Asked ${named(agent)} to stop.`,
      ),
    },
  });
}

export function messageAgent(state, agent) {
  if (!agent) return null;
  return result({
    ...state,
    modal: {
      kind: "input",
      title: `Message ${named(agent)}`,
      lines: [
        "steer reaches its running turn now; followup becomes its next assignment when the turn ends. A finished agent takes the message as a new assignment.",
      ],
      value: "",
      cursor: 0,
      modes: ["steer", "followup"],
      mode: "steer",
      submit: {
        type: "call",
        method: "message",
        params: { id: agent.id },
        field: "text",
        modeField: "mode",
        done: `Message sent to ${named(agent)}.`,
      },
    },
  });
}

export function resumeAgent(state, agent) {
  if (!agent) return null;
  return result({
    ...state,
    modal: {
      kind: "input",
      title: `Resume ${named(agent)}`,
      lines: [
        "Its next assignment in the same conversation: corrections, review findings or a follow-up.",
      ],
      value: "",
      cursor: 0,
      submit: {
        type: "call",
        method: "resume",
        params: { id: agent.id },
        field: "prompt",
        done: `Resumed ${named(agent)}.`,
      },
    },
  });
}

// Every running and queued agent of one orchestrator, after typing yes.
export function stopOrchestrator(state, name, live) {
  return result({
    ...state,
    modal: {
      kind: "typed",
      word: "yes",
      value: "",
      cursor: 0,
      title: `Stop every agent of ${name}?`,
      lines: [
        `This stops ${live} live agent${live === 1 ? "" : "s"} of ${name}, in every workspace. Their changes stay.`,
      ],
      effect: call(
        "stop",
        { all: true, owner: name, reason: why(state) },
        `Stopped the agents of ${name}.`,
      ),
    },
  });
}

// Everyone's agents, after typing yes.
export function stopEveryone(state) {
  const totals = state.data.status?.totals ?? { working: 0, queued: 0 };
  return result({
    ...state,
    palette: null,
    modal: {
      kind: "typed",
      word: "yes",
      value: "",
      cursor: 0,
      title: "Stop every agent?",
      lines: [
        `This interrupts ${totals.working} working and cancels ${totals.queued} queued agent${totals.queued === 1 ? "" : "s"} of every orchestrator. Their changes stay in the workspaces.`,
      ],
      effect: call(
        "stop",
        {
          all: true,
          reason: `Everyone stopped from the Pelican menu by ${state.as}`,
        },
        "Stopped every agent.",
      ),
    },
  });
}

// The workflow runner's calls (src/runner.js).
export const runMethods = {
  list: "runs.list",
  get: "runs.get",
  stop: "runs.stop",
  resume: "runs.resume",
};
const runName = (run) => run.name ?? short(run.id);
export function stopRun(state, run) {
  if (!run) return null;
  return result({
    ...state,
    modal: {
      kind: "confirm",
      title: `Stop the run ${runName(run)}?`,
      lines: [
        "Its running agents are stopped; their changes stay in the workspace. Resume it from its Actions menu.",
      ],
      effect: call(
        runMethods.stop,
        { id: run.id, reason: why(state) },
        `Asked the run ${runName(run)} to stop.`,
      ),
    },
  });
}
export const resumeRun = (state, run) =>
  run
    ? result(state, [
        call(
          runMethods.resume,
          { id: run.id },
          `Resumed the run ${runName(run)}.`,
        ),
      ])
    : null;

// Approvals offer decisions; a decision that is an object (a policy
// amendment) is answered as { decision }.
const simpleDecisions = ["accept", "acceptForSession", "decline", "cancel"];
export const decisionLabel = (d) =>
  typeof d === "string"
    ? d
    : `${Object.keys(d ?? {})[0] ?? "decision"} ${JSON.stringify(Object.values(d ?? {})[0] ?? "")}`;
export const decisionAnswer = (d) =>
  typeof d === "string" ? d : { decision: d };
export function decisionsOf(q) {
  if (Array.isArray(q.decisions) && q.decisions.length) return q.decisions;
  if (q.kind === "approval") return simpleDecisions;
  if (q.kind === "permissions") return ["accept", "decline"];
  return null;
}

export function answerQuestion(state, q, { position } = {}) {
  if (!q) return null;
  const title = `${q.agentName ?? short(q.jobId)} asks ${q.owner}${position ? ` (${position})` : ""}`;
  const lines = [String(q.question ?? "")];
  const submit = {
    type: "call",
    method: "answer",
    params: { id: q.jobId, requestId: q.requestId },
    field: "answer",
    done: `Answered ${q.agentName ?? short(q.jobId)}.`,
  };
  const decisions = decisionsOf(q);
  if (decisions)
    return result({
      ...state,
      modal: {
        kind: "choice",
        title,
        lines,
        options: decisions.map((d) => ({
          label: decisionLabel(d),
          value: decisionAnswer(d),
        })),
        index: 0,
        submit,
      },
    });
  return result({
    ...state,
    modal: { kind: "input", title, lines, value: "", cursor: 0, submit },
  });
}
const answerFirst = (state, list) =>
  answerQuestion(
    state,
    list[0],
    list.length > 1 ? { position: `1 of ${list.length}` } : {},
  );

// The settings form of a workspace, in its pane.
export const editSettings = (state, workspace) =>
  workspace
    ? result({ ...state, form: startForm(workspace), focus: "pane" })
    : null;

// An agent as the actions need it: its row in the list, else what its pane
// read, else what a question knows of it.
function agentOf(state, id, fallback = {}) {
  return (
    agentById(state, id) ??
    state.cache[`agent:${id}`]?.detail ?? {
      id,
      agentName: fallback.agentName ?? short(id),
      name: fallback.name ?? "",
      status: "unknown",
      owner: fallback.owner ?? "?",
    }
  );
}

// The actions that apply to the selection, as [key, label, run(state)].
export function itemActions(state, item) {
  const out = [];
  const add = (key, label, run) => out.push({ key, label, run });
  const questionsOf = (id) =>
    (state.data.questions ?? []).filter((q) => q.jobId === id);
  switch (item.kind) {
    case "question": {
      const q = item.question;
      if (!q) break;
      const agent = agentOf(state, q.jobId, q);
      add("a", "answer", (s) => answerQuestion(s, q));
      add("m", "message", (s) => messageAgent(s, agent));
      add("x", "stop", (s) => stopAgent(s, agent));
      break;
    }
    case "agent": {
      const agent = agentOf(state, item.agentId);
      const asks = questionsOf(item.agentId);
      if (asks.length) add("a", "answer", (s) => answerFirst(s, asks));
      add("m", "message", (s) => messageAgent(s, agent));
      if (liveStatuses.has(agent.status) || agent.status === "unknown")
        add("x", "stop", (s) => stopAgent(s, agent));
      else add("u", "resume", (s) => resumeAgent(s, agent));
      break;
    }
    case "orchestrator": {
      const r = orchestratorByName(state, item.name);
      if (!r) break;
      if (r.questions.length)
        add("a", "answer", (s) => answerFirst(s, r.questions));
      if (r.live.length)
        add("x", "stop its agents", (s) =>
          stopOrchestrator(s, r.name, r.live.length),
        );
      break;
    }
    case "run": {
      const run = state.cache[item.key]?.detail ?? item.row;
      if (!run) break;
      const asks = Array.isArray(run.questions) ? run.questions : [];
      if (asks.length) add("a", "answer", (s) => answerFirst(s, asks));
      if (finishedRun.has(run.status))
        add("u", "resume", (s) => resumeRun(s, run));
      else add("x", "stop run", (s) => stopRun(s, run));
      break;
    }
    case "workspace":
      if (item.workspace && state.form?.workspace !== item.workspaceId)
        add("e", "settings", (s) => editSettings(s, item.workspace));
      break;
    default:
      break;
  }
  return out;
}

// A key of a, m, x, u, e: its action on the selection, or a word on why
// there is nothing to do.
const nothing = {
  a: "No open question here.",
  m: "Select an agent (or its question) to message it.",
  x: "Nothing to stop here: select an agent, a run or an orchestrator.",
  u: "Nothing to resume here: select a finished agent or run.",
  e: "Select a workspace to edit its settings.",
};
export function act(state, item, key) {
  const action = itemActions(state, item).find((a) => a.key === key);
  if (action) return action.run(state);
  return notice(state, nothing[key]);
}

export function addWorkspace(state) {
  return result({
    ...state,
    modal: {
      kind: "input",
      title: "Add a workspace",
      lines: [
        "The absolute path to an existing folder. Pelican keeps your files in place.",
      ],
      value: "",
      cursor: 0,
      submit: {
        type: "call",
        method: "workspace.add",
        params: {},
        field: "folder",
        done: "Added the workspace.",
      },
    },
  });
}

export function menuActions(state, item) {
  if (item.kind === "empty") return [];
  return [
    ...itemActions(state, item),
    ...(["agent", "orchestrator", "run", "events"].includes(item.kind)
      ? [
          {
            key: "i",
            label: "Inspect output",
            run: (s) => result({ ...s, focus: "pane" }),
          },
        ]
      : []),
    { key: "r", label: "Refresh", run: refreshNow },
    ...(item.kind === "overview"
      ? [
          { key: "+", label: "Add workspace", run: addWorkspace },
          { key: "S", label: "Stop every agent", run: stopEveryone },
        ]
      : []),
  ];
}

export function openActions(state, item) {
  const options = menuActions(state, item).map(({ key, label }) => ({
    key,
    label: label[0].toUpperCase() + label.slice(1),
  }));
  return options.length
    ? result({
        ...state,
        modal: {
          kind: "actions",
          title: "Actions",
          lines: [],
          item,
          index: 0,
          options,
        },
      })
    : result(state);
}

export function runAction(state, key) {
  const item = state.modal.item;
  const next = { ...state, modal: null };
  return (
    menuActions(next, item)
      .find((action) => action.key === key)
      ?.run(next) ?? result(next)
  );
}

export const refreshNow = (state) =>
  result(
    toast(
      {
        ...state,
        data: { ...state.data, account: null, accountError: null },
        metrics: { ...state.metrics, at: null },
      },
      "Refreshing.",
    ),
    [refresh],
  );
