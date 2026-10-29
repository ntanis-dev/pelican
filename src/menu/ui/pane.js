import { Box } from "ink";
import { fitLine, lineWidth, restyle, s, spread } from "../lines.js";
import { useTheme } from "../theme.js";
import { currentItem, paneModel, paneWindow } from "../pane.js";
import { paneHeaderRows } from "../layout.js";
import { legendLine } from "../legend.js";
import { h, Lines } from "./kit.js";

export function tabsModel(model, width) {
  const line = [],
    targets = [];
  if (!model.tabs) return { line, targets };
  model.tabs.list.forEach((label, index) => {
    const x = lineWidth(line),
      active = index === model.tabs.index;
    const own = [s(" " + label + " ", active ? "selected bold" : "muted")];
    if (x + lineWidth(own) > width) return;
    line.push(...own, s(" "));
    targets.push({ x, y: 3, width: lineWidth(own), tab: index });
  });
  return { line, targets };
}

export function RightPane({ state, box }) {
  const theme = useTheme(),
    item = currentItem(state);
  const model = paneModel(state, item, box),
    w = paneWindow(state, model, box);
  const width = box.room.width,
    focused = state.focus === "pane";
  const body = w.lines.map((line, i) =>
    focused &&
    w.current &&
    w.top + i >= w.current.line &&
    w.top + i < w.current.line + w.current.size
      ? fitLine(restyle(line, "selected bold"), width, "selected bold")
      : line,
  );
  const status = model.live
    ? w.follow
      ? [s(theme.g.dot + " Live", "ok")]
      : w.fresh
        ? [s(theme.g.down + " " + w.fresh + " new", "warn")]
        : [s("Paused", "muted")]
    : [];
  const right = [
    ...model.right,
    ...(model.right.length && status.length ? [s("  ")] : []),
    ...status,
  ];
  const marks = w.max
    ? [
        s(
          w.top +
            1 +
            "–" +
            Math.min(w.total, w.top + w.room) +
            " of " +
            w.total,
          "muted",
        ),
      ]
    : [];
  const legend = legendLine(
    state,
    item.kind,
    width - (marks.length ? lineWidth(marks) + 2 : 0),
  );
  return h(
    Box,
    {
      width: box.width,
      height: box.height,
      flexDirection: "column",
      paddingX: 3,
      backgroundColor: theme.tone("background"),
    },
    h(Lines, {
      lines: [[], model.title, right, tabsModel(model, width).line],
      width,
      height: paneHeaderRows,
    }),
    h(Lines, {
      lines: [...model.head, ...body],
      width,
      height: box.room.height,
    }),
    h(Lines, { lines: [spread(legend, marks, width)], width, height: 1 }),
  );
}
