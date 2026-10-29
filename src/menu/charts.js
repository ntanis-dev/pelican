import { lineWidth, s, wrapLine } from "./lines.js";
import { width as cells } from "./text.js";

// Graphs as spans: sparklines, activity strips, gauges, progress bars and a
// phase stepper. g is the theme's glyph set.

// Runs of equal style become one span.
function runs(chars) {
  const spans = [];
  let text = "",
    style = null;
  for (const [ch, st] of chars) {
    if (st !== style && text) {
      spans.push(s(text, style));
      text = "";
    }
    style = st;
    text += ch;
  }
  if (text) spans.push(s(text, style));
  return spans;
}
const levelOf = (v, top, steps) =>
  v > 0 && top > 0
    ? 1 + Math.min(steps - 1, Math.floor((v / top) * (steps - 0.001)))
    : 0;

// The newest `width` values (the oldest on the left), padded on the left
// when there are fewer. Zero is the baseline (muted); any activity is at
// least a step above it.
export function spark(
  values = [],
  width = values.length,
  { g, style = "accent", max } = {},
) {
  const shown = values.slice(-width);
  const top = max ?? Math.max(0, ...shown);
  const pad = Math.max(0, width - shown.length);
  return runs([
    ...Array.from({ length: pad }, () => [g.ticks[0], "muted"]),
    ...shown.map((v) => {
      const level = levelOf(v, top, g.ticks.length - 1);
      return [g.ticks[level], level ? style : "muted"];
    }),
  ]);
}
// A bar chart `height` rows tall of the newest `width` values, the scale
// on the left: lines, the top row first.
export function chart(
  values = [],
  width,
  height,
  { g, style = "accent", label = compact } = {},
) {
  const axis = Math.max(cells(label(Math.max(0, ...values))), 1) + 1;
  const room = Math.max(1, width - axis - 1);
  const shown = values.slice(-room);
  const top = Math.max(0, ...shown);
  const steps = g.bars.length;
  const units = height * steps;
  const levels = shown.map((v) =>
    v > 0 && top > 0 ? Math.max(1, Math.round((v / top) * units)) : 0,
  );
  const lines = [];
  for (let row = height - 1; row >= 0; row--) {
    const tag = row === height - 1 ? label(top) : row === 0 ? "0" : "";
    const chars = levels.map((n) => {
      const filled = n - row * steps;
      if (filled >= steps) return [g.bars[steps - 1], style];
      if (filled > 0) return [g.bars[filled - 1], style];
      return [row === 0 ? g.ticks[0] : " ", "muted"];
    });
    lines.push([
      s(tag.padStart(axis - 1), "muted"),
      s(row === height - 1 ? " ┤" : row === 0 ? " ┴" : " │", "muted"),
      ...runs(chars),
    ]);
  }
  return lines;
}
// One cell per bucket, shaded by how busy it was.
export function strip(
  values = [],
  width = values.length,
  { g, style = "accent", max } = {},
) {
  const shown = values.slice(-width);
  const top = max ?? Math.max(0, ...shown);
  const pad = Math.max(0, width - shown.length);
  return runs([
    ...Array.from({ length: pad }, () => [g.shades[0], "muted"]),
    ...shown.map((v) => {
      const level = levelOf(v, top, g.shades.length - 1);
      return [g.shades[level], level ? style : "muted"];
    }),
  ]);
}
// value of limit as a bar: green while there is room, yellow when full.
export function gauge(value, limit, width, { g, style } = {}) {
  const shown = Math.max(0, Math.min(value, limit));
  let filled = limit > 0 ? Math.round((shown / limit) * width) : 0;
  if (value > 0 && !filled) filled = 1;
  const tone = style ?? (!value ? "muted" : value >= limit ? "warn" : "ok");
  return [
    ...(filled ? [s(g.full.repeat(filled), tone)] : []),
    ...(width - filled > 0 ? [s(g.empty.repeat(width - filled), "muted")] : []),
  ];
}
// A run's agents: done, failed and live parts of the bar.
export function progress(
  { done = 0, failed = 0, live = 0, total = 0 } = {},
  width,
  { g } = {},
) {
  if (!total) return [s(g.empty.repeat(width), "muted")];
  const part = (n) => Math.round((n / total) * width);
  let d = part(done),
    f = part(failed),
    l = part(live);
  if (done && !d) d = 1;
  if (failed && !f) f = 1;
  if (live && !l) l = 1;
  while (d + f + l > width) {
    if (l > (live ? 1 : 0)) l--;
    else if (d > (done ? 1 : 0)) d--;
    else f--;
  }
  return [
    ...(d ? [s(g.full.repeat(d), "ok")] : []),
    ...(f ? [s(g.full.repeat(f), "err")] : []),
    ...(l ? [s(g.full.repeat(l), "accent dim")] : []),
    ...(width - d - f - l > 0
      ? [s(g.empty.repeat(width - d - f - l), "muted")]
      : []),
  ];
}

