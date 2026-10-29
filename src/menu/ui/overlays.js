import { Box } from "ink";
import { fitLine, s, spread, wrapLine } from "../lines.js";
import { width as cells, wrap } from "../text.js";
import { useTheme } from "../theme.js";
import { bodyHeight, frameCols, headerRows } from "../layout.js";
import { fieldWindow } from "../modal.js";
import { edge, h, Lines } from "./kit.js";
import { buttons } from "../controls.js";
import { kinds, paletteResults } from "../palette.js";
import { lineWidth, restyle } from "../lines.js";

// What floats over the panes (after Pelican's): dialogs and the
// toasts, each a box of lines padded to its width.
function boxLines(theme, { width, lines, title = [], style = "accent" }) {
  const c = theme.g.corners;
  const room = width - 4;
  return [
    edge(theme, { width, left: title, style }),
    ...lines.map((line) => [
      s(`${c.v} `, style),
      ...fitLine(line, room),
      s(` ${c.v}`, style),
    ]),
    edge(theme, { width, left: [], top: false, style }),
  ];
}
function Float({ top, left, lines, width }) {
  const theme = useTheme();
  return h(
    Box,
    {
      position: "absolute",
      marginTop: top,
      marginLeft: left,
      width,
      flexDirection: "column",
      backgroundColor: theme.tone("surface"),
    },
    h(Lines, { lines, width }),
  );
}
export const fieldSpans = (value, cursor, room, style = "") => {
  const f = fieldWindow(value, cursor, room);
  return [s(f.before, style), s(f.at, "inverse"), s(f.after, style)];
};

function modalContent(state, theme, inner) {
  const modal = state.modal;
  const g = theme.g;
  const text = (modal.lines ?? []).flatMap((l) => wrap(l, inner));
  const lines = [[], ...text.map((l) => [s(l)])];
  const title = [s(modal.title ?? "", "bold")];
  if (modal.kind === "actions") {
    lines.push([]);
    const targets = [];
    modal.options.forEach((option, i) => {
      const active = i === modal.index;
      const style = active ? "selected bold" : "";
      const line = spread(
        [
          s(active ? " " + g.arrow + " " : "   ", active ? style : "accent"),
          s(option.label, style || (option.key === "x" ? "err" : "text")),
        ],
        option.key ? [s(option.key + " ", active ? style : "accent bold")] : [],
        inner,
        style,
      );
      targets.push({
        x: 0,
        y: lines.length,
        width: inner,
        menuKey: option.key,
        actionIndex: i,
      });
      lines.push(line);
    });
    return {
      title,
      lines,
      targets,
      buttons: [{ key: "Esc", label: "Close", command: "escape" }],
    };
  }
  if (modal.kind === "confirm") {
    const yes = modal.focus ? modal.focus === "yes" : Boolean(modal.yes);
    return {
      title,
      lines,
      buttons: [
        { key: "y", label: "Yes", command: "y", selected: yes },
        { key: "n", label: "No", command: "n", selected: !yes },
      ],
    };
  }
  if (modal.kind === "choice") {
    lines.push([]);
    const targets = [];
    modal.options.forEach((o, i) => {
      const own = wrapLine(
        i === modal.index
          ? [s(` ${g.arrow} ${i + 1} ${o.label} `, "selected bold")]
          : [s(`   ${i + 1} `, "accent"), s(o.label)],
        inner,
        5,
      );
      for (const line of own) {
        targets.push({ x: 0, y: lines.length, width: inner, choice: i });
        lines.push(line);
      }
    });
    return { title, lines, targets };
  }
  const prompt =
    modal.kind === "typed" ? `Type ${modal.word}: ` : `${g.arrow} `;
  lines.push(
    [],
    [
      s(prompt, "accent bold"),
      ...fieldSpans(
        modal.value,
        modal.cursor ?? [...modal.value].length,
        Math.max(4, inner - cells(prompt)),
      ),
    ],
  );
  const targets = [];
  if (modal.modes) {
    lines.push([]);
    let x = 0;
    const choices = [];
    for (const mode of modal.modes) {
      const active = mode === modal.mode,
        word = " " + mode + " ";
      choices.push(s(word, active ? "selected bold" : "muted"), s(" "));
      targets.push({ x, y: lines.length, width: word.length, mode });
      x += word.length + 1;
    }
    lines.push(choices);
  }
  return { title, lines, targets };
}

