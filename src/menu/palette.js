import { matchFields } from "./fuzzy.js";
import { editField, insertText } from "./modal.js";
import {
  finishedRun,
  liveStatuses,
  orchestrators,
  questionRows,
  runRows,
  workspaceRows,
} from "./state.js";
import {
  answerQuestion,
  editSettings,
  messageAgent,
  refreshNow,
  resumeAgent,
  resumeRun,
  stopAgent,
  stopEveryone,
  stopOrchestrator,
  stopRun,
} from "./actions.js";
import { select, selectable, treeRows } from "./tree.js";
import { refresh, result } from "./views/common.js";
import { short } from "./text.js";
import { statusWord } from "./theme.js";

// The command palette (: or Ctrl+K): jump to anything in the sidebar (an
// agent, an orchestrator, a run, a workspace, a question, the overview or
// the events), or run an action, by typing a few letters of it (fuzzy).
// Each item is { id, kind, label, hint, key?, run(state) -> result }.
export const kinds = {
  go: "go",
  question: "ask",
  agent: "agent",
  orchestrator: "orch",
  run: "run",
  workspace: "space",
  action: "do",
};
const quit = { type: "quit" };

// Selects an item and gives the right pane the keys. A filter that hides
// it is cleared first.
export function jump(state, id) {
  let next = state;
  if (
    next.filter &&
    !selectable(treeRows({ ...next, selected: id })).some((r) => r.id === id)
  )
    next = { ...next, filter: "", filtering: false };
  next = select({ ...next, palette: null }, id);
  return result({ ...next, focus: "side", filtering: false }, [refresh]);
}

