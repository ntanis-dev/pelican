import { effortSchema } from "../../schema.js";
import { lineWidth, s, wrapLine } from "../lines.js";
import { width as cells } from "../text.js";
import { toast } from "../state.js";
import { call, notice, result } from "./common.js";

// A workspace's settings as a form, in the workspace's pane (e opens it).
// Changes apply only after a confirmation; Esc leaves without applying
// them.
export const efforts = effortSchema.options;
export const fields = [
  {
    key: "concurrency",
    label: "Concurrency",
    kind: "number",
    help: "agents at once (1-64)",
    short: "1-64",
  },
  {
    key: "paused",
    label: "Paused",
    kind: "boolean",
    help: "the queue starts nothing",
    short: "starts nothing",
  },
  {
    key: "model",
    label: "Model",
    kind: "text",
    help: "default for new agents (Enter edits)",
    short: "Enter edits",
  },
  {
    key: "effort",
    label: "Effort",
    kind: "choice",
    help: "default for new agents",
    short: "for new agents",
  },
  {
    key: "network",
    label: "Network",
    kind: "boolean",
    help: "sandbox network access for its agents",
    short: "network access",
  },
];
const applyRow = fields.length;

export function startForm(workspace) {
  return {
    workspace: workspace.id,
    name: workspace.name,
    folder: workspace.folder,
    original: { ...workspace.settings },
    values: { ...workspace.settings },
    index: 0,
  };
}
export const show = (key, value) =>
  key === "paused"
    ? value
      ? "yes"
      : "no"
    : key === "network"
      ? value
        ? "on"
        : "off"
      : String(value);
export const changes = (form) =>
  Object.fromEntries(
    fields
      .filter((f) => form.values[f.key] !== form.original[f.key])
      .map((f) => [f.key, form.values[f.key]]),
  );

// One field's control: a stepper, a switch, a text, or the choices (all of
// them when they fit, else a stepper with the place among them).
function control(field, value, changed, g, room) {
  const tone = changed ? "warn bold" : "bold";
  switch (field.kind) {
    case "number":
      return [
        s(`${g.left} `, "muted"),
        s(String(value).padStart(2), tone),
        s(` ${g.right}`, "muted"),
      ];
    case "boolean":
      return [
        s(value ? `${g.dot} ` : `${g.ring} `, value ? "ok" : "muted"),
        s(show(field.key, value), tone),
      ];
    case "choice": {
      const all = efforts.flatMap((e, i) => [
        ...(i ? [s(" ")] : []),
        s(e === value ? `[${e}]` : ` ${e} `, e === value ? tone : "muted"),
      ]);
      if (all.reduce((n, [t]) => n + cells(t), 0) <= room) return all;
      return [
        s(`${g.left} `, "muted"),
        s(String(value), tone),
        s(` ${g.right}`, "muted"),
        s(`  ${efforts.indexOf(value) + 1}/${efforts.length}`, "muted"),
      ];
    }
    default:
      return [s(String(value), tone)];
  }
}

