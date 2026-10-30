import { fitLine, lineWidth, s } from "../lines.js";
import { frameCols } from "../layout.js";
import { currentItem, paneBox, paneModel, paneWindow } from "../pane.js";
import { selectedRow } from "../tree.js";
import { runAgents } from "../views/run.js";
import { fields } from "../views/settings.js";

export const keyLabel = (key, g) =>
  ({
    updown: g.up + g.down,
    leftright: g.left + g.right,
    left: g.left,
    right: g.right,
    down: g.down,
    enter: g.enter,
    "[]": "[ ]",
  })[key] ?? key;
export function footerHints(state) {
  const kind = state.modal?.kind;
  if (state.palette && !kind)
    return [
      ["updown", "Choose", 1],
      ["PgUp/Dn", "Page", 2],
      ["enter", "Open", 1],
      ["Ctrl+U", "Clear", 2],
      ["Esc", "Close", 1],
    ];
  if (kind === "actions" || kind === "choice")
    return [
      ["updown", "Choose", 1],
      ["enter", "Select", 1],
      ["Esc", "Close", 1],
    ];
  if (kind === "confirm")
    return [
      ["leftright", "Choose", 1],
      ["enter", "Select", 1],
      ["Esc", "Cancel", 1],
    ];
  if (kind === "input" || kind === "typed")
    return [
      ["Ctrl+U", "Clear", 2],
      ...(state.modal.modes ? [["Tab", "Mode", 1]] : []),
      [
        "enter",
        kind === "typed"
          ? "Confirm"
          : state.modal.submit?.type === "form"
            ? "Set"
            : "Send",
        1,
      ],
      ["Esc", "Cancel", 1],
    ];
  if (state.service.state !== "up")
    return [
      ...(state.service.state === "down"
        ? [["enter", "Start service", 1]]
        : []),
      ["r", "Retry", 1],
      ["q", "Quit", 1],
    ];
  if (state.filtering)
    return [
      ["down", "Results", 1],
      ["enter", "Done", 1],
      ["Ctrl+U", "Clear", 1],
      ["Esc", "Cancel", 1],
    ];
  const item = currentItem(state),
    row = selectedRow(state);
  if (state.form)
    return [
      ["updown", "Field", 1],
      ["leftright", "Adjust", 1],
      ["Home/End", "Jump", 2],
      [
        "enter",
        fields[state.form.index]?.kind === "text" ? "Edit" : "Apply",
        1,
      ],
      ["Esc", "Done", 1],
    ];
  const model = paneModel(state),
    w = paneWindow(state, model, paneBox(state));
  const picking = item.kind === "run" && runAgents(state, item).length > 0;
  if (state.focus === "pane")
    return [
      ["r", "Refresh", 1],
      ["updown", item.kind === "group" || picking ? "Select" : "Scroll", 1],
      ["Home/End", "Jump", 2],
      ...(picking && item.kind === "run" ? [["PgUp/Dn", "Scroll", 2]] : []),
      ...(item.kind === "group" || picking ? [["enter", "Open", 1]] : []),
      ...(w.current
        ? [
            [
              "enter",
              (state.expanded[model.viewKey] ?? []).includes(w.current.key)
                ? "Collapse"
                : "Expand",
              1,
            ],
          ]
        : []),
      ...(item.kind === "agent"
        ? [
            ["[]", "View", 1],
            ["Backspace", "Back", 1],
          ]
        : []),
      ["Esc", "Sidebar", 1],
      ["q", "Quit", 1],
    ];
  return [
    ["updown", "Navigate", 1],
    ["Home/End", "Jump", 3],
    ...(state.focus === "search" || state.focus === "commands"
      ? [["enter", "Activate", 1]]
      : row?.kind === "more"
        ? [["enter", state.more[row.more] ? "Collapse" : "Expand", 1]]
        : row?.kind === "group"
          ? [["enter", "Open", 1]]
          : item.kind !== "empty"
            ? [["enter", "Actions", 1]]
            : []),
    ...(row?.kind === "run" && state.focus === "side" && picking
      ? [["right", "Agents", 2]]
      : []),
    ...(row?.node && state.focus === "side"
      ? [["leftright", "Fold", 2]]
      : row?.kind === "agent" && state.focus === "side"
        ? [["Backspace", "Back", 1]]
        : row?.parent && state.focus === "side"
          ? [["left", "Parent", 2]]
          : []),
    ...(item.kind === "agent" && state.focus === "side"
      ? [["[]", "View", 1]]
      : []),
    ...(w.max ? [["PgUp/Dn", "Scroll", 2]] : []),
    ...(state.filter ? [["Esc", "Clear", 1]] : []),
    ["q", "Quit", 1],
  ];
}
export function footerModel(state, g) {
  const cols = frameCols(state);
  const spans = (list) =>
    list.flatMap(([key, label], i) => [
      s(i ? "    " : "  "),
      s(keyLabel(key, g), "accent bold"),
      s(" " + label, "muted"),
    ]);
  let shown = footerHints(state);
  while (shown.length > 1 && lineWidth(spans(shown)) > cols) {
    const weight = Math.max(...shown.map((h) => h[2])),
      index = shown.findLastIndex((h) => h[2] === weight);
    shown = shown.filter((_, i) => i !== index);
  }
  let x = 0;
  const targets = shown.map(([key, label], i) => {
    x += i ? 4 : 2;
    const start = x,
      size = lineWidth([s(keyLabel(key, g) + " " + label)]);
    x += size;
    const command =
      {
        updown: "down",
        leftright: "right",
        enter: "enter",
        Esc: "escape",
        "Home/End": "end",
        "PgUp/Dn": "pagedown",
        "Ctrl+U": "ctrl+u",
        Tab: "tab",
        "[]": "]",
        Backspace: "backspace",
      }[key] ?? key;
    return { x: start, y: state.size.rows - 2, width: size, command };
  });
  return { line: fitLine(spans(shown), cols), targets };
}
export const footerLine = (state, g) => footerModel(state, g).line;
