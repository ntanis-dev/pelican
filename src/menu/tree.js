import { fuzzyMatches } from "./fuzzy.js";
import { lineWidth, restyle, s, wrapLine, fitLine } from "./lines.js";
import { span, width } from "./text.js";
import { glyphSets, statusIcon, statusWord } from "./theme.js";
import { bodyHeight, isNarrow, sidebarCols } from "./layout.js";
import {
  agentGroup,
  agentGroups,
  finishedRun,
  groupId,
  latestFew,
  liveStatuses,
  orchestrators,
  parseGroup,
  questionRows,
  runRows,
  workspaceRows,
} from "./state.js";

// The sidebar: one tree of everything there is to look at, in this order:
// Pelican (the overview), the open questions (only while there are any),
// the orchestrators with their agent counts beneath, the workflow runs, the
// workspaces, and the event feed. Orchestrators are nodes that open and
// close (▾ ▸); those with live agents or questions start open. Beneath one
// are no agents but a row per group that has some (3 working, 5 done, 1
// failed); the right pane lists the agents of the selected group, and the one
// opened from it shows as a single row under its group while it is selected.
// Finished runs beyond the latest few fold into a "+ n earlier" row.
//
// A row is { id, kind, depth, icon: span | null, name, nameStyle, tail:
// spans (the short state, dropped first when room is short, unless keepTail:
// it is a count, and the name wraps around it), parent, node, open,
// selectable }. Headings and gaps are rows that cannot be selected.
const heading = (id, text, style, count) => ({
  id,
  kind: "heading",
  depth: 0,
  icon: null,
  name: text,
  nameStyle: style,
  tail: count ? [s(String(count), "muted")] : [],
  selectable: false,
});
const gap = (id) => ({
  id,
  kind: "gap",
  depth: 0,
  name: "",
  tail: [],
  selectable: false,
});

export const glyphsOf = (state) => glyphSets[state.glyphs] ?? glyphSets.rich;

// Is an orchestrator open: the person's choice, else open while it has live
// agents or questions. The orchestrator of the selected group or agent is
// always open, so the selection never hides.
function isOpen(state, r, selectedOwner, everything = false) {
  if (everything || state.filter) return true;
  if (r.name === selectedOwner) return true;
  return state.open[r.name] ?? Boolean(r.live.length || r.questions.length);
}

const groupTone = {
  asking: "warn bold",
  working: "accent",
  failed: "err",
};
// The status a group's icon shows.
const groupStatus = {
  asking: "waiting",
  working: "running",
  queued: "queued",
  stopping: "stopping",
  done: "completed",
  failed: "failed",
  stopped: "stopped",
};
const groupRow = (r, group, agents, parent, g) => ({
  id: groupId(r.name, group),
  kind: "group",
  depth: 1,
  icon: s(...statusIcon(groupStatus[group], g)),
  name: group,
  nameStyle: groupTone[group] ? "bold" : "",
  tail: [s(String(agents.length), groupTone[group] ?? "muted")],
  keepTail: true,
  parent,
  selectable: true,
  owner: r.name,
  group,
  agents,
});

const agentRow = (state, a, parent, g) => {
  const asking = a.questions > 0;
  return {
    id: `agent:${a.id}`,
    kind: "agent",
    depth: 2,
    icon: s(...statusIcon(a.status, g, a.questions)),
    name: a.agentName ?? String(a.id).slice(0, 8),
    nameStyle: liveStatuses.has(a.status) ? "bold" : "",
    tail: [
      s(
        statusWord(a.status, a.questions),
        asking
          ? "warn bold"
          : ["failed", "blocked"].includes(a.status)
            ? "err"
            : a.status === "running" || a.status === "starting"
              ? "accent"
              : "muted",
      ),
    ],
    parent,
    selectable: true,
    agent: a,
  };
};