export function modalLayout(state, theme) {
  const cols = frameCols(state);
  const height = bodyHeight(state);
  const width = Math.max(30, Math.min(cols - 4, 76));
  const content = modalContent(state, theme, width - 4);
  const tools = buttons(
    content.buttons ?? [
      {
        key: "Enter",
        label:
          state.modal.kind === "typed"
            ? "Confirm"
            : state.modal.kind === "choice"
              ? "Answer"
              : state.modal.submit?.type === "form"
                ? "Set"
                : "Send",
        command: "enter",
      },
      { key: "Esc", label: "Cancel", command: "escape" },
    ],
    width - 4,
  );
  const room = Math.max(1, height - 4 - tools.lines.length);
  const max = Math.max(0, content.lines.length - room);
  const choiceRow = content.targets?.find(
    (t) =>
      t.choice === state.modal.index || t.actionIndex === state.modal.index,
  )?.y;
  const desired =
    choiceRow === undefined ? max : choiceRow - Math.floor(room / 2);
  const offset = Math.max(0, Math.min(max, state.modal.scroll ?? desired));
  const body = content.lines.slice(offset, offset + room);
  const lines = [...body, [], ...tools.lines];
  const box = boxLines(theme, {
    width,
    lines,
    title: content.title,
    style: "muted",
  });
  const top = headerRows + Math.max(0, Math.floor((height - box.length) / 2));
  const left = Math.max(0, Math.floor((cols - width) / 2));
  const targets = [
    ...(content.targets ?? [])
      .filter((t) => t.y >= offset && t.y < offset + room)
      .map((t) => ({ ...t, y: t.y - offset })),
    ...tools.targets.map((t) => ({ ...t, y: body.length + 1 + t.y })),
  ].map((t) => ({ ...t, x: t.x + left + 2, y: t.y + top + 1 }));
  return { top, left, lines: box, width, targets, offset, max, room };
}
export function Modal({ state }) {
  const layout = modalLayout(state, useTheme());
  return h(Float, { ...layout });
}

export function paletteLayout(state, theme) {
  const cols = frameCols(state),
    height = bodyHeight(state),
    width = Math.min(cols - 4, 88),
    inner = width - 4;
  const found = paletteResults(state),
    rows = [],
    targets = [];
  const index = Math.min(state.palette.index, Math.max(0, found.length - 1));
  let selected = 0;
  found.forEach((item, i) => {
    if (i === index) selected = rows.length;
    const label = [
      s(" " + kinds[item.kind].padEnd(6), "muted"),
      s(item.label, "bold"),
    ];
    const hint = String(item.hint ?? "").split(" · ");
    while (
      hint.length &&
      lineWidth(label) + 2 + cells(hint.join(" · ")) > inner
    )
      hint.pop();
    if (hint.length) label.push(s("  " + hint.join(" · "), "muted"));
    for (const line of wrapLine(label, inner, 7)) {
      targets.push({ x: 0, y: rows.length, width: inner, paletteIndex: i });
      rows.push(
        i === index
          ? fitLine(restyle(line, "selected bold"), inner, "selected bold")
          : line,
      );
    }
  });
  const room = Math.max(1, Math.min(12, height - 7)),
    max = Math.max(0, rows.length - room);
  const offset = Math.max(0, Math.min(max, selected - Math.floor(room / 2)));
  const visible = rows.slice(offset, offset + room);
  const lines = [
    [
      s(": ", "accent bold"),
      ...fieldSpans(state.palette.value, state.palette.cursor, inner - 2),
    ],
    [s(theme.g.corners.h.repeat(inner), "divider")],
    ...(visible.length ? visible : [[s("Nothing matches.", "muted")]]),
    [],
    [s("Esc ", "accent bold"), s("Close", "muted")],
  ];
  const box = boxLines(theme, {
    width,
    lines,
    title: [
      s("Commands", "bold"),
      s("  " + found.length + " matches", "muted"),
    ],
    style: "muted",
  });
  const left = Math.floor((cols - width) / 2),
    top = Math.max(0, Math.floor((height - box.length) / 2));
  return {
    left,
    top,
    width,
    lines: box,
    targets: targets
      .filter((t) => t.y >= offset && t.y < offset + room)
      .map((t) => ({ ...t, x: left + 2, y: top + 3 + t.y - offset })),
    close: { x: left + 2, y: top + box.length - 2, width: 9 },
  };
}
export function Palette({ state }) {
  return h(Float, paletteLayout(state, useTheme()));
}

const toastStyle = { ok: "on-ok", error: "on-err", info: "on-accent" };
export function toastLayouts(state, theme) {
  const g = theme.g;
  const cols = frameCols(state);
  const height = bodyHeight(state);
  const floats = [];
  let bottom = headerRows + height - 1;
  for (const t of [...state.toasts.slice(-2)].reverse()) {
    const icon =
      t.tone === "ok" ? g.check : t.tone === "error" ? g.cross : g.bullet;
    const width = Math.max(
      16,
      Math.min(cols - 2, Math.min(72, cells(t.text) + 5)),
    );
    const style = toastStyle[t.tone] ?? "on-accent";
    const text = wrap(t.text, width - 5).slice(0, 3);
    const lines = text.map((l, i) =>
      fitLine(
        [s(i ? "    " : ` ${icon}  `, `${style} bold`), s(l, style)],
        width,
        style,
      ),
    );
    bottom -= lines.length;
    if (bottom < headerRows) break;
    floats.push({
      id: t.id,
      top: bottom,
      left: Math.max(0, cols - width - 2),
      lines,
      width,
    });
  }
  return floats;
}
export function Toasts({ state }) {
  return toastLayouts(state, useTheme()).map((layout) =>
    h(Float, { key: layout.id, ...layout }),
  );
}
