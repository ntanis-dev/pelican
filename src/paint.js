import {
  glyphSets,
  pickGlyphs,
  roles,
  statusIcon,
  statusStyle,
} from "./menu/look.js";
import { clean } from "./menu/text.js";

// Colour and glyphs for the command line's readable output (format.js). The
// palette and glyphs are the menu's. They apply only when the output is a
// terminal (or FORCE_COLOR asks): piped output, such as a line monitor, a
// script or a pager, stays the plain text it always was, byte for byte.
// NO_COLOR keeps the layout and glyphs and drops the colour; --plain drops
// both.
const attributes = {
  bold: "1",
  dim: "2",
  italic: "3",
  underline: "4",
  inverse: "7",
  strike: "9",
};
// The 16-colour fallback for each role.
const basic = {
  accent: 36,
  brand: 96,
  beak: 33,
  ok: 32,
  warn: 33,
  err: 31,
  info: 34,
  stop: 35,
  muted: 90,
  note: 36,
  hot: 95,
};
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
function colourCode(role, depth) {
  if (!(role in roles) || depth < 4) return null;
  if (depth >= 24) return `38;2;${rgb(roles[role]).join(";")}`;
  if (depth >= 8) {
    const [r, g, b] = rgb(roles[role]).map((v) => Math.round(v / 51));
    return `38;5;${16 + 36 * r + 6 * g + b}`;
  }
  return basic[role] ? String(basic[role]) : null;
}

// Orchestrator names get a stable colour each, so a feed of several is easy
// to read.
const nameRoles = ["accent", "info", "stop", "hot", "note", "beak", "ok"];
const hash = (text) =>
  [...String(text)].reduce(
    (sum, ch) => (sum * 31 + ch.codePointAt(0)) >>> 0,
    7,
  );

export function makePaint({
  pretty = false,
  color = pretty,
  depth = 24,
  glyphs = "rich",
  columns = 100,
} = {}) {
  const g = glyphSets[glyphs] ?? glyphSets.rich;
  const open = new Map();
  const codes = (style) => {
    let code = open.get(style);
    if (code === undefined) {
      const list = [];
      for (const word of String(style).split(" ")) {
        if (word in attributes) list.push(attributes[word]);
        else {
          const tone = colourCode(word, depth);
          if (tone) list.push(tone);
        }
      }
      open.set(style, (code = list.join(";")));
    }
    return code;
  };
  // Text in a style (space-separated words: bold, dim, a role). Without a
  // terminal it is the text unchanged; with one it is cleaned of whatever
  // control sequences an agent wrote into it.
  const p = (style, text) => {
    const value = String(text ?? "");
    if (!pretty) return value;
    const safe = clean(value);
    const code = color ? codes(style) : "";
    return code
      ? safe
          .split("\n")
          .map((line) => (line ? `\x1b[${code}m${line}\x1b[0m` : line))
          .join("\n")
      : safe;
  };
  p.pretty = pretty;
  p.color = color;
  p.g = g;
  p.columns = columns;
  for (const name of [...Object.keys(roles), ...Object.keys(attributes)])
    p[name] = (text) => p(name, text);
  // Agent-written text on its way to the screen.
  p.safe = (text) => (pretty ? clean(String(text ?? "")) : String(text ?? ""));
  // A number that stands out when it is not zero.
  p.num = (n, role = "accent") => (n ? p(`${role} bold`, n) : p.muted(n));
  p.who = (name) =>
    name
      ? p(`${nameRoles[hash(name) % nameRoles.length]} bold`, name)
      : p.muted("?");
  // The mark and style of an agent's or run's status; a running one is a
  // steady dot here, since a line cannot spin.
  p.mark = (status, questions = 0) => {
    const running = !questions && ["running", "starting"].includes(status);
    const [icon, style] = running
      ? [g.dot, "accent"]
      : statusIcon(status, g, questions);
    return [icon, style.replace(" spin", "")];
  };
  p.statusStyle = (status, questions = 0) =>
    questions ? "warn bold" : statusStyle(status);
  // The text of a status cell, for measuring and padding before it is
  // painted: "● running" on a terminal, just "running" otherwise. A "?" says
  // the agent is asking.
  p.statusText = (status, questions = 0) =>
    `${pretty ? `${p.mark(status, questions)[0]} ` : ""}${status}${questions ? "?" : ""}`;
  p.status = (status, questions = 0) =>
    p(p.statusStyle(status, questions), p.statusText(status, questions));
  // A done thing: "✓ Added workspace ...". Plain output has no mark.
  p.check = (text) => (pretty ? `${p.ok(g.check)} ${text}` : text);
  // A rule with a title: "Agents ───────".
  p.rule = (title, cells = Math.min(columns, 100)) =>
    `${p("accent bold", title)} ${p.muted(g.corners.h.repeat(Math.max(3, cells - title.length - 1)))}`;
  // How loaded something is, as a role: ok, warn, err.
  p.load = (percent) => (percent >= 90 ? "err" : percent >= 70 ? "warn" : "ok");
  // A bar of `cells` that fills with a percentage, warmer as it nears full.
  p.bar = (percent, cells = 16) => {
    const filled = Math.round(
      (Math.min(100, Math.max(0, percent)) / 100) * cells,
    );
    return (
      p(p.load(percent), g.full.repeat(filled)) +
      p.muted(g.empty.repeat(cells - filled))
    );
  };
  return p;
}

export const plain = makePaint();

// The paint for a stream: pretty when it is a terminal (or FORCE_COLOR is
// set), with the colour depth the terminal reports.
export function detectPaint(
  stream = process.stdout,
  env = process.env,
  { plain: off = false } = {},
) {
  if (off) return plain;
  const force = env.FORCE_COLOR;
  const forcedOff = force === "0" || force === "false";
  const forcedOn = force !== undefined && !forcedOff;
  if (!forcedOn && (!stream?.isTTY || env.TERM === "dumb")) return plain;
  let depth = 1;
  if (!forcedOff && (forcedOn || !env.NO_COLOR))
    depth =
      forcedOn && ["1", "2", "3"].includes(force)
        ? [4, 8, 24][Number(force) - 1]
        : typeof stream?.getColorDepth === "function"
          ? stream.getColorDepth(env)
          : forcedOn
            ? 4
            : 1;
  return makePaint({
    pretty: true,
    color: depth > 1,
    depth,
    glyphs: pickGlyphs(env),
    columns: stream?.columns || 100,
  });
}
