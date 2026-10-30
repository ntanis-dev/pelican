import { charWidth } from "./text.js";
import { printable } from "./keys.js";
import { toast } from "./state.js";
import { result } from "./views/common.js";
import { runAction } from "./actions.js";

// Dialogs over the view: confirm (y / n), typed (type a word, for stopping
// everyone), input (a line of text; pasted newlines stay), choice (pick one,
// for approvals) and help. Each holds the effect it leads to as data;
// ui/overlays.js draws them.
const close = (state) => ({ ...state, modal: null });

// A text field's editing keys: { value, cursor } -> the edited field, or
// null when the key is not an editing key. Shared by dialogs, the filter and
// the command palette.
export function editField(field, key) {
  const chars = [...field.value];
  let cursor = Math.min(field.cursor ?? chars.length, chars.length);
  if (printable(key)) {
    chars.splice(cursor, 0, key);
    cursor++;
  } else if (key === "backspace" && cursor > 0) {
    chars.splice(cursor - 1, 1);
    cursor--;
  } else if (key === "delete") chars.splice(cursor, 1);
  else if (key === "left") cursor = Math.max(0, cursor - 1);
  else if (key === "right") cursor = Math.min(chars.length, cursor + 1);
  else if (key === "home") cursor = 0;
  else if (key === "end") cursor = chars.length;
  else if (key === "ctrl+u") {
    chars.splice(0, cursor);
    cursor = 0;
  } else return null;
  return { ...field, value: chars.join(""), cursor };
}
// Text typed or pasted at once, at the cursor. Fields of one line turn
// newlines into spaces.
export function insertText(field, text, { multiline = false } = {}) {
  let clean = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!multiline) clean = clean.replace(/\n+/g, " ");
  clean = clean.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const chars = [...field.value];
  const cursor = Math.min(field.cursor ?? chars.length, chars.length);
  const added = [...clean];
  chars.splice(cursor, 0, ...added);
  return { ...field, value: chars.join(""), cursor: cursor + added.length };
}

function submitInput(state, modal) {
  const value = modal.value.trim();
  if (!value)
    return result(toast(state, "Type something first, or Esc to cancel."));
  const submit = modal.submit;
  if (submit.type === "form") {
    let parsed = value;
    if (submit.number) {
      parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64)
        return result(toast(state, "A whole number from 1 to 64.", "error"));
    }
    return result({
      ...close(state),
      form: {
        ...state.form,
        values: { ...state.form.values, [submit.field]: parsed },
      },
    });
  }
  return chooseEffect(state, modal, value);
}
function chooseEffect(state, modal, value) {
  const { method, params, field, modeField, done } = modal.submit;
  const effect = {
    type: "call",
    method,
    params: {
      ...params,
      [field]: value,
      ...(modeField ? { [modeField]: modal.mode } : {}),
    },
    done,
  };
  return result(close(state), [effect]);
}

// Pasted (or quickly typed) text lands in the open field.
export function modalText(state, text) {
  const modal = state.modal;
  if (modal.kind === "input")
    return result({
      ...state,
      modal: insertText(modal, text, { multiline: true }),
    });
  if (modal.kind === "typed")
    return result({ ...state, modal: insertText(modal, text) });
  return null;
}

export function modalKeys(state, key) {
  const modal = state.modal;
  switch (modal.kind) {
    case "actions": {
      if (key === "escape") return result(close(state));
      if (["up", "down"].includes(key)) {
        const count = modal.options.length,
          index = (modal.index + (key === "up" ? -1 : 1) + count) % count;
        return result({
          ...state,
          modal: { ...modal, index, scroll: undefined },
        });
      }
      const option =
        key === "enter"
          ? modal.options[modal.index]
          : modal.options.find((o) => o.key === key);
      return option ? runAction(state, option.key) : result(state);
    }
    case "confirm": {
      // Two buttons; Enter presses the focused one (No unless the dialog
      // says otherwise), y and n press theirs.
      const yes = modal.focus ? modal.focus === "yes" : Boolean(modal.yes);
      if (key === "y" || (key === "enter" && yes))
        return result(close(state), [modal.effect]);
      if (["n", "escape", "enter"].includes(key)) return result(close(state));
      if (["left", "right"].includes(key))
        return result({
          ...state,
          modal: { ...modal, focus: yes ? "no" : "yes" },
        });
      return result(state);
    }
    case "typed": {
      if (key === "escape") return result(close(state));
      if (key === "enter")
        return modal.value.trim().toLowerCase() === modal.word
          ? result(close(state), [modal.effect])
          : result(
              toast(
                close(state),
                `Not confirmed (you typed "${modal.value}"): nothing was stopped.`,
              ),
            );
      const edited = editField(modal, key);
      return result(edited ? { ...state, modal: edited } : state);
    }
    case "input": {
      if (key === "escape") return result(close(state));
      if (key === "enter") return submitInput(state, modal);
      if (key === "tab" && modal.modes) {
        const mode =
          modal.modes[
            (modal.modes.indexOf(modal.mode) + 1) % modal.modes.length
          ];
        return result({ ...state, modal: { ...modal, mode } });
      }
      const edited = editField(modal, key);
      return result(edited ? { ...state, modal: edited } : state);
    }
    case "choice": {
      if (key === "escape") return result(close(state));
      const count = modal.options.length;
      if (key === "up")
        return result({
          ...state,
          modal: { ...modal, index: (modal.index - 1 + count) % count },
        });
      if (key === "down")
        return result({
          ...state,
          modal: { ...modal, index: (modal.index + 1) % count },
        });
      if (/^[1-9]$/.test(key) && Number(key) <= count)
        return chooseEffect(state, modal, modal.options[Number(key) - 1].value);
      if (key === "enter")
        return chooseEffect(state, modal, modal.options[modal.index].value);
      return result(state);
    }
    default:
      return result(close(state));
  }
}

// The window of a field's value that keeps the cursor in view: { before,
// at, after } (the character under the cursor, or a space at the end).
// Newlines show as ↵.
export function fieldWindow(value, cursor, room) {
  const chars = [...String(value ?? "")].map((c) => (c === "\n" ? "↵" : c));
  const at = Math.min(cursor ?? chars.length, chars.length);
  const width = (list) => list.reduce((n, c) => n + charWidth(c), 0);
  let start = 0;
  while (width(chars.slice(start, at)) > room - 1 && start < at) start++;
  let end = at + 1;
  while (end < chars.length && width(chars.slice(start, end + 1)) <= room)
    end++;
  return {
    before: chars.slice(start, at).join(""),
    at: chars[at] ?? " ",
    after: chars.slice(at + 1, Math.max(at + 1, end)).join(""),
    col: width(chars.slice(start, at)),
  };
}
