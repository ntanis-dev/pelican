import { cutSpans, lineWidth, s, spread, wrapLine } from "../lines.js";
import { hhmm, wrap } from "../text.js";
import { codeLines, proseLines } from "../syntax.js";
import { statusIcon } from "../theme.js";
import { toast } from "../state.js";

// Pieces every pane uses: the effect descriptors the runtime carries out,
// and the entries of chats, timelines and feeds.
export const refresh = { type: "refresh" };
export const call = (method, params, done) => ({
  type: "call",
  method,
  params,
  done,
});
export const result = (state, effects = []) => ({ state, effects });
export const notice = (state, text, tone = "info") =>
  result(toast(state, text, tone));
export const note = (text, style = "muted") => [s(text, style)];

export function sectionRule(title, width, g, extra = "") {
  const label = [s(title.toUpperCase(), "muted bold"), s("  ")];
  const right =
    extra && lineWidth(label) + extra.length + 4 <= width
      ? [s(" " + extra, "muted")]
      : [];
  return [
    ...label,
    s(
      g.corners.h.repeat(
        Math.max(0, width - lineWidth(label) - lineWidth(right)),
      ),
      "divider",
    ),
    ...right,
  ];
}

// A titled block of text, wrapped: a bold heading and the text under it. With
// rich, what an agent wrote is coloured (its paths, `code` and links).
export const block = (title, text, width, style = "", rich = false) => [
  [s(title, "bold")],
  ...(rich
    ? proseLines(text ?? "", style).flatMap((line) =>
        wrapLine(line, Math.max(1, width - 2)).map((l) => [s("  "), ...l]),
      )
    : wrap(String(text ?? ""), Math.max(1, width - 2)).map((l) => [
        s(`  ${l}`, style),
      ])),
  [],
];
// A section heading inside a pane, with a dim note after it.
export const section = (title, extra = "") =>
  Object.assign(
    [s(title, "bold"), ...(extra ? [s("  " + extra, "muted")] : [])],
    { section: { title, extra } },
  );

