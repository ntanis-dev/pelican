import { charWidth, clean, width } from "./text.js";

// Dense content (the sidebar, chats, logs, feeds) is built as lines of
// spans, [text, style], measured in terminal cells; ui/kit.js draws them
// with Ink. A style is space-separated words (theme.js): bold, dim, italic,
// underline, inverse, selected, spin, and colour names or the theme's roles
// (accent, ok, warn, err, info, stop, muted, brand, ...).
export const s = (text, style = "") => [clean(text).replace(/\n/g, " "), style];
export const lineWidth = (line) =>
  line.reduce((sum, [text]) => sum + width(text), 0);

// Exactly `cells` wide: padded, or (the last resort, for a line that was
// not made to fit) cut with an ellipsis. The pad takes `fill`'s style, so a
// selected row is highlighted to the edge.
export function fitLine(line, cells, fill = "") {
  const out = [];
  let used = 0;
  for (const [text, style] of line) {
    if (used >= cells) break;
    const w = width(text);
    if (used + w <= cells) {
      out.push([text, style]);
      used += w;
      continue;
    }
    let part = "";
    for (const ch of text) {
      const cw = charWidth(ch);
      if (used + cw > cells) break;
      part += ch;
      used += cw;
    }
    out.push([part, style]);
    break;
  }
  if (used < cells) out.push([" ".repeat(cells - used), fill]);
  return out;
}

// A line cut to `cells`, its styles kept, with an ellipsis (in the style of
// the text it follows) where something was cut.
export function cutSpans(line, cells) {
  if (cells <= 0) return [];
  if (lineWidth(line) <= cells) return line;
  const out = [];
  let used = 0;
  for (const [text, style] of line) {
    let kept = "";
    for (const ch of text) {
      const w = charWidth(ch);
      if (used + w > cells - 1) {
        if (kept) out.push([kept, style]);
        out.push(["…", style]);
        return out;
      }
      kept += ch;
      used += w;
    }
    out.push([kept, style]);
  }
  return out;
}
// Left and right parts on one line of `cells`, the gap between them padded.
// Callers make them fit; a right part that does not is left out.
export function spread(left, right, cells, fill = "") {
  const room = cells - lineWidth(right);
  if (!right.length || room < lineWidth(left) + 1)
    return fitLine(left, cells, fill);
  return [...fitLine(left, room, fill), ...right];
}
// Every span of a line in one style (a selected row keeps bold, and its
// spinner spins).
const kept = ["bold", "spin"];
export const restyle = (line, style) =>
  line.map(([text, own]) => {
    const words = String(own).split(" ");
    const extra = kept.filter(
      (w) => words.includes(w) && !style.split(" ").includes(w),
    );
    return [text, [style, ...extra].join(" ")];
  });
export const plain = (line) => line.map(([text]) => text).join("");

// A line of spans wrapped to `cells`: at spaces where it can, inside a word
// that is longer than a line. Continuation lines start with `indent`
// spaces; styles stay with their text. Nothing is cut.
const breaks = new Set(["-", "/", "\\", ":", "_", "."]);
export function wrapLine(line, cells, indent = 0) {
  const room = Math.max(1, cells);
  const lead = Math.min(indent, Math.max(0, room - 1));
  const tokens = [];
  for (const [text, style] of line)
    for (const part of String(text).split(/( +)/))
      if (part) tokens.push([part, style]);
  const out = [];
  let current = [],
    used = 0;
  const atStart = () => used === (out.length ? lead : 0);
  const flush = () => {
    // Spaces at a break are dropped.
    while (current.length && /^ +$/.test(current.at(-1)[0])) {
      used -= width(current.at(-1)[0]);
      current.pop();
    }
    out.push(current);
    current = lead ? [[" ".repeat(lead), ""]] : [];
    used = lead;
  };
  const space = (token) => /^ +$/.test(token[0]);
  for (let i = 0; i < tokens.length; i++) {
    const [text, style] = tokens[i];
    const w = width(text);
    if (space(tokens[i])) {
      if (out.length && atStart()) continue;
      if (used + w > room) {
        flush();
        continue;
      }
      current.push([text, style]);
      used += w;
      continue;
    }
    // A word that fits a line of its own goes to the next line. A word may
    // be several spans (a path in one colour, the comma after it in another):
    // it moves whole.
    if (i === 0 || space(tokens[i - 1])) {
      let whole = w;
      for (let j = i + 1; j < tokens.length && !space(tokens[j]); j++)
        whole += width(tokens[j][0]);
      if (used + whole > room && !atStart() && whole <= room - lead) flush();
    }
    if (used + w <= room) {
      current.push([text, style]);
      used += w;
      continue;
    }
    // A word longer than a whole line starts where it is and breaks after
    // a - / : _ or . where it can, else where the line ends.
    let rest = [...text];
    while (rest.length) {
      let cells = 0,
        fits = 0,
        mark = 0;
      for (const ch of rest) {
        cells += charWidth(ch);
        if (used + cells > room) break;
        fits++;
        if (breaks.has(ch)) mark = fits;
      }
      if (fits === rest.length) {
        current.push([rest.join(""), style]);
        used += cells;
        break;
      }
      // No place to break left on a line with text: begin on the next one.
      if (!mark && !atStart()) {
        flush();
        continue;
      }
      const take = mark || fits || 1;
      current.push([rest.slice(0, take).join(""), style]);
      used += width(rest.slice(0, take).join(""));
      rest = rest.slice(take);
      flush();
    }
  }
  if (current.length && !(out.length && atStart())) flush();
  return out.length ? out : [[]];
}
// Facts (each a list of spans) on lines `cells` wide, a separator between
// them. A line breaks between two facts, so no separator starts or ends a
// line; a fact longer than a whole line wraps on its own. `lead` starts the
// first line, `indent` spaces the others.
export function wrapFacts(
  facts,
  cells,
  { sep = [" · ", "muted"], indent = 0, lead = [] } = {},
) {
  const room = Math.max(1, cells);
  const out = [];
  let line = [...lead],
    used = lineWidth(lead),
    filled = false;
  const pad = () => (indent ? [[" ".repeat(indent), ""]] : []);
  for (const fact of facts) {
    if (!fact?.length) continue;
    const w = lineWidth(fact);
    if (filled && used + width(sep[0]) + w > room) {
      out.push(line);
      line = pad();
      used = indent;
      filled = false;
    } else if (filled) {
      line.push(sep);
      used += width(sep[0]);
    }
    if (used + w > room) {
      const parts = wrapLine([...line, ...fact], room, indent);
      out.push(...parts.slice(0, -1));
      line = parts.at(-1);
      used = lineWidth(line);
    } else {
      line.push(...fact);
      used += w;
    }
    filled = true;
  }
  out.push(line);
  return out;
}
// Several span lines, each wrapped.
export const wrapLines = (lines, cells, indent = 0) =>
  lines.flatMap((line) => wrapLine(line, cells, indent));