// Every row, filtered and folded as the state says; with everything, the
// whole tree: no filter, every orchestrator open, every finished item shown.
export function treeRows(state, { everything = false } = {}) {
  const g = glyphsOf(state);
  const query = everything ? "" : state.filter.trim();
  const match = (...names) => !query || fuzzyMatches(query, ...names);
  const selectedAgent = state.selected.startsWith("agent:")
    ? state.selected.slice(6)
    : null;
  const owner = selectedAgent
    ? (state.data.fleet ?? []).find((a) => a.id === selectedAgent)?.owner
    : state.selected.startsWith("group:")
      ? parseGroup(state.selected).owner
      : null;
  const sections = [];
  // The overview of Pelican itself.
  if (match("Overview", "pelican"))
    sections.push([
      {
        id: "pelican",
        kind: "pelican",
        depth: 0,
        icon: s(" "),
        name: "Overview",
        nameStyle: "bold",
        tail: state.data.status?.service
          ? [s(`up ${span(state.data.status.service.uptimeMs ?? 0)}`, "muted")]
          : [],
        selectable: true,
      },
    ]);
  // The open questions, attention first.
  const questions = questionRows(state).filter((q) =>
    match(q.agentName, q.owner),
  );
  if (questions.length)
    sections.push([
      heading("h:questions", "Questions", "warn bold", questions.length),
      ...questions.map((q) => ({
        id: q.id,
        kind: "question",
        depth: 0,
        icon: s(g.diamond, "warn bold"),
        name: q.agentName ?? String(q.jobId).slice(0, 8),
        nameStyle: "bold",
        tail: [
          s(`${g.right} `, "muted"),
          s(q.owner, q.owner === state.as ? "accent bold" : "muted"),
        ],
        selectable: true,
        question: q,
      })),
    ]);
  // The orchestrators and their agents.
  const orch = [];
  for (const r of orchestrators(state)) {
    const named = match(r.name);
    const agents = [...r.live, ...r.finished].filter(
      (a) => named || match(a.agentName),
    );
    if (!named && !agents.length) continue;
    const open = isOpen(state, r, owner, everything);
    const tail = [
      ...(r.live.length
        ? [
            s(
              `${r.live.length} live`,
              r.live.some(working) ? "accent" : "muted",
            ),
          ]
        : []),
      ...(r.questions.length
        ? [
            s(r.live.length ? "  " : ""),
            s(`${g.diamond} ${r.questions.length}`, "warn bold"),
          ]
        : []),
    ];
    const id = `orch:${r.name}`;
    orch.push({
      id,
      kind: "orch",
      depth: 0,
      icon: s(open ? g.open : g.closed, "muted"),
      name: r.name,
      nameStyle: r.name === state.as ? "accent bold" : "bold",
      tail,
      keepTail: true,
      node: true,
      open,
      selectable: true,
      orchestrator: r,
    });
    if (!open) continue;
    for (const group of agentGroups) {
      const own = agents.filter((a) => agentGroup(a) === group);
      if (!own.length) continue;
      const row = groupRow(r, group, own, id, g);
      orch.push(row);
      const opened = own.find((a) => a.id === selectedAgent);
      if (opened) orch.push(agentRow(state, opened, row.id, g));
    }
  }
  if (orch.length)
    sections.push([
      heading("h:orchestrators", "Orchestrators", "muted bold"),
      ...orch,
    ]);
  // Workflow runs: the running ones, then the latest finished.
  const runs = runRows(state).filter((r) => match(r.name, r.id));
  if (runs.length) {
    const running = runs.filter((r) => !finishedRun.has(r.status));
    const done = runs.filter((r) => finishedRun.has(r.status));
    const all = everything || query || state.more.runs;
    const shown = all
      ? done
      : done.filter(
          (r, i) => i < latestFew || `run:${r.id}` === state.selected,
        );
    const hidden = done.length - shown.length;
    sections.push([
      heading("h:workflows", "Workflows", "muted bold"),
      ...[...running, ...shown].map((r) => {
        const a = r.agents ?? {};
        return {
          id: `run:${r.id}`,
          kind: "run",
          depth: 0,
          icon: s(
            ...statusIcon(r.status === "stopped" ? "cancelled" : r.status, g),
          ),
          name: r.name ?? String(r.id).slice(0, 8),
          nameStyle: finishedRun.has(r.status) ? "" : "bold",
          tail: [
            s(
              `${(a.done ?? 0) + (a.failed ?? 0)}/${a.total ?? 0}`,
              a.failed ? "err" : "muted",
            ),
          ],
          keepTail: true,
          selectable: true,
          run: r,
        };
      }),
      ...(!query && done.length > latestFew
        ? [
            {
              id: "more:runs",
              kind: "more",
              depth: 0,
              icon: null,
              name: all
                ? `${g.less} ${done.length - latestFew} earlier`
                : `${g.more} ${hidden} earlier`,
              nameStyle: "muted",
              tail: [],
              selectable: true,
              more: "runs",
            },
          ]
        : []),
    ]);
  }
  // Workspaces with their load.
  const spaces = workspaceRows(state).filter((w) => match(w.id, w.name));
  if (spaces.length)
    sections.push([
      heading("h:workspaces", "Workspaces", "muted bold"),
      ...spaces.map((w) => ({
        id: `ws:${w.id}`,
        kind: "workspace",
        depth: 0,
        icon: null,
        name: w.id,
        nameStyle: "",
        tail: [
          s(
            `${w.working}/${w.settings.concurrency}`,
            w.working >= w.settings.concurrency
              ? "warn"
              : w.working
                ? "accent"
                : "muted",
          ),
          ...(w.settings.paused ? [s(" paused", "warn")] : []),
          ...(w.settings.network ? [s(" net", "muted")] : []),
        ],
        keepTail: true,
        selectable: true,
        workspace: w,
      })),
    ]);
  if (match("Events", "feed"))
    sections.push([
      {
        id: "events",
        kind: "events",
        depth: 0,
        icon: s(" "),
        name: "Events",
        nameStyle: "bold",
        tail: [],
        selectable: true,
      },
    ]);
  const rows = sections.flatMap((section, i) => [
    ...(i ? [gap(`gap:${i}`)] : []),
    ...section,
  ]);
  if (!rows.length)
    rows.push({
      ...gap("none"),
      kind: "none",
      name: "Nothing matches.",
      nameStyle: "muted",
      icon: null,
    });
  return rows;
}
const working = (a) => a.status === "running" || a.status === "starting";

