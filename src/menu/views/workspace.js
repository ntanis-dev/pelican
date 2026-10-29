import { s, wrapFacts, wrapLine } from "../lines.js";
import { ago, oneLine, tokens } from "../text.js";
import { fleetRows, liveStatuses } from "../state.js";
import { statusIcon, statusWord } from "../theme.js";
import { gauge, spark } from "../charts.js";
import { glyphsOf } from "../tree.js";
import { note, section } from "./common.js";
import { changes, formLines } from "./settings.js";

// One workspace: its folder, its load (working of its concurrency), its
// settings, an hour of its activity and its live agents. e (or Enter) opens
// its settings as a form.
export const workspaceMetrics = (state, id) =>
  state.metrics.data?.workspaces?.find((w) => w.id === id) ?? null;
export const load = (w, width, g) => [
  ...gauge(w.working, w.settings.concurrency, width, { g }),
  s(` ${w.working}/${w.settings.concurrency}`, w.working ? "bold" : "muted"),
];
export const settingsText = (w) =>
  [
    `${w.settings.concurrency} at once`,
    w.settings.paused ? "paused" : null,
    `${w.settings.model} ${w.settings.effort}`,
    `network ${w.settings.network ? "on" : "off"}`,
  ]
    .filter(Boolean)
    .join(" · ");

// Sparklines of a series set: a label, the line, a value after it.
export function sparkLines(rows, width, g) {
  const label = 8;
  const valueWidth = Math.max(...rows.map(([, , , value]) => value.length + 2));
  const room = Math.max(6, Math.min(60, width - label - valueWidth));
  return rows.map(([name, values, style, value]) => [
    s(name.padEnd(label), "muted"),
    ...spark(values, room, { g, style }),
    s(`  ${value}`, "muted"),
  ]);
}

export function model(state, item, box) {
  const g = glyphsOf(state);
  const w = item.workspace;
  const width = box.room.width;
  if (!w)
    return {
      title: [s(item.workspaceId, "bold")],
      body: [note("This workspace is gone.")],
    };
  const title = [
    s(w.id, "bold"),
    ...(w.name && w.name !== w.id ? [s(` (${w.name})`, "muted")] : []),
  ];
  if (state.form?.workspace === w.id)
    return {
      title: [s("Settings", "bold"), s(" · " + w.id, "muted")],
      right: [
        s(
          Object.keys(changes(state.form)).length
            ? Object.keys(changes(state.form)).length + " unsaved"
            : "All changes saved",
          Object.keys(changes(state.form)).length ? "warn bold" : "muted",
        ),
      ],
      body: formLines(state.form, width, {
        g,
        focused: state.focus === "pane",
      }),
      viewKey: `${item.key}#form`,
    };
  const row = (label, ...facts) =>
    wrapFacts(facts, width, {
      sep: [` ${g.sep} `, "muted"],
      indent: 10,
      lead: [s(label.padEnd(10), "muted")],
    });
  const body = [
    ...wrapLine([s(w.folder, "muted")], width),
    [],
    ...row(
      "load",
      load(w, Math.max(6, Math.min(30, width - 40)), g),
      [s(`${w.queued} queued`, w.queued ? "info" : "muted")],
      [s(`${w.questions} asking`, w.questions ? "warn bold" : "muted")],
    ),
    ...row(
      "settings",
      [s(`${w.settings.concurrency} at once`)],
      ...(w.settings.paused ? [[s("paused", "warn bold")]] : []),
      [s(`${w.settings.model} ${w.settings.effort}`)],
      [s(`network ${w.settings.network ? "on" : "off"}`)],
    ),
    ...row(
      "agents",
      [s(`${w.agents} in all`, "muted")],
      [s(`${w.finished ?? 0} finished`, "muted")],
    ),
    ...row("added", [s(ago(w.createdAt, state.now), "muted")]),
  ];
  const m = workspaceMetrics(state, w.id);
  if (m)
    body.push(
      [],
      section("Activity", `last ${m.series.live.length} min`),
      ...sparkLines(
        [
          ["agents", m.series.live, "accent", `peak ${m.totals.peak}`],
          ["tokens", m.series.tokens, "hot", tokens(m.totals.tokens)],
          ["events", m.series.events, "accent", String(m.totals.events)],
        ],
        width,
        g,
      ),
    );
  const live = fleetRows(state).filter(
    (a) => a.workspace === w.id && liveStatuses.has(a.status),
  );
  body.push([], section("Live agents", String(live.length)));
  if (!live.length) body.push(note("None."));
  for (const a of live) {
    const [icon, style] = statusIcon(a.status, g, a.questions);
    body.push(
      ...wrapFacts(
        [
          [s(icon, style), s(" "), s(a.agentName, "bold")],
          [s(statusWord(a.status, a.questions), "muted")],
          [s(a.owner, a.owner === state.as ? "accent" : "muted")],
          [s(oneLine(a.name))],
        ],
        width,
        { sep: [` ${g.sep} `, "muted"], indent: 2 },
      ),
    );
  }
  return { title, body };
}
