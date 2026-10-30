import { fitLine, restyle, s, wrapFacts, wrapLine } from "../lines.js";
import { ago, oneLine, short, span, wrap } from "../text.js";
import { statusIcon, statusStyle } from "../theme.js";
import { agentById, pickedAgent } from "../state.js";
import { progress, stepper } from "../charts.js";
import { glyphsOf } from "../tree.js";
import { entryBody, note } from "./common.js";

// One workflow run: its status and progress, a stepper of its phases, each
// phase's agent calls, its open questions, and its log, newest at the
// bottom and live. The agents the fleet knows can be opened: a click, or ↑↓
// to pick and Enter (the pane has the keys); Backspace in the agent comes
// back here.
export function runAgents(state, item) {
  const d = state.cache[item.key]?.detail;
  return (d?.phases ?? [])
    .flatMap((phase) => phase.agents ?? [])
    .filter((a) => a.jobId && agentById(state, a.jobId))
    .map((a) => ({ ...a, id: a.jobId }));
}
export const took = (r, now) =>
  r.startedAt
    ? span((r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt))
    : "";
const runTone = (status) =>
  statusStyle(status === "stopped" ? "cancelled" : status);
export const runStatus = (r, g) => {
  const [icon, style] = statusIcon(
    r.status === "stopped" ? "cancelled" : r.status,
    g,
  );
  return [s(icon, style), s(` ${r.status}`, runTone(r.status))];
};
// A run's bar and count: "━━━── 2/3".
export const runProgress = (a = {}, width, g) => [
  ...progress(a, width, { g }),
  s(` ${(a.done ?? 0) + (a.failed ?? 0)}/${a.total ?? 0}`, "muted"),
];

function headLines(state, d, width, g) {
  const facts = [
    `owner ${d.owner}`,
    d.workspace,
    d.startedAt ? `started ${ago(d.startedAt, state.now)}` : null,
    d.startedAt && d.endedAt ? `took ${took(d, state.now)}` : null,
  ].filter(Boolean);
  const lines = [
    ...wrapFacts(
      [runStatus(d, g), ...facts.map((f) => [s(f, "muted")])],
      width,
      {
        sep: [` ${g.sep} `, "muted"],
        indent: 2,
      },
    ),
    ...wrapLine(
      [
        ...runProgress(d.agents, Math.max(8, Math.min(30, width - 40)), g),
        s(" done", "muted"),
        ...(d.agents?.live
          ? [s(` ${g.sep} ${d.agents.live} live`, "accent")]
          : []),
        ...(d.agents?.failed
          ? [s(` ${g.sep} ${d.agents.failed} failed`, "err")]
          : []),
      ],
      width,
      2,
    ),
  ];
  if (d.phases?.length)
    lines.push(...stepper(d.phases, width, { g, runStatus: d.status }));
  return lines;
}

function bodyLines(state, d, width, g, { picked, focused, openable }) {
  const lines = [];
  let pickLine = null;
  for (const phase of d.phases ?? []) {
    const agents = phase.agents ?? [];
    const done = agents.filter((a) =>
      ["completed", "replayed"].includes(a.status),
    ).length;
    lines.push([
      s(phase.title ?? "Phase", "bold"),
      s(
        agents.length ? `  ${done}/${agents.length}` : "  not started",
        "muted",
      ),
    ]);
    for (const a of agents) {
      const [icon, style] = statusIcon(a.status, g);
      const here = Boolean(a.jobId) && a.jobId === picked?.id && focused;
      const own = wrapLine(
        [
          s(here ? `${g.arrow} ` : "  "),
          s(`${icon} `, style),
          s(a.label ?? short(a.jobId)),
          s(`  ${a.status ?? ""}`, statusStyle(a.status)),
          s(`  ${short(a.jobId)}`, "muted"),
        ],
        width,
        4,
      );
      if (here) pickLine = { line: lines.length, size: own.length };
      for (const line of own) {
        const out = here
          ? fitLine(restyle(line, "selected bold"), width, "selected bold")
          : line;
        lines.push(
          openable.has(a.jobId)
            ? Object.assign(out, {
                targets: [{ x: 0, width, openAgent: a.jobId }],
              })
            : out,
        );
      }
    }
  }
  if (!lines.length) lines.push(note("No phase has started yet."));
  const questions = Array.isArray(d.questions) ? d.questions : [];
  if (questions.length) {
    lines.push([]);
    for (const q of questions)
      lines.push(
        ...wrapLine(
          [
            s(`${g.diamond} `, "warn bold"),
            s(`${q.label ?? q.agentName} asks ${q.owner ?? d.owner}: `, "warn"),
            s(oneLine(q.question)),
          ],
          width,
          2,
        ),
      );
  }
  if (d.error) {
    lines.push([]);
    lines.push(
      ...wrapLine(
        [s("Error ", "err bold"), s(oneLine(d.error), "err")],
        width,
        2,
      ),
    );
  }
  if (d.result !== null && d.result !== undefined) {
    lines.push([], [s("Result", "bold")]);
    const text =
      typeof d.result === "string"
        ? d.result
        : JSON.stringify(d.result, null, 2);
    lines.push(...wrap(text, width - 2).map((l) => [s(`  ${l}`)]));
  }
  return { lines, pickLine };
}

export function model(state, item, box) {
  const g = glyphsOf(state);
  const data = state.cache[item.key];
  const d = data?.detail ?? item.row;
  const width = box.room.width;
  const title = [s(d?.name ?? short(item.runId), "bold")];
  if (!d)
    return {
      title,
      body: [
        note(data?.error ?? "Reading the run.", data?.error ? "err" : "muted"),
      ],
    };
  const head = headLines(state, d, width, g);
  if (data?.error) head.push(...wrapLine([s(data.error, "err")], width));
  head.push([]);
  if (!data?.detail)
    return { title, head, body: [note("Reading its phases and log.")] };
  const openable = runAgents(state, item);
  const { lines: top, pickLine } = bodyLines(state, d, width, g, {
    picked: pickedAgent(state, item.key, openable),
    focused: state.focus === "pane",
    openable: new Set(openable.map((a) => a.id)),
  });
  const log = (d.log ?? []).map((entry, i) => ({
    key: `log${i}`,
    sig: `${i}|${entry.at}|${String(entry.text).length}`,
    at: entry.at,
    title: [s(String(entry.text ?? ""))],
  }));
  const logBody = entryBody(log, width, { g, scope: item.key });
  return {
    title,
    head,
    live: true,
    entries: log.length,
    pickLine,
    body: [
      ...top,
      [],
      [s("Log", "bold"), s(`  ${log.length}`, "muted")],
      ...(log.length ? logBody.body : [note("Nothing logged yet.")]),
    ],
  };
}

// The runs that fold under "+ n earlier": every run, newest first.
export function listModel(state, rows, width, g) {
  const lines = [];
  for (const r of rows) {
    lines.push(
      ...wrapLine(
        [
          ...runStatus(r, g),
          s("  "),
          s(r.name ?? short(r.id), "bold"),
          s(
            `  ${(r.agents?.done ?? 0) + (r.agents?.failed ?? 0)}/${r.agents?.total ?? 0}`,
            "muted",
          ),
          s(
            `  ${g.sep} ${r.owner} ${g.sep} ${r.workspace}${r.startedAt ? ` ${g.sep} ${ago(r.startedAt, state.now)}` : ""}`,
            "muted",
          ),
        ],
        width,
        2,
      ),
    );
  }
  return lines;
}