// A run's phases: done ones checked (or crossed when an agent failed), the
// current one marked, those to come open, joined by lines; as lines.
const settled = new Set([
  "completed",
  "replayed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
]);
const failing = new Set(["failed", "cancelled", "interrupted", "blocked"]);
export function phaseStates(phases = []) {
  const started = phases.map((p) => (p.agents ?? []).length > 0);
  const lastStarted = started.lastIndexOf(true);
  return phases.map((p, i) => {
    const agents = p.agents ?? [];
    if (!agents.length) return i < lastStarted ? "skipped" : "pending";
    if (agents.some((a) => !settled.has(a.status))) return "current";
    if (agents.some((a) => failing.has(a.status))) return "failed";
    return i === lastStarted ? "last" : "done";
  });
}
export function stepper(phases = [], width, { g, runStatus } = {}) {
  const states = phaseStates(phases);
  const finished = runStatus && runStatus !== "running";
  const mark = (state) => {
    switch (state) {
      case "current":
        return [g.current, "accent bold"];
      case "failed":
        return [g.cross, "err"];
      case "done":
        return [g.check, "ok"];
      case "last":
        return finished ? [g.check, "ok"] : [g.current, "accent bold"];
      case "skipped":
        return [g.ring, "muted"];
      default:
        return [g.ring, "muted"];
    }
  };
  const parts = phases.map((p, i) => {
    const [icon, style] = mark(states[i]);
    const active =
      states[i] === "current" || (states[i] === "last" && !finished);
    return [
      s(`${icon} `, style),
      s(
        p.title ?? `Phase ${i + 1}`,
        active ? "bold" : states[i] === "pending" ? "muted" : "",
      ),
    ];
  });
  const join = (i) =>
    s(
      ` ${(states[i] === "pending" ? g.empty : g.full).repeat(2)} `,
      states[i] === "pending" ? "muted" : "ok",
    );
  // Lines `width` wide that break between phases, each phase with the line
  // to the next one: a title is never split or cut (a phase longer than a
  // whole line wraps on its own).
  const units = parts.map((part, i) => [
    ...part,
    ...(i < parts.length - 1 ? [join(i + 1)] : []),
  ]);
  const lines = [];
  let current = [];
  const flush = () => {
    const last = current.at(-1);
    if (last) current[current.length - 1] = [last[0].trimEnd(), last[1]];
    lines.push(...wrapLine(current, width, 2));
    current = [];
  };
  for (const unit of units) {
    if (current.length && lineWidth(current) + lineWidth(unit) > width) flush();
    current.push(...unit);
  }
  if (current.length) flush();
  return lines;
}

// Compact numbers for rates and totals.
export function compact(n) {
  if (!n) return "0";
  if (n < 1000) return String(Math.round(n * 10) / 10);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e5 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}