export function paletteItems(state) {
  const items = [];
  const add = (item) => items.push(item);
  add({
    id: "go:pelican",
    kind: "go",
    label: "Overview",
    hint: "the overview: the service, the last hour, load, top tokens",
    run: (s) => jump(s, "pelican"),
  });
  add({
    id: "go:events",
    kind: "go",
    label: "Events",
    hint: "the live feed of every workspace",
    run: (s) => jump(s, "events"),
  });
  for (const q of questionRows(state)) {
    add({
      id: `question:${q.id}`,
      kind: "question",
      label: `${q.agentName} asks ${q.owner}`,
      hint: q.question,
      run: (s) => jump(s, q.id),
    });
    add({
      id: `answer:${q.id}`,
      kind: "action",
      label: `Answer ${q.agentName}`,
      hint: `${q.kind} for ${q.owner}`,
      run: (s) => answerQuestion({ ...s, palette: null }, q),
    });
  }
  add({
    id: "action:stop-all",
    kind: "action",
    label: "Stop every agent",
    hint: "every orchestrator's; type yes to confirm",
    key: "S",
    run: stopEveryone,
  });
  add({
    id: "action:refresh",
    kind: "action",
    label: "Refresh now",
    hint: "the menu refreshes every 2 s",
    key: "r",
    run: (s) => refreshNow({ ...s, palette: null }),
  });
  add({
    id: "action:quit",
    kind: "action",
    label: "Quit the menu",
    hint: "agents keep running; the service exits when idle",
    key: "q",
    run: (s) => result(s, [quit]),
  });
  // Agents, those that wait for an answer first, then the live ones.
  const agents = [...(state.data.fleet ?? [])].sort(
    (a, b) =>
      (b.questions ? 1 : 0) - (a.questions ? 1 : 0) ||
      (liveStatuses.has(b.status) ? 1 : 0) -
        (liveStatuses.has(a.status) ? 1 : 0) ||
      String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  for (const a of agents) {
    add({
      id: `agent:${a.id}`,
      kind: "agent",
      label: a.agentName,
      hint: `${statusWord(a.status, a.questions)} · ${a.owner} · ${a.workspace} · ${a.name}`,
      extra: [a.id, a.name],
      status: a.status,
      questions: a.questions,
      run: (s) => jump(s, `agent:${a.id}`),
    });
    if (liveStatuses.has(a.status))
      add({
        id: `stop:${a.id}`,
        kind: "action",
        label: `Stop ${a.agentName}`,
        hint: a.name,
        extra: [short(a.id)],
        run: (s) => stopAgent({ ...s, palette: null }, a),
      });
    add({
      id: `message:${a.id}`,
      kind: "action",
      label: `Message ${a.agentName}`,
      hint: "steer its turn, or a followup",
      extra: [short(a.id)],
      run: (s) => messageAgent({ ...s, palette: null }, a),
    });
    if (!liveStatuses.has(a.status))
      add({
        id: `resume:${a.id}`,
        kind: "action",
        label: `Resume ${a.agentName}`,
        hint: "its next assignment in the same conversation",
        extra: [short(a.id)],
        run: (s) => resumeAgent({ ...s, palette: null }, a),
      });
  }
  for (const r of orchestrators(state)) {
    add({
      id: `orchestrator:${r.name}`,
      kind: "orchestrator",
      label: r.name,
      hint: `its timeline · ${r.live.length} live · ${r.questions.length} asking${r.lastNote ? ` · ${r.lastNote.body}` : ""}`,
      run: (s) => jump(s, `orch:${r.name}`),
    });
    if (r.live.length)
      add({
        id: `stop-orchestrator:${r.name}`,
        kind: "action",
        label: `Stop every agent of ${r.name}`,
        hint: `${r.live.length} live; type yes to confirm`,
        run: (s) =>
          stopOrchestrator({ ...s, palette: null }, r.name, r.live.length),
      });
  }
  for (const r of runRows(state)) {
    const done = finishedRun.has(r.status);
    add({
      id: `run:${r.id}`,
      kind: "run",
      label: r.name ?? short(r.id),
      hint: `${r.status} · ${r.owner} · ${r.workspace}`,
      extra: [r.id],
      status: r.status,
      run: (s) => jump(s, `run:${r.id}`),
    });
    add({
      id: done ? `resume-run:${r.id}` : `stop-run:${r.id}`,
      kind: "action",
      label: `${done ? "Resume" : "Stop"} the run ${r.name ?? short(r.id)}`,
      hint: r.workspace,
      run: (s) =>
        done
          ? resumeRun({ ...s, palette: null }, r)
          : stopRun({ ...s, palette: null }, r),
    });
  }
  for (const w of workspaceRows(state)) {
    add({
      id: `workspace:${w.id}`,
      kind: "workspace",
      label: w.id,
      hint: `${w.working} working · ${w.queued} queued · ${w.folder}`,
      extra: [w.name],
      run: (s) => jump(s, `ws:${w.id}`),
    });
    add({
      id: `settings:${w.id}`,
      kind: "action",
      label: `Settings of ${w.id}`,
      hint: "concurrency, paused, model, effort, network",
      extra: [w.name],
      run: (s) => {
        const there = jump(s, `ws:${w.id}`).state;
        return result(editSettings(there, w).state, [refresh]);
      },
    });
  }
  return items;
}

// What an empty query lists: the overview and events, the questions, the
// actions for everyone, the live agents, the running runs, the
// orchestrators and the workspaces.
const perItem =
  /^(stop|message|resume|stop-run|resume-run|stop-orchestrator|settings):/;
export function paletteResults(state, limit = 200) {
  const query = state.palette?.value ?? "";
  const items = paletteItems(state);
  if (!query.trim())
    return items
      .filter(
        (item) =>
          item.kind === "go" ||
          item.kind === "question" ||
          (item.kind === "action" &&
            !perItem.test(item.id) &&
            !item.id.startsWith("answer:")) ||
          (item.kind === "agent" &&
            (item.questions || liveStatuses.has(item.status))) ||
          (item.kind === "run" && !finishedRun.has(item.status)) ||
          item.kind === "orchestrator" ||
          item.kind === "workspace",
      )
      .slice(0, limit);
  const order = Object.keys(kinds);
  return items
    .map((item, i) => ({
      item,
      i,
      score: matchFields(query, [
        item.label,
        item.kind,
        kinds[item.kind],
        item.hint,
        ...(item.extra ?? []),
      ]),
      label: matchFields(query, [item.label]),
    }))
    .filter((x) => x.score !== null)
    .sort(
      (a, b) =>
        (b.label ?? -1) - (a.label ?? -1) ||
        b.score - a.score ||
        order.indexOf(a.item.kind) - order.indexOf(b.item.kind) ||
        a.i - b.i,
    )
    .slice(0, limit)
    .map((x) => x.item);
}

export function openPalette(state) {
  return result(
    {
      ...state,
      palette: { value: "", cursor: 0, index: 0 },
      filtering: false,
    },
    [refresh],
  );
}

export function paletteText(state, text) {
  return result({
    ...state,
    palette: { ...insertText(state.palette, text), index: 0 },
  });
}

export function paletteKeys(state, key) {
  const palette = state.palette;
  const close = { ...state, palette: null };
  if (key === "escape") return result(close);
  const found = paletteResults(state);
  const count = found.length;
  const move = (index) => result({ ...state, palette: { ...palette, index } });
  if (key === "up")
    return move(count ? (palette.index - 1 + count) % count : 0);
  if (key === "down") return move(count ? (palette.index + 1) % count : 0);
  if (key === "pageup") return move(Math.max(0, palette.index - 8));
  if (key === "pagedown")
    return move(Math.min(Math.max(0, count - 1), palette.index + 8));
  if (key === "enter") {
    const item = found[Math.min(palette.index, count - 1)];
    if (!item) return result(state);
    return item.run(close) ?? result(close);
  }
  const edited = editField(palette, key);
  if (edited) return result({ ...state, palette: { ...edited, index: 0 } });
  return result(state);
}
