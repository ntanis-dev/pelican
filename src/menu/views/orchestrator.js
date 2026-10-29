import { s, wrapFacts, wrapLine } from "../lines.js";
import { ago, plural, tokens } from "../text.js";
import { orchestratorByName } from "../state.js";
import { glyphsOf } from "../tree.js";
import { entryBody, eventIcon, note } from "./common.js";

// One orchestrator: a line of what it has (live agents, questions waiting
// for it, tokens, its last action), then its timeline, newest at the
// bottom and live: its notes (what it is doing and why), what it did
// (spawned, messaged, answered, stopped, ran a workflow) and what its agents
// sent it (questions, notes, reports, finishes).
function statsLine(state, r, g) {
  if (!r) return [[s("No agents yet.", "muted")]];
  const parts = [
    [
      s(
        plural(r.live.length, "live agent"),
        r.live.length ? "accent" : "muted",
      ),
      s(` of ${r.agents}`, "muted"),
    ],
    r.questions.length
      ? [
          s(
            `${g.diamond} ${plural(r.questions.length, "question")} waiting`,
            "warn bold",
          ),
        ]
      : null,
    [s(`${tokens(r.tokens)} tokens`, "muted")],
    r.lastAction
      ? [
          s(`last ${ago(r.lastAction.at, state.now)}: `, "muted"),
          s(actionTitle(r.lastAction)),
        ]
      : null,
  ].filter(Boolean);
  return parts;
}

// What an action was, said once: the journal's "messaged X (steer,
// steered)" is "steered X".
const deliveries = {
  steered: (x) => `steered ${x}`,
  followup: (x) => `sent ${x} a followup`,
  pending: (x) => `messaged ${x} for its next turn`,
  queued: (x) => `added to the brief of ${x}`,
  resumed: (x) => `resumed ${x} with a message`,
};
export function actionTitle(e) {
  if (e.type !== "message.sent") return e.title;
  const agent =
    e.agentName ?? e.data?.agentName ?? String(e.jobId ?? "").slice(0, 8);
  return (deliveries[e.data?.delivery] ?? ((x) => `messaged ${x}`))(agent);
}
const titleTone = (e) =>
  e.type === "agent.question"
    ? "warn bold"
    : e.type === "agent.report"
      ? "ok bold"
      : e.type === "job.finished" && /failed|blocked/.test(e.data?.status ?? "")
        ? "err"
        : e.kind === "run"
          ? "hot"
          : "";

// A timeline entry as a chat entry. A note is the orchestrator's own
// words; the rest are a title and what it said.
export function timelineEntry(e, g, { multi = false } = {}) {
  const tag = multi ? [s(e.workspace, "muted")] : [];
  const base = {
    key: `${e.workspace}#${e.seq}`,
    sig: `${e.workspace}#${e.seq}`,
    at: e.at,
    tag,
  };
  if (e.kind === "note") {
    const [first, ...rest] = String(e.body ?? "").split("\n");
    return {
      ...base,
      icon: s(g.bullet, "note"),
      title: [s(first, "note")],
      body: rest.join("\n").trim() || null,
      bodyStyle: "note",
    };
  }
  const [icon, style] = eventIcon({ type: e.type, data: e.data }, g);
  return {
    ...base,
    icon: s(icon, style),
    title: [s(actionTitle(e), titleTone(e))],
    body: e.body || null,
    bodyStyle: e.kind === "agent" ? "" : "muted",
  };
}

export function model(state, item, box) {
  const g = glyphsOf(state);
  const r = orchestratorByName(state, item.name);
  const data = state.cache[item.key];
  const width = box.room.width;
  const head = wrapFacts(statsLine(state, r, g), width, {
    sep: [` ${g.sep} `, "muted"],
    indent: 2,
  });
  if (data?.error) head.push(...wrapLine([s(data.error, "err")], width));
  if (box.room.height >= 12) head.push([]);
  const title = [
    s(item.name, item.name === state.as ? "accent bold" : "bold"),
    ...(item.name === state.as ? [s(" (you)", "muted")] : []),
  ];
  // The workspace is named only when the timeline spans several.
  const multi = new Set((data?.entries ?? []).map((e) => e.workspace)).size > 1;
  const entries = (data?.entries ?? []).map((e) =>
    timelineEntry(e, g, { multi }),
  );
  if (!entries.length)
    return {
      title,
      head,
      live: true,
      body: [
        note(
          !data || data.cursor === null
            ? "Reading its timeline."
            : "Nothing in its timeline yet. Orchestrators narrate with pelican note.",
        ),
      ],
    };
  return {
    title,
    head,
    live: true,
    ...entryBody(entries, width, {
      expanded: state.expanded[item.key] ?? [],
      g,
      scope: item.key,
    }),
  };
}
