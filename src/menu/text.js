// Text for the terminal. What agents and orchestrators write is cleaned of
// control sequences before it reaches the screen, measured in terminal cells
// (wide CJK and emoji take two, combining marks none) and cut, padded or
// wrapped to fit.
const escapes =
  // CSI, OSC (ended by BEL or ST), and two-byte escapes.
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const zeroWidth = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

// Keeps newlines; tabs become two spaces.
export function clean(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(escapes, "")
    .replace(/\t/g, "  ")
    .replace(controls, "");
}
export const oneLine = (text) => clean(text).replace(/\s+/g, " ").trim();

function wide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (zeroWidth.test(ch)) return 0;
  return wide(cp) ? 2 : 1;
}
export function width(text) {
  let cells = 0;
  for (const ch of String(text)) cells += charWidth(ch);
  return cells;
}

// At most `cells` wide; a cut ends with an ellipsis.
export function cut(text, cells) {
  const value = String(text ?? "");
  if (cells <= 0) return "";
  if (width(value) <= cells) return value;
  let out = "",
    used = 0;
  for (const ch of value) {
    const w = charWidth(ch);
    if (used + w > cells - 1) break;
    out += ch;
    used += w;
  }
  return out + "…";
}
// Exactly `cells` wide: cut, then padded with spaces.
export function fit(text, cells) {
  const value = cut(text, cells);
  return value + " ".repeat(Math.max(0, cells - width(value)));
}
export function fitLeft(text, cells) {
  const value = cut(text, cells);
  return " ".repeat(Math.max(0, cells - width(value))) + value;
}

// Word wrap to `cells`, keeping blank lines and each line's leading
// spaces; a word longer than a line is broken. `indent` prefixes
// continuation lines.
export function wrap(text, cells, indent = "") {
  const out = [];
  const room = Math.max(1, cells);
  for (const paragraph of clean(text).split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    const lead = paragraph.match(/^ */)[0].slice(0, Math.floor(room / 2));
    const next = lead + indent;
    let line = "",
      used = 0,
      first = true;
    const prefix = () => (first ? lead : next);
    const limit = () => Math.max(1, room - width(prefix()));
    const flush = () => {
      out.push(prefix() + line);
      first = false;
      line = "";
      used = 0;
    };
    for (const word of paragraph.trim().split(/ +/)) {
      const w = width(word);
      if (used && used + 1 + w > limit()) flush();
      if (w > limit()) {
        for (const ch of word) {
          const cw = charWidth(ch);
          if (used + cw > limit()) flush();
          line += ch;
          used += cw;
        }
        continue;
      }
      line += (used ? " " : "") + word;
      used += (used ? 1 : 0) + w;
    }
    if (line) flush();
  }
  return out;
}

// Readable amounts for the screen.
export function ago(iso, now) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return `${span(ms)} ago`;
}
export function span(ms) {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
// Local wall-clock time: 15:20, or "Sat 09:00" when not today, or "Oct 30"
// when more than a week away.
export const tokens = (n) =>
  !n
    ? "0"
    : n < 1000
      ? String(n)
      : n < 1e6
        ? `${(n / 1000).toFixed(1)}k`
        : `${(n / 1e6).toFixed(2)}M`;
export const clock = (iso) => String(iso ?? "").slice(11, 19);
export const hhmm = (iso) => String(iso ?? "").slice(11, 16);
export const short = (id) => String(id ?? "").slice(0, 8);
export const plural = (n, word, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;
