import { lineWidth, s, wrapLine } from "./lines.js";
import { bodyHeight, frameCols, inner, isNarrow } from "./layout.js";
import { selectedRow, sideWidth } from "./tree.js";
import {
  agentById,
  parseGroup,
  questionRows,
  runRows,
  workspaceRows,
} from "./state.js";
import { kinds } from "./views/index.js";
import { sectionRule } from "./views/common.js";
import { glyphsOf } from "./tree.js";

// The right pane shows what the sidebar has selected. currentItem() says
// what that is: { kind, id, key } and what the kind needs (an agent's id,
// an orchestrator's name, the question, the run, the workspace). key names
// the pane: its scroll position, its expanded entries and what was read for
// it are kept under it.
export function currentItem(state) {
  if (state.filter.trim() && !selectedRow(state))
    return { kind: "empty", id: "empty", key: "empty" };
  const id = state.selected;
  if (id.startsWith("q:")) {
    const question = questionRows(state).find((q) => q.id === id) ?? null;
    return { kind: "question", id, key: id, question };
  }
  if (id.startsWith("orch:")) {
    const name = id.slice(5);
    return { kind: "orchestrator", id, key: `orch:${name}`, name };
  }
  if (id.startsWith("group:")) {
    const { owner, group } = parseGroup(id);
    return { kind: "group", id, key: id, owner, group };
  }
  if (id.startsWith("agent:")) {
    const agentId = id.slice(6);
    return {
      kind: "agent",
      id,
      key: id,
      agentId,
      row: agentById(state, agentId),
    };
  }
  if (id.startsWith("run:")) {
    const runId = id.slice(4);
    const row = runRows(state).find((r) => r.id === runId) ?? null;
    return { kind: "run", id, key: id, runId, row };
  }
  if (id === "more:runs") return { kind: "runs", id, key: id };
  if (id.startsWith("ws:")) {
    const workspaceId = id.slice(3);
    const workspace =
      workspaceRows(state).find((w) => w.id === workspaceId) ?? null;
    return { kind: "workspace", id, key: id, workspaceId, workspace };
  }
  if (id === "events") return { kind: "events", id, key: id };
  return { kind: "overview", id: "pelican", key: "pelican" };
}

// The pane's box: beside the sidebar, or the whole width in a narrow window.
export function paneBox(state) {
  const cols = frameCols(state);
  const height = bodyHeight(state);
  const width = isNarrow(state) ? cols : Math.max(10, cols - sideWidth(state));
  return { width, height, room: inner(width, height) };
}

// A pane's content, from its kind: { title, tabs, right, head (fixed lines),
// body (the lines that scroll), folds (entries that expand), entries (how
// many, for "n new"), live (it follows its newest lines), viewKey }.
export function paneModel(
  state,
  item = currentItem(state),
  box = paneBox(state),
) {
  const model = {
    title: [],
    right: [],
    head: [],
    body: [],
    folds: [],
    entries: 0,
    live: false,
    tabs: null,
    ...kinds[item.kind]?.model(state, item, box),
  };
  model.viewKey ??= item.key;
  // Nothing in the pane is cut: a line wider than the pane wraps (the views
  // wrap their own; this catches the rest), and the expandable entries keep
  // their place.
  const width = box.room.width;
  if (lineWidth(model.title) > width) {
    model.head = [...wrapLine(model.title, width), [], ...model.head];
    model.title = [s(item.kind[0].toUpperCase() + item.kind.slice(1), "bold")];
  }
  const fit = (lines) => {
    const out = [],
      at = [];
    for (const line of lines) {
      at.push(out.length);
      if (lineWidth(line) > width)
        out.push(
          ...wrapLine(line, width, 2).map((wrapped) =>
            Object.assign(wrapped, { targets: line.targets }),
          ),
        );
      else out.push(line);
    }
    at.push(out.length);
    return { out, at };
  };
  model.body = model.body.map((line) =>
    line.section
      ? sectionRule(
          line.section.title,
          width,
          glyphsOf(state),
          line.section.extra,
        )
      : line,
  );
  model.head = fit(model.head).out;
  const body = fit(model.body);
  if (body.out.length !== model.body.length) {
    model.folds = model.folds.map((f) => ({
      ...f,
      line: body.at[f.line],
      size:
        body.at[Math.min(f.line + f.size, model.body.length)] - body.at[f.line],
      end: body.at[Math.min(f.end ?? f.line + f.size, model.body.length)],
    }));
    model.body = body.out;
  }
  model.targets = model.body.map((line, y) =>
    (line.targets ?? []).map((target) => ({ ...target, y })),
  );
  return model;
}

