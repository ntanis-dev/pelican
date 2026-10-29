import { createElement, memo } from "react";
import { Box, Text, useAnimation } from "ink";
import { fitLine, lineWidth, s } from "../lines.js";
import { useTheme } from "../theme.js";

// The building blocks the views draw with (no JSX: createElement as h).
export const h = createElement;

// A spinner frame: Ink's shared animation timer drives every spinner at
// once. Outside a terminal (tests) it stays on its first frame.
export function Spinner({ style = "ok" }) {
  const theme = useTheme();
  const { frame } = useAnimation({ interval: 100 });
  const frames = theme.g.spinner;
  return h(Text, theme.props(style), frames[frame % frames.length]);
}

// One line of spans. A span styled "spin" is a spinner.
export const Line = memo(function Line({ line }) {
  const theme = useTheme();
  return h(
    Text,
    { wrap: "truncate-end", ...theme.props("text") },
    ...line.flatMap(([text, style], i) => {
      if (!/\bspin\b/.test(style) || !/\S/.test(text))
        return [
          h(
            Text,
            { key: i, ...theme.props(style.replace(/\bspin\b/, "").trim()) },
            text,
          ),
        ];
      // The spinner takes the glyph's cell; the spaces around it stay.
      const [, lead = "", trail = ""] = /^(\s*)\S?(\s*)$/u.exec(text) ?? [];
      const own = style.replace(/\bspin\b/, "").trim();
      return [
        ...(lead ? [h(Text, { key: `${i}<` }, lead)] : []),
        h(Spinner, { key: i, style: own }),
        ...(trail ? [h(Text, { key: `${i}>` }, trail)] : []),
      ];
    }),
  );
});
// Lines in a column of fixed height (empty rows below them).
export function Lines({ lines, width, height }) {
  const shown = height === undefined ? lines : lines.slice(0, height);
  return h(
    Box,
    { flexDirection: "column", width, height, overflow: "hidden" },
    ...shown.map((line, i) =>
      h(Line, { key: i, line: width ? fitLine(line, width) : line }),
    ),
  );
}

// A panel's top or bottom edge with text in it: "╭─ Title ────── 3 of 9 ─╮".
export function edge(
  theme,
  { width, left = [], right = [], top = true, style = "muted" },
) {
  const c = theme.g.corners;
  const [a, b] = top ? [c.tl, c.tr] : [c.bl, c.br];
  const leftPart = left.length
    ? [s(`${c.h} `, style), ...left, s(" ", style)]
    : [];
  const rightPart = right.length
    ? [s(" ", style), ...right, s(` ${c.h}`, style)]
    : [];
  let room = width - 2 - lineWidth(rightPart) - lineWidth(leftPart);
  let shownLeft = leftPart;
  if (room < 1) {
    // The left text gives way first.
    shownLeft = leftPart.length
      ? fitLine(leftPart, Math.max(0, width - 3 - lineWidth(rightPart)))
      : [];
    room = width - 2 - lineWidth(rightPart) - lineWidth(shownLeft);
  }
  const line = [
    s(a, style),
    ...shownLeft,
    s(c.h.repeat(Math.max(0, room)), style),
    ...(room >= 0 ? rightPart : []),
    s(b, style),
  ];
  return fitLine(line, width);
}

// A bordered panel: title and a note in the top edge, a note in the bottom
// edge (scroll positions), and content `width - 2 - 2 * pad` wide and
// `height - 2` tall. The focused panel's border is in the accent colour,
// the other one's dim.
export function Panel({
  title = [],
  right = [],
  footer = [],
  footerRight = [],
  width,
  height,
  active = false,
  tone,
  pad = 1,
  children,
}) {
  const theme = useTheme();
  const style = tone ?? (active ? "accent" : "muted");
  return h(
    Box,
    { flexDirection: "column", width, height, flexShrink: 0 },
    h(Line, { line: edge(theme, { width, left: title, right, style }) }),
    h(
      Box,
      {
        flexDirection: "column",
        width,
        height: Math.max(0, height - 2),
        borderStyle: theme.g.border,
        borderTop: false,
        borderBottom: false,
        borderColor: theme.tone(style),
        paddingX: pad,
        overflow: "hidden",
      },
      children,
    ),
    h(Line, {
      line: edge(theme, {
        width,
        left: footer,
        right: footerRight,
        top: false,
        style,
      }),
    }),
  );
}
// Panels next to each other, or under each other.
export const Row = ({ children, height, width }) =>
  h(Box, { flexDirection: "row", height, width, flexShrink: 0 }, children);
export const Column = ({ children, height, width }) =>
  h(Box, { flexDirection: "column", height, width, flexShrink: 0 }, children);