// An entry of a chat, a timeline or a feed: the time in a gutter, a title
// (an icon, words, a tag such as the workspace), and a body under it. All
// of it wraps; nothing is cut. A fold entry (a command, an edit) shows only
// its title until it is expanded, then its detail(width) lines beside a rail.
//
// A fold entry with a summary is one line whatever it holds: the title (a
// verb), the summary (spans, or text and a style; cut with an ellipsis to the
// room that is left) and `right` (a status, never cut) at the right edge.
// Opening it shows it whole.
//
// A body is plain text, or coloured with rich: true (what an agent wrote:
// paths, `code`, links) or rich: "code" (a program, JSON).
//
// { key, at, icon: span?, title: spans, tag: spans?, body: text?, bodyStyle,
//   rich: true | "code"?, fold: boolean, summary: { spans | text, style }?,
//   right: spans?, rail: style?, detail(width) -> lines,
//   sig: string? (caches its lines) }
export const gutter = 6;
const summaryRoom = 12;
function foldHead(entry, lead, width) {
  const right = entry.right ?? [],
    chip = right.length ? lineWidth(right) + 2 : 0,
    rest = width - lineWidth(lead) - 2;
  // A chip that would squeeze the summary below a few words is left out; the
  // opened entry says it too.
  const showChip = chip > 0 && rest - chip >= summaryRoom;
  const summary = entry.summary.spans ?? [
    [entry.summary.text ?? "", entry.summary.style ?? ""],
  ];
  const left = [
    ...lead,
    s("  "),
    ...cutSpans(summary, Math.max(1, rest - (showChip ? chip : 0))),
  ];
  return [showChip ? spread(left, right, width) : left];
}
export function entryLines(entry, width, expanded = false, g) {
  const fold = entry.fold
    ? [s(expanded ? `${g.open} ` : `${g.closed} `, "muted")]
    : [];
  const lead = [
    s(`${hhmm(entry.at).padEnd(5)} `, "muted"),
    ...fold,
    ...(entry.icon ? [entry.icon, s(" ")] : []),
    ...entry.title,
  ];
  const head = entry.summary
    ? foldHead(entry, lead, width)
    : wrapLine(
        [...lead, ...(entry.tag?.length ? [s("  "), ...entry.tag] : [])],
        width,
        gutter + (entry.fold ? 2 : 0),
      );
  const lines = [...head];
  if (entry.body) {
    const room = Math.max(1, width - gutter),
      pad = s(" ".repeat(gutter));
    if (entry.rich) {
      const coloured =
        entry.rich === "code"
          ? codeLines(entry.body)
          : proseLines(entry.body, entry.bodyStyle ?? "");
      for (const line of coloured)
        for (const wrapped of wrapLine(line, room))
          lines.push([pad, ...wrapped]);
    } else
      for (const l of wrap(entry.body, room))
        lines.push([pad, s(l, entry.bodyStyle ?? "")]);
  }
  if (entry.fold && expanded && entry.detail) {
    const room = Math.max(1, width - gutter - 2);
    const rail = [
      s(" ".repeat(gutter)),
      s(`${g.corners.v} `, entry.rail ?? "muted"),
    ];
    for (const l of entry.detail(room)) lines.push([...rail, ...l]);
  }
  return { lines, head: head.length };
}
// Wrapping every entry again on each frame is the slow part of a long
// conversation: an entry's lines are kept while it, the width and its
// expansion stay the same.
const cache = new Map();
const cacheLimit = 5000;
// scope names the pane: entries of different panes may share keys (every
// agent's journal starts at 1).
function cachedLines(scope, entry, width, expanded, g) {
  if (!entry.sig || !scope) return entryLines(entry, width, expanded, g);
  const id = `${scope}|${entry.key}|${entry.sig}|${width}|${expanded ? 1 : 0}|${g.open}`;
  let out = cache.get(id);
  if (!out) {
    if (cache.size >= cacheLimit) cache.clear();
    cache.set(id, (out = entryLines(entry, width, expanded, g)));
  }
  return out;
}
// Entries as one scrolling body: its lines, where each fold entry's title
// starts (and how many lines it takes), and how many entries there are.
export function entryBody(entries, width, { expanded = [], g, scope = null }) {
  const open = new Set(expanded);
  const lines = [],
    folds = [];
  for (const entry of entries) {
    const own = cachedLines(scope, entry, width, open.has(entry.key), g);
    if (entry.fold)
      folds.push({
        line: lines.length,
        size: own.head,
        end: lines.length + own.lines.length,
        key: entry.key,
      });
    for (const line of own.lines) lines.push(line);
  }
  return { body: lines, folds, entries: entries.length };
}

// How a journal entry looks in the feeds: an icon and a tone.
export function eventIcon(event, g) {
  switch (event.type) {
    case "job.created":
      return ["+", "accent"];
    case "job.started":
      return [g.closed, "accent"];
    case "job.finished":
    case "job.recovered":
      return statusIcon(event.data?.status, g);
    case "job.cancelled":
    case "job.stopRequested":
      return [g.square, "muted"];
    case "job.resumed":
    case "job.retrying":
      return [g.closed, "accent"];
    case "job.restarting":
    case "job.overloaded":
    case "job.throttled":
      return [g.closed, "warn"];
    case "job.owner":
      return [g.arrow, "hot"];
    case "agent.question":
      return [g.diamond, "warn bold"];
    case "agent.answered":
      return [g.check, "accent"];
    case "agent.message":
      return [g.bullet, "note"];
    case "agent.report":
      return [g.check, "ok bold"];
    case "message.sent":
      return [g.right, "accent"];
    case "settings.updated":
      return [g.dot, "info"];
    case "warning":
    case "scheduler.error":
      return ["!", "err bold"];
    case "orchestrator.note":
      return [g.bullet, "note"];
    default:
      return event.type?.startsWith("run.")
        ? [g.current, "hot"]
        : [g.sep, "muted"];
  }
}
export const eventTone = (type) =>
  ({
    "agent.question": "warn",
    "agent.report": "ok",
    "job.cancelled": "muted",
    "job.stopRequested": "muted",
    warning: "err",
    "scheduler.error": "err",
    "settings.updated": "info",
  })[type] ?? "";
