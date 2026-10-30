import { fitLine, lineWidth, s, wrapFacts, wrapLine } from "../lines.js";
import { ago, plural, span, tokens, width as cells, wrap } from "../text.js";
import { creditBalance, resetsIn, windowName } from "../../format.js";
import { fleetRows, orchestrators, workspaceRows } from "../state.js";
import { chart, compact, gauge, spark } from "../charts.js";
import { glyphsOf } from "../tree.js";
import { note, section } from "./common.js";

// Pelican at a glance: the pelican beside the service's facts (process,
// address, uptime, sign-in, counts), the last hour as graphs from the
// metrics method (agents live, tokens and events per minute, questions,
// finishes, load), each workspace's load, and the agents that used the
// most tokens. Clean and spaced: sections, not panels.
// The last hour, by the minute: a line per series and the value now.
function activity(state, width, g, { rows }) {
  const m = state.metrics;
  if (!m.data) return [note(m.error ?? "Reading the activity.")];
  const d = m.data;
  const perMinute = (values) => {
    const done = values.slice(-6, -1);
    const avg = done.length ? done.reduce((a, b) => a + b, 0) / done.length : 0;
    return (avg * 60) / d.bucketSeconds;
  };
  const label = 8;
  const valueWidth = 26;
  const room = Math.max(
    6,
    Math.min(d.series.live.length, width - label - valueWidth - 1),
  );
  const row = (name, values, style, value) => [
    s(name.padEnd(label), "muted"),
    ...spark(values, room, { g, style }),
    s("  "),
    ...value,
  ];
  const all = {
    agents: row("agents", d.series.live, "accent", [
      s(`${d.now.working}`, d.now.working ? "accent bold" : "muted"),
      s(` now ${g.sep} peak ${d.totals.peak}`, "muted"),
    ]),
    tokens: row("tokens", d.series.tokens, "hot", [
      s(`${compact(perMinute(d.series.tokens))}/min`, "bold"),
      s(` ${g.sep} ${compact(d.totals.tokens)}`, "muted"),
    ]),
    events: row("events", d.series.events, "accent", [
      s(`${compact(perMinute(d.series.events))}/min`, "bold"),
      s(` ${g.sep} ${d.totals.events}`, "muted"),
    ]),
    asks: row("asks", d.series.questions, "warn", [
      s(`${d.now.questions}`, d.now.questions ? "warn bold" : "muted"),
      s(` open ${g.sep} ${d.totals.questions} asked`, "muted"),
    ]),
    done: row("done", d.series.finished, "ok", [
      s(`${d.totals.finished}`, "bold"),
      s(" finished", "muted"),
      ...(d.totals.failed
        ? [s(` ${g.sep} `, "muted"), s(`${d.totals.failed} failed`, "err")]
        : []),
    ]),
    load: [
      s("load".padEnd(label), "muted"),
      ...gauge(d.now.working, d.now.concurrency || 1, room, { g }),
      s(`  ${d.now.working}/${d.now.concurrency} at once`, "muted"),
    ],
  };
  const lines = rows.map((name) => all[name]);
  return { lines, label, room, d };
}

// The Codex usage limits as the service last read them: a bar for each
// window (the short one, the weekly one) with the percent used and when it
// resets; green while there is room, yellow from 70%, red from 90%.
const usageTone = (percent) =>
  percent >= 90 ? "err" : percent >= 70 ? "warn" : "ok";
const usageNote = (state, g) => {
  const d = state.usage.data;
  return d?.at
    ? [d.plan, `read ${ago(d.at, state.now)}`]
        .filter(Boolean)
        .join(` ${g.sep} `)
    : "";
};
function usageLines(state, width, g) {
  const u = state.usage;
  if (!u.data) return [note(u.error ?? "Reading the usage limits.")];
  const d = u.data;
  if (!d.at && !d.limits.length)
    return [
      note(
        d.error
          ? `Usage limits are not available: ${d.error}`
          : "The usage limits have not been read yet.",
      ),
    ];
  const label = 8;
  const bar = Math.max(6, Math.min(24, width - label - 24));
  const lines = [];
  for (const limit of d.limits) {
    if (d.limits.length > 1) lines.push([s(limit.name, "bold")]);
    for (const w of limit.windows) {
      const percent = Math.round(w.usedPercent);
      lines.push([
        s(windowName(w.windowMinutes).padEnd(label), "muted"),
        ...gauge(percent, 100, bar, { g, style: usageTone(percent) }),
        s(` ${percent}%`.padStart(5), "bold"),
        ...(w.resetsAt
          ? [s(`  ${resetsIn(w.resetsAt, state.now)}`, "muted")]
          : []),
      ]);
    }
  }
  if (!d.limits.length) lines.push(note("No limit windows reported."));
  if (d.credits)
    lines.push([
      s("credits".padEnd(label), "muted"),
      s(
        d.credits.unlimited
          ? "unlimited"
          : d.credits.has
            ? `balance ${creditBalance(d.credits.balance)}`
            : "none",
      ),
    ]);
  if (d.reached)
    lines.push([
      s(
        `${g.cross} limit reached: ${d.reached.replace(/_/g, " ")}`,
        "err bold",
      ),
    ]);
  else if (d.allowed === false)
    lines.push([s(`${g.cross} ordinary usage is not allowed`, "err bold")]);
  if (d.error) lines.push([s(`The last read failed: ${d.error}`, "warn")]);
  return lines;
}

// Every line of a row that names an item opens it on a click.
const linked = (lines, id, width) =>
  lines.map((line) =>
    Object.assign(line, { targets: [{ x: 0, width, jump: id }] }),
  );