// Where a pane is scrolled to. A live pane starts at its newest line and
// follows it; the others start at the top.
export const bodyRoom = (model, box) =>
  Math.max(1, box.room.height - model.head.length);
export const scrollOf = (state, model) =>
  state.views[model.viewKey] ?? {
    top: 0,
    follow: model.live,
    seen: model.entries,
  };

// The lines in view and what the edges say: whether it follows, how many
// entries came since it was scrolled up, how much is above and below, and
// the expandable entry that Enter opens (the lowest one in view).
export function paneWindow(state, model, box) {
  const room = bodyRoom(model, box);
  const view = scrollOf(state, model);
  const max = Math.max(0, model.body.length - room);
  const follow = Boolean(model.live && view.follow);
  const top = follow ? max : Math.max(0, Math.min(view.top, max));
  const fresh =
    model.live && !follow ? Math.max(0, model.entries - (view.seen ?? 0)) : 0;
  // The entry that holds the bottom line, else the lowest title in view.
  const bottom = Math.min(top + room, model.body.length) - 1;
  let current =
    model.folds.find(
      (f) => f.line <= bottom && (f.end ?? f.line + f.size) > bottom,
    ) ?? null;
  if (!current)
    for (const fold of model.folds)
      if (fold.line >= top && fold.line < top + room) current = fold;
  return {
    room,
    top,
    max,
    follow,
    fresh,
    current,
    lines: model.body.slice(top, top + room),
    above: top,
    below: Math.max(0, model.body.length - top - room),
    total: model.body.length,
  };
}

// ↑↓ (j k) a line, PgUp PgDn a page, Home (g) the top, End (G) the bottom.
// A live pane follows again once it is back at the bottom; scrolled up, it
// holds its place while new lines arrive below.
const steps = { up: -1, down: 1 };
export function scrollPane(state, key, model, box) {
  const w = paneWindow(state, model, box);
  let top = null;
  if (key in steps) top = w.top + steps[key];
  else if (key === "pageup") top = w.top - Math.max(1, w.room - 1);
  else if (key === "pagedown") top = w.top + Math.max(1, w.room - 1);
  else if (key === "home") top = 0;
  else if (key === "end") top = w.max;
  if (top === null) return null;
  top = Math.max(0, Math.min(w.max, top));
  const before = scrollOf(state, model);
  const follow = Boolean(model.live && top >= w.max);
  const seen =
    follow || before.follow ? model.entries : (before.seen ?? model.entries);
  return {
    ...state,
    views: { ...state.views, [model.viewKey]: { top, follow, seen } },
  };
}

// Enter on a pane with commands or edits: the one marked opens or closes.
// One that opens below a held view scrolls into it, as far as its title
// stays in view. rebuild(state) gives the pane's model in a state.
export function toggleFold(state, model, box, rebuild) {
  const w = paneWindow(state, model, box);
  const { current } = w;
  if (!current) return null;
  const list = state.expanded[model.viewKey] ?? [];
  const opening = !list.includes(current.key);
  const next = {
    ...state,
    expanded: {
      ...state.expanded,
      [model.viewKey]: opening
        ? [...list, current.key]
        : list.filter((k) => k !== current.key),
    },
  };
  if (!opening || w.follow || !rebuild) return next;
  const after = rebuild(next);
  const fold = after.folds.find((f) => f.key === current.key);
  if (!fold) return next;
  const room = bodyRoom(after, box);
  const top = Math.max(w.top, Math.min(fold.line, (fold.end ?? 0) - room));
  return {
    ...next,
    views: {
      ...next.views,
      [model.viewKey]: { ...scrollOf(state, model), top, follow: false },
    },
  };
}
