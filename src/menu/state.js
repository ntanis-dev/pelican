// The menu's state and what the sidebar and the panes read from it.
// Everything here is pure: the reducer changes state, the components draw
// it.
export const feedLimit = 500;
export const tailLimit = 2000;
export const timelineLimit = 1000;
// How often the graphs are read again, and the window they show.
export const metricsEveryMs = 5000;
export const metricsParams = { minutes: 60, bucketSeconds: 60 };
// How often the menu asks for the Codex usage limits. The service reads them
// every 30 minutes and answers from that reading, so this is cheap.
export const usageEveryMs = 60000;
// Pelican's own name: never an orchestrator.
export const pelicanName = "pelican";
export const liveStatuses = new Set([
  "queued",
  "starting",
  "running",
  "waiting",
  "stopping",
]);
export const activeStatuses = new Set([
  "starting",
  "running",
  "waiting",
  "stopping",
]);
export const finishedRun = new Set([
  "completed",
  "failed",
  "cancelled",
  "stopped",
  "interrupted",
  "done",
]);
// Finished runs shown before the rest fold into "+ n earlier".
export const latestFew = 3;
// An orchestrator's agents are counted, not listed, in the sidebar: one row
// per group that has agents, in this order. Selecting a group lists its
// agents in the right pane.
export const agentGroups = [
  "asking",
  "working",
  "queued",
  "stopping",
  "done",
  "failed",
  "stopped",
];
export function agentGroup(a) {
  if (a.questions || a.status === "waiting") return "asking";
  switch (a.status) {
    case "running":
    case "starting":
      return "working";
    case "queued":
    case "stopping":
      return a.status;
    case "completed":
    case "replayed":
    case "done":
      return "done";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return "stopped";
  }
}
// The sidebar id of a group, and back: "group:lead/done".
export const groupId = (owner, group) => `group:${owner}/${group}`;
export function parseGroup(id) {
  const at = id.lastIndexOf("/");
  return { owner: id.slice(6, at), group: id.slice(at + 1) };
}
// Panes whose data (an agent's conversation, a timeline, a run) is kept
// while the selection moves elsewhere, the most recent first.
export const cacheSize = 8;

export function initialState({
  as = "menu",
  url = null,
  size = { cols: 100, rows: 30 },
  now = 0,
  color = true,
  glyphs = "rich",
  splash = false,
} = {}) {
  return {
    as,
    url,
    now,
    size,
    color,
    glyphs,
    splash,
    // Which pane has the keys: the sidebar ("side") or the right pane.
    focus: "side",
    // The selected sidebar item and its place (for when it goes away).
    selected: "pelican",
    index: 0,
    // Set once the person moves: the first open question no longer takes
    // the selection when it arrives. picked: the questions were read once.
    moved: false,
    picked: false,
    // Orchestrators the person opened or closed (name -> true | false), and
    // whether the finished runs are all shown ("runs").
    open: {},
    more: {},
    // The agent highlighted in each list that has them: a group's, a
    // workflow run's (sidebar id -> agent id).
    pick: {},
    // Where Back goes from an agent opened out of a workflow run
    // ({ agent, to }); from a group it goes to the group.
    from: null,
    // The sidebar's filter, and whether it is being typed.
    filter: "",
    filtering: false,
    // Per pane: the agent's sub-view, the scroll position, the expanded
    // commands and edits, and what was read for it.
    tabs: {},
    views: {},
    expanded: {},
    cache: {},
    recent: [],
    // A workspace's settings form, while it is open.
    form: null,
    modal: null,
    palette: null,
    toasts: [],
    toastSeq: 0,
    service: { state: "unknown", message: null },
    data: {
      status: null,
      account: null,
      accountError: null,
      // Every agent (list), for the sidebar.
      fleet: null,
      questions: null,
      runs: { list: [], error: null },
    },
    metrics: { data: null, at: null, error: null },
    // The account's Codex usage limits, as the service last read them.
    usage: { data: null, at: null, error: null },
    // Every workspace's feed, for the Events pane.
    feed: { cursors: {}, events: [] },
    // Every orchestrator's timeline (feed all): who orchestrates.
    timeline: { cursor: null, entries: [] },
  };
}

export const workspaceRows = (state) => state.data.status?.workspaces ?? [];
export const fleetRows = (state) => state.data.fleet ?? [];
export const agentById = (state, id) =>
  fleetRows(state).find((a) => a.id === id) ?? null;

// Open questions: those waiting for the menu's own name first, then the
// others by owner; oldest first within each.
export function questionRows(state) {
  const rows = (state.data.questions ?? []).map((q) => ({
    ...q,
    id: `q:${q.jobId}/${q.requestId}`,
  }));
  const rank = (q) => (q.owner === state.as ? 0 : 1);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      String(a.owner).localeCompare(String(b.owner)) ||
      String(a.createdAt).localeCompare(String(b.createdAt)),
  );
}