function workspaceLines(state, width, g) {
  const list = workspaceRows(state);
  if (!list.length)
    return [note("No workspaces yet: pelican workspace add <folder>")];
  const name = Math.max(...list.map((w) => cells(w.id)));
  const bar = Math.max(6, Math.min(16, Math.floor(width / 6)));
  return list.flatMap((w) =>
    linked(
      wrapFacts(
        [
          ...(w.settings.paused ? [[s("paused", "warn bold")]] : []),
          [s(`${w.queued} queued`, w.queued ? "info" : "muted")],
          [s(`${w.questions} asking`, w.questions ? "warn bold" : "muted")],
          [s(`network ${w.settings.network ? "on" : "off"}`, "muted")],
        ],
        width,
        {
          sep: [` ${g.sep} `, "muted"],
          indent: name + 2,
          lead: [
            s(w.id.padEnd(name), "bold"),
            s("  "),
            ...gauge(w.working, w.settings.concurrency, bar, { g }),
            s(
              ` ${w.working}/${w.settings.concurrency}`.padEnd(7),
              w.working ? "bold" : "muted",
            ),
          ],
        },
      ),
      `ws:${w.id}`,
      width,
    ),
  );
}

// The agents that used the most tokens, as bars.
function leaderLines(state, width, g, count) {
  const agents = [...fleetRows(state)]
    .filter((a) => a.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, count);
  if (!agents.length) return [note("No tokens used yet.")];
  const top = agents[0].tokens;
  const name = Math.max(...agents.map((a) => cells(a.agentName)));
  const bar = Math.max(6, Math.min(30, width - name - 14));
  return agents.flatMap((a, i) => {
    const filled = Math.max(1, Math.round((a.tokens / top) * bar));
    return linked(
      [
        [
          s(`${i + 1} `, i === 0 ? "warn bold" : "muted"),
          s(a.agentName.padEnd(name), "bold"),
          s("  "),
          s(g.full.repeat(filled), i === 0 ? "hot" : "accent"),
          s(g.empty.repeat(bar - filled), "muted"),
          s(` ${tokens(a.tokens).padStart(6)}`),
        ],
      ],
      `agent:${a.id}`,
      width,
    );
  });
}

// Who orchestrates, for a wide overview: live agents, questions, the last
// note.
function orchestratorLines(state, width, g) {
  const rows = orchestrators(state);
  if (!rows.length)
    return [
      note("Nobody has orchestrated yet: callers name themselves (--as)."),
    ];
  return rows.flatMap((r) =>
    linked(
      [
        ...wrapFacts(
          [
            [s(r.name, r.name === state.as ? "accent bold" : "bold")],
            [s(`${r.live.length} live`, r.live.length ? "accent" : "muted")],
            ...(r.questions.length
              ? [[s(`${g.diamond} ${r.questions.length}`, "warn bold")]]
              : []),
            [s(`${tokens(r.tokens)} tokens`, "muted")],
          ],
          width,
          { sep: [` ${g.sep} `, "muted"], indent: 2 },
        ),
        ...noteLines(r.lastNote, width),
      ],
      `orch:${r.name}`,
      width,
    ),
  );
}
// Its last note: three lines of it, and where the rest is.
function noteLines(entry, width) {
  if (!entry) return [];
  const lines = wrap(String(entry.body ?? ""), width - 2);
  return [
    ...lines.slice(0, 3).map((l) => [s(`  ${l}`, "note")]),
    ...(lines.length > 3
      ? [[s(`  ${lines.length - 3} more lines in its timeline`, "muted")]]
      : []),
  ];
}

export function model(state, item, box) {
  const g = glyphsOf(state),
    width = box.room.width,
    status = state.data.status,
    service = status?.service ?? {};
  const title = [s("Overview", "bold")];
  const right = [
    s(
      [
        service.pid ? "pid " + service.pid : null,
        "up " + span(service.uptimeMs ?? 0),
        "as " + state.as,
      ]
        .filter(Boolean)
        .join(" · "),
      "muted",
    ),
  ];
  if (!status)
    return { title, right, body: [note("Reading Pelican’s status.")] };
  const totals = status.totals;
  const graphs = activity(state, width, g, {
    rows: ["agents", "tokens", "events", "asks", "done", "load"],
  });
  const body = [
    ...wrapFacts(
      [
        [s(totals.working + " working", totals.working ? "accent" : "muted")],
        [s(totals.queued + " queued", "muted")],
        [s(totals.questions + " asking", totals.questions ? "warn" : "muted")],
      ],
      width,
      { sep: ["   /   ", "muted"] },
    ),
    ...(state.data.account
      ? [
          [
            s(
              state.data.account.connected
                ? "ChatGPT" +
                    (state.data.account.account?.plan
                      ? " " + state.data.account.account.plan
                      : "") +
                    " · signed in"
                : "Sign in with pelican login",
              state.data.account.connected ? "muted" : "warn",
            ),
          ],
        ]
      : []),
    [],
    section("Codex usage", usageNote(state, g)),
    ...usageLines(state, width, g),
    [],
    section("Activity", "the last hour"),
    ...(graphs.lines ?? graphs),
    [],
    section("Workspaces", String(workspaceRows(state).length)),
    ...workspaceLines(state, width, g),
    [],
    section("Orchestrators", String(orchestrators(state).length)),
    ...orchestratorLines(state, width, g),
    [],
    section("Top tokens"),
    ...leaderLines(state, width, g, 5),
  ];
  return { title, right, body };
}