// The cells a row needs: the selection marker, the indent, the icon, the
// name and, after two spaces, the short state; one more to the right edge.
const marker = 2;
const prefixWidth = (row) => marker + row.depth * 2 + (row.icon ? 2 : 0);
export const rowWidth = (row) =>
  prefixWidth(row) +
  width(row.name) +
  (row.tail.length ? 2 + lineWidth(row.tail) : 0) +
  1;

// The sidebar's width with its border: what the widest row of the whole
// tree needs, within the bounds, so filtering, opening or closing never moves
// the divider; in a narrow window, the whole width.
export const sideWidth = () => sidebarCols;

// A row as lines `cells` wide. The name is never cut: the short state goes
// first, then the name wraps under itself; a count stays on the first line
// and the name wraps around it. The selected row is highlighted
// (inverse) when the sidebar has the keys, else marked with ›.
// span bounds where the short state goes (a row reads as one line in a
// sidebar as wide as the window); the highlight still runs to the edge.
export function rowLines(
  row,
  cells,
  { selected = false, focused = false, g, span = cells },
) {
  if (row.kind === "gap") return [[]];
  const indent = " ".repeat(row.depth * 2);
  const mark = selected
    ? [s(`${g.arrow} `, focused ? "" : "accent bold")]
    : [s("  ")];
  const icon = row.icon ? [row.icon, s(" ")] : [];
  const nameStyle =
    selected && !focused ? `${row.nameStyle ?? ""} bold`.trim() : row.nameStyle;
  const name = [s(row.name, nameStyle)];
  const head = [...mark, s(indent), ...icon];
  const room = Math.min(cells, span);
  let lines;
  if (rowWidth(row) <= room)
    lines = [
      [
        ...head,
        ...name,
        s(" ".repeat(room - rowWidth(row) + (row.tail.length ? 2 : 0))),
        ...row.tail,
        s(" "),
      ],
    ];
  else if (row.keepTail && row.tail.length) {
    const lead = prefixWidth(row);
    const tail = lineWidth(row.tail);
    lines = wrapLine(name, Math.max(1, room - 1 - lead - 2 - tail)).map(
      (line, i) =>
        i
          ? [s(" ".repeat(lead)), ...line]
          : [
              ...head,
              ...line,
              s(
                " ".repeat(
                  Math.max(2, room - 1 - lead - lineWidth(line) - tail),
                ),
              ),
              ...row.tail,
              s(" "),
            ],
    );
  } else {
    // The name wraps under itself, after the marker, indent and icon.
    const lead = prefixWidth(row);
    lines = wrapLine(name, Math.max(1, cells - 1 - lead)).map((line, i) =>
      i ? [s(" ".repeat(lead)), ...line] : [...head, ...line],
    );
  }
  if (selected && focused)
    return lines.map((line) =>
      fitLine(restyle(line, "selected bold"), cells, "selected bold"),
    );
  return lines.map((line) => fitLine(line, cells));
}