// Workflow runs: those still running first, then the finished ones, the
// newest first within each.
export function runRows(state) {
  const list = state.data.runs.list ?? [];
  const newest = (a, b) =>
    String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? ""));
  return [
    ...list.filter((r) => !finishedRun.has(r.status)).sort(newest),
    ...list.filter((r) => finishedRun.has(r.status)).sort(newest),
  ];
}

// Every orchestrator that has used this Pelican: the owners of its agents,
// the names narrating or coordinating in the timeline and those its
// questions wait for. Changing settings alone does not make a caller an
// orchestrator. Each with its agents (live ones in the order they came,
// finished ones newest first),
// its open questions, tokens, and its last note and action. Those with live
// agents or questions first, then the others; by name within each.
export function orchestrators(state) {
  const rows = new Map();
  const row = (name) => {
    if (!name || name === pelicanName) return null;
    if (!rows.has(name))
      rows.set(name, {
        name,
        live: [],
        finished: [],
        agents: 0,
        tokens: 0,
        questions: [],
        lastNote: null,
        lastAction: null,
        lastHeard: null,
        lastAt: null,
      });
    return rows.get(name);
  };
  for (const a of fleetRows(state)) {
    const r = row(a.owner);
    if (!r) continue;
    r.agents++;
    r.tokens += a.tokens ?? 0;
    (liveStatuses.has(a.status) ? r.live : r.finished).push(a);
  }
  for (const q of questionRows(state)) row(q.owner)?.questions.push(q);
  for (const e of state.timeline.entries)
    if (e.type !== "settings.updated") row(e.by);
  // Oldest first, so the last one seen is the newest.
  // Keep settings in an orchestrator's activity, even before its first note.
  for (const e of state.timeline.entries) {
    const r = rows.get(e.by);
    if (!r) continue;
    if (e.kind === "note") r.lastNote = e;
    else if (e.kind === "agent") r.lastHeard = e;
    else r.lastAction = e;
    if (e.kind !== "agent") r.lastAt = e.at;
  }
  const created = (a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt));
  for (const r of rows.values()) {
    r.live.sort(created);
    r.finished.sort(
      (a, b) =>
        String(b.finishedAt ?? b.updatedAt).localeCompare(
          String(a.finishedAt ?? a.updatedAt),
        ) || created(b, a),
    );
  }
  const busy = (r) => (r.live.length || r.questions.length ? 0 : 1);
  return [...rows.values()].sort(
    (a, b) => busy(a) - busy(b) || a.name.localeCompare(b.name),
  );
}
export const orchestratorByName = (state, name) =>
  orchestrators(state).find((r) => r.name === name) ?? null;

// The agents of one group of an orchestrator: live ones in the order they
// came, finished ones newest first. And the one highlighted in its list
// (the first until the person picks).
export const groupAgents = (r, group) =>
  r ? [...r.live, ...r.finished].filter((a) => agentGroup(a) === group) : [];
export const pickedAgent = (state, key, list) =>
  list.find((a) => a.id === state.pick[key]) ?? list[0] ?? null;

// What was read for a pane, kept for the few most recent ones. touch()
// makes a pane the most recent (creating its entry), dropping the least
// recent beyond the limit; put() changes one that is kept.
export function touch(state, key, init) {
  const recent = [key, ...state.recent.filter((k) => k !== key)];
  let cache = state.cache[key]
    ? state.cache
    : { ...state.cache, [key]: init() };
  if (recent.length > cacheSize) {
    cache = { ...cache };
    for (const k of recent.slice(cacheSize)) delete cache[k];
  }
  if (cache === state.cache && recent[0] === state.recent[0]) return state;
  return { ...state, cache, recent: recent.slice(0, cacheSize) };
}
export const put = (state, key, value) =>
  state.cache[key]
    ? { ...state, cache: { ...state.cache, [key]: value } }
    : state;

// A short notice in the corner (toasts): ok, error or info. Errors stay
// longer.
export const toastTtl = { error: 10000, ok: 5000, info: 4000 };
export function toast(state, text, tone = "info") {
  const id = state.toastSeq + 1;
  return {
    ...state,
    toastSeq: id,
    toasts: [...state.toasts, { id, text, tone, at: state.now }].slice(-3),
  };
}
export const expireToasts = (state) => {
  const kept = state.toasts.filter(
    (t) => state.now - t.at < (toastTtl[t.tone] ?? 5000),
  );
  return kept.length === state.toasts.length
    ? state
    : { ...state, toasts: kept };
};
// The newest notice's text (tests and the footer).
export const lastToast = (state) => state.toasts.at(-1)?.text ?? null;