// The form as lines `width` wide; the selected field is highlighted while
// the pane has the keys.
export function formLines(form, width, { g, focused }) {
  const changed = changes(form),
    count = Object.keys(changed).length,
    lines = [],
    labelWidth = 13,
    controlX = 16;
  for (const [i, field] of fields.entries()) {
    const at = i === form.index,
      tone = field.key in changed ? "warn bold" : "bold";
    const value = form.values[field.key];
    const ctl =
      field.kind === "choice"
        ? [
            s(g.left + " ", "muted"),
            s(String(value).padEnd(8), tone),
            s(" " + g.right, "muted"),
          ]
        : control(field, value, field.key in changed, g, 18);
    const line = [
      s(at ? g.arrow + " " : "  ", "accent bold"),
      s(
        field.label.padEnd(labelWidth),
        at && focused ? "selected bold" : "bold",
      ),
      s(" "),
      ...ctl,
    ];
    const padding = Math.max(2, 18 - lineWidth(ctl));
    line.push(s(" ".repeat(padding)));
    const room = width - lineWidth(line),
      hint = [field.help, field.short].find(
        (text) => text && cells(text) <= room,
      );
    if (hint) line.push(s(hint, "muted"));
    line.targets = [
      {
        x: controlX,
        y: 0,
        width: 2,
        field: i,
        command: field.kind === "text" ? "enter" : "left",
      },
      {
        x: controlX + 2,
        y: 0,
        width: Math.max(1, width - controlX - 2),
        field: i,
        command: field.kind === "text" ? "enter" : "right",
      },
      { x: 0, y: 0, width: controlX, field: i },
    ];
    lines.push(line);
  }
  lines.push([]);
  const apply = [
    s(form.index === applyRow ? g.arrow + " " : "  ", "accent bold"),
    s(
      " Apply" +
        (count ? " " + count + " change" + (count === 1 ? "" : "s") : "") +
        " ",
      form.index === applyRow && focused
        ? "selected bold"
        : count
          ? "accent bold"
          : "muted",
    ),
    s(count ? "  asks to confirm first" : "  nothing changed yet", "muted"),
  ];
  apply.targets = [{ x: 0, y: 0, width, field: applyRow, command: "enter" }];
  lines.push(apply);
  return lines;
}

const step = (form, field, direction) => {
  const value = form.values[field.key];
  if (field.kind === "number")
    return Math.max(1, Math.min(64, value + direction));
  if (field.kind === "boolean") return !value;
  if (field.kind === "choice") {
    const at = efforts.indexOf(value);
    return efforts[(at + direction + efforts.length) % efforts.length];
  }
  return value;
};
const withValue = (state, key, value) => ({
  ...state,
  form: { ...state.form, values: { ...state.form.values, [key]: value } },
});

export function confirmApply(state) {
  const form = state.form;
  const changed = changes(form);
  if (!Object.keys(changed).length) return notice(state, "Nothing changed.");
  return result({
    ...state,
    modal: {
      kind: "confirm",
      yes: true,
      title: `Apply these settings to ${form.workspace}?`,
      lines: Object.keys(changed).map(
        (k) => `${k}: ${show(k, form.original[k])} → ${show(k, changed[k])}`,
      ),
      effect: call(
        "settings",
        { workspace: form.workspace, ...changed },
        `Saved the settings of ${form.workspace}.`,
      ),
    },
  });
}

// Leaves the form; unsaved changes are dropped (and said so).
export function closeForm(state) {
  if (!state.form) return state;
  const dirty = Object.keys(changes(state.form)).length;
  const next = { ...state, form: null };
  return dirty ? toast(next, "Settings left unchanged.") : next;
}

const moves = { up: -1, down: 1 };
// The form's keys while the pane has them: ↑↓ field, ←→ change, Space
// toggles, Enter edits a text or applies, Esc leaves.
export function formKeys(state, key) {
  const form = state.form;
  if (!form) return null;
  const count = fields.length + 1;
  let index = null;
  if (key in moves)
    index = Math.max(0, Math.min(count - 1, form.index + moves[key]));
  else if (key === "home") index = 0;
  else if (key === "end") index = count - 1;
  if (index !== null) return result({ ...state, form: { ...form, index } });
  if (key === "escape") return result({ ...closeForm(state), focus: "side" });
  const field = fields[form.index];
  if (!field) return key === "enter" ? confirmApply(state) : null;
  if (["left", "right"].includes(key)) {
    if (field.kind === "text") return result(state);
    const direction = key === "left" ? -1 : 1;
    return result(withValue(state, field.key, step(form, field, direction)));
  }
  if (key === "enter") {
    if (field.kind !== "text") return confirmApply(state);
    const value = String(form.values[field.key]);
    return result({
      ...state,
      modal: {
        kind: "input",
        title: `${field.label} of ${form.workspace}`,
        lines: [
          field.kind === "number"
            ? "A whole number from 1 to 64."
            : "The model new agents use unless their brief names one.",
        ],
        value,
        cursor: [...value].length,
        submit: {
          type: "form",
          field: field.key,
          number: field.kind === "number",
        },
      },
    });
  }
  return null;
}