// The selectable rows, and where the selection is among them.
export const selectable = (rows) => rows.filter((r) => r.selectable);
export function selectedRow(state, rows = treeRows(state)) {
  return rows.find((r) => r.id === state.selected && r.selectable) ?? null;
}

// After the data or the filter changes: the selection stays on its item
// while it is there; when it went away, the row now at its place (or the
// nearest one above) takes it.
export function reselect(state) {
  const rows = selectable(treeRows(state));
  if (!rows.length) return state;
  const at = rows.findIndex((r) => r.id === state.selected);
  if (at >= 0) return at === state.index ? state : { ...state, index: at };
  const index = Math.max(0, Math.min(state.index, rows.length - 1));
  return { ...state, selected: rows[index].id, index };
}

// Moves the selection: ±n rows, or to the first or last.
export function moveSelection(state, step) {
  const rows = selectable(treeRows(state));
  if (!rows.length) return state;
  const at = Math.max(
    0,
    rows.findIndex((r) => r.id === state.selected),
  );
  const index =
    step === "first"
      ? 0
      : step === "last"
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, at + step));
  if (rows[index].id === state.selected && index === state.index) return state;
  return { ...state, selected: rows[index].id, index, moved: true };
}
export const select = (state, id) => {
  const index = selectable(treeRows({ ...state, selected: id })).findIndex(
    (r) => r.id === id,
  );
  return { ...state, selected: id, index: Math.max(0, index), moved: true };
};

// The sidebar's lines and which of them belong to the selection, for the
// window that keeps it in view.
export function sideLines(
  state,
  cells,
  { focused, g, rows = treeRows(state), span = cells },
) {
  const lines = [],
    owners = [];
  let from = 0,
    to = 0;
  for (const row of rows) {
    const selected = row.selectable && row.id === state.selected;
    const own = rowLines(row, cells, { selected, focused, g, span });
    if (selected) {
      from = lines.length;
      to = from + own.length;
    }
    lines.push(...own);
    owners.push(...own.map(() => (row.selectable ? row.id : null)));
  }
  return { lines, owners, from, to };
}
// The first line of the window: the selection in view, with a little of
// what is around it.
export function sideTop(count, from, to, height) {
  if (count <= height) return 0;
  const room = Math.max(0, height - (to - from));
  const top = from - Math.floor(room / 2);
  return Math.max(0, Math.min(top, count - height));
}
// Where the short states line up: the edge, or in a sidebar as wide as the
// window a column after the widest row (30 to 48 cells).
export function sideSpan(state, cells, rows = treeRows(state)) {
  if (!isNarrow(state)) return cells;
  const widest = Math.max(0, ...rows.map(rowWidth));
  return Math.min(cells, Math.max(30, Math.min(48, widest)));
}
// Rows to move for PgUp / PgDn.
export const sidePage = (state) => Math.max(1, bodyHeight(state) - 4);
