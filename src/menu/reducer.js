import * as format from "../format.js";
import { fuzzyMatches } from "./fuzzy.js";
import { applyData, paneInit, serviceDown } from "./data.js";
import { modalKeys, modalText } from "./modal.js";
import { printable } from "./keys.js";
import {
  agentById,
  agentGroup,
  expireToasts,
  groupAgents,
  groupId,
  orchestratorByName,
  pickedAgent,
  questionRows,
  toast,
  touch,
} from "./state.js";
import { tooSmall } from "./layout.js";
import { hitTest } from "./mouse.js";
import {
  moveSelection,
  reselect,
  select,
  selectable,
  selectedRow,
  treeRows,
} from "./tree.js";
import {
  bodyRoom,
  currentItem,
  paneBox,
  paneModel,
  paneWindow,
  scrollPane,
  toggleFold,
} from "./pane.js";
import { jump, openPalette, paletteKeys, paletteText } from "./palette.js";
import { editSettings, openActions, runAction, refreshNow } from "./actions.js";
import { closeForm, formKeys } from "./views/settings.js";
import { nextTab, tabs } from "./views/agent.js";
import { runAgents } from "./views/run.js";
import { refresh, result } from "./views/common.js";

// Key handling as a reducer: reduce(state, action) -> { state, effects }.
// Actions: { type: "key", key }, "text" (several characters at once),
// "paste", "tick", "resize", "data" (an answer to a refresh request),
// "called" (an answer to an action's call) and "service" (starting it).
// Effects are data the runtime carries out: refresh, call, start-service,
// redraw and quit.
//
// The sidebar displays selections immediately. Enter opens the visible
// Actions menu; inspecting output and editing settings have their own keys.
const quit = { type: "quit" };

export function reduce(state, action) {
  const now = action.now ?? state.now;
  if (now !== state.now) state = { ...state, now };
  switch (action.type) {
    case "splash-end":
      return result({ ...state, splash: false });
    case "mouse":
      return onMouse(state, action);
    case "key":
      return onKey(state, action.key);
    case "text":
    case "paste":
      return onText(state, action.text, action.type === "paste");
    case "tick":
      return result(ensurePane(expireToasts(state)), [refresh]);
    case "resize":
      return result(
        reselect({ ...state, size: { cols: action.cols, rows: action.rows } }),
        [{ type: "redraw" }],
      );
    case "data":
      return onData(state, action);
    case "called":
      return onCalled(state, action);
    case "service":
      return onService(state, action);
    default:
      return result(state);
  }
}

// The selected pane's data is kept among the most recent ones.
function ensurePane(state) {
  const item = currentItem(state);
  const init = paneInit[item.kind];
  return init ? touch(state, item.key, init) : state;
}

// After a key: when the selection moved, a workspace's open form closes,
// the new pane's data is read.
function settle(before, out) {
  let state = out.state;
  if (state.selected === before.selected) return out;
  if (state.form && state.selected !== `ws:${state.form.workspace}`)
    state = closeForm(state);
  if (state.from && state.selected !== `agent:${state.from.agent}`)
    state = { ...state, from: null };
  return result(ensurePane(state), [
    ...out.effects.filter((e) => e.type !== "refresh"),
    refresh,
  ]);
}

// An answer to a refresh request. The first time the questions are read,
// the first open one takes the selection (unless the person moved first).
function onData(state, action) {
  let next = reselect(applyData(state, action));
  // Pelican runs only while something uses it: the first time no service
  // answers, the menu starts one (once; after that Enter does).
  if (
    action.request.key === "status" &&
    serviceDown(action.error) &&
    state.service.state === "unknown" &&
    !state.service.tried
  )
    return result(
      { ...next, service: { state: "starting", message: null, tried: true } },
      [{ type: "start-service" }],
    );
  if (action.request.key === "questions" && !action.error && !next.picked) {
    next = { ...next, picked: true };
    const first = questionRows(next)[0];
    if (first && !next.moved)
      next = { ...select(next, first.id), moved: false };
  }
  if (next.selected !== state.selected) next = ensurePane(next);
  return result(
    next,
    next.selected !== state.selected && state.service.state === "up"
      ? [refresh]
      : [],
  );
}

// Several characters at once: a paste, or typing faster than a frame. In a
// field they are text; elsewhere each is a key.
function onText(state, text, pasted) {
  if (tooSmall(state)) return result(state);
  if (state.splash) return result({ ...state, splash: false });
  if (state.modal) {
    const typed = modalText(state, text);
    if (typed) return typed;
  }
  if (state.palette) return paletteText(state, text);
  if (!state.modal && (state.filtering || state.focus === "search"))
    return setFilter(
      { ...state, filtering: true },
      state.filter + String(text).replace(/\s+/g, " "),
    );
  if (pasted) return result(state);
  let out = result(state);
  const effects = [];
  for (const ch of String(text)) {
    out = onKey(out.state, ch === "\r" || ch === "\n" ? "enter" : ch);
    effects.push(...out.effects);
  }
  return result(out.state, effects);
}

function onKey(state, key) {
  if (key === null || key === undefined) return result(state);
  if (key === "ctrl+c") return result(state, [quit]);
  if (tooSmall(state)) return result(state, key === "q" ? [quit] : []);
  if (state.splash) return result({ ...state, splash: false });
  if (state.modal) return modalKeys(state, key);
  if (state.palette) return settle(state, paletteKeys(state, key));
  if (state.filtering) return settle(state, filterKeys(state, key));
  if (state.service.state !== "up") return serviceKeys(state, key);
  if (
    state.focus === "search" &&
    printable(key) &&
    !["/", "q", ":"].includes(key)
  )
    return setFilter({ ...state, filtering: true }, state.filter + key);
  const own =
    state.focus === "pane" ? paneKeys(state, key) : sideKeys(state, key);
  return settle(state, own ?? globalKeys(state, key));
}
function stepSidebar(state, step) {
  if (state.focus === "search")
    return step < 0
      ? state
      : moveSelection({ ...state, focus: "side" }, "first");
  if (state.focus === "commands")
    return step > 0
      ? state
      : moveSelection({ ...state, focus: "side" }, "last");
  const rows = selectable(treeRows(state)),
    at = rows.findIndex((row) => row.id === state.selected);
  if (step < 0 && at <= 0) return { ...state, focus: "search", moved: true };
  if (step > 0 && at === rows.length - 1)
    return { ...state, focus: "commands", moved: true };
  return moveSelection(state, step);
}
function scrollFromSide(state, key) {
  const box = paneBox(state);
  return scrollPane(state, key, paneModel(state), box) ?? state;
}
function sideKeys(state, key) {
  const row = selectedRow(state);
  switch (key) {
    case "up":
      return result(stepSidebar(state, -1));
    case "down":
      return result(stepSidebar(state, 1));
    case "home":
      return result(moveSelection({ ...state, focus: "side" }, "first"));
    case "end":
      return result(moveSelection({ ...state, focus: "side" }, "last"));
    case "pageup":
    case "pagedown":
      return result(scrollFromSide(state, key));
    case "right":
      if (row?.kind === "group" || (row?.kind === "run" && hasAgents(state)))
        return result({ ...state, focus: "pane" });
      return result(row?.node ? setOpen(state, row, true) : state);
    case "left":
      if (row?.node && row.open) return result(setOpen(state, row, false));
      if (row?.kind === "agent") return result(backToList(state));
      return result(row?.parent ? select(state, row.parent) : state);
    case "backspace":
    case "delete":
      return state.focus === "side" && row?.kind === "agent"
        ? result(backToList(state))
        : null;
    case "enter":
      if (state.focus === "search") return globalKeys(state, "/");
      if (state.focus === "commands") return globalKeys(state, ":");
      if (row?.kind === "more") return result(toggleMore(state, row));
      if (row?.kind === "group") return result({ ...state, focus: "pane" });
      return openActions(state, currentItem(state));
    default:
      return null;
  }
}
const setOpen = (state, row, open) => ({
  ...state,
  open: { ...state.open, [row.orchestrator.name]: open },
  moved: true,
});
const toggleMore = (state, row) => ({
  ...state,
  more: { ...state.more, [row.more]: !state.more[row.more] },
  moved: true,
});

// An agent is opened from a list that holds the keys: a group's, or a
// workflow run's agents. Its row shows under its group while it is selected.
// Back is the list again with the agent highlighted in it.
const hasAgents = (state) => runAgents(state, currentItem(state)).length > 0;
const openAgent = (state, item, id) =>
  select(
    {
      ...state,
      pick: { ...state.pick, [item.key]: id },
      from: item.kind === "run" ? { agent: id, to: item.id } : null,
      focus: "pane",
    },
    `agent:${id}`,
  );
function backToList(state) {
  const id = state.selected.slice(6);
  const agent = agentById(state, id);
  if (!agent) return state;
  const to =
    state.from?.agent === id
      ? state.from.to
      : groupId(agent.owner, agentGroup(agent));
  return select(
    { ...state, pick: { ...state.pick, [to]: id }, from: null },
    to,
  );
}

// ↑↓ (and PgUp PgDn Home End in a group's list) move the highlight,
// scrolling the pane to keep it in view; Enter opens the highlighted agent.
function listKeys(state, item, list, key, moves) {
  if (key === "enter") {
    const agent = pickedAgent(state, item.key, list);
    return agent ? result(openAgent(state, item, agent.id)) : null;
  }
  return moves.includes(key) ? movePick(state, item, list, key) : null;
}
function movePick(state, item, list, key) {
  if (!list.length) return result(state);
  const box = paneBox(state);
  const page = Math.max(1, bodyRoom(paneModel(state, item, box), box) - 1);
  const at = list.indexOf(pickedAgent(state, item.key, list));
  const to =
    key === "home"
      ? 0
      : key === "end"
        ? list.length - 1
        : Math.max(
            0,
            Math.min(
              list.length - 1,
              at + { up: -1, down: 1, pageup: -page, pagedown: page }[key],
            ),
          );
  const next = {
    ...state,
    pick: { ...state.pick, [item.key]: list[to].id },
  };
  // Scroll the highlighted agent into view.
  const model = paneModel(next, item, box);
  if (!model.pickLine) return result(next);
  const w = paneWindow(next, model, box);
  const { line, size } = model.pickLine;
  const top =
    line < w.top
      ? line
      : line + size > w.top + w.room
        ? line + size - w.room
        : w.top;
  return result(
    top === w.top
      ? next
      : {
          ...next,
          views: {
            ...next.views,
            [model.viewKey]: { top, follow: false, seen: model.entries },
          },
        },
  );
}

// The right pane: ↑↓ (j k) scroll a line, PgUp PgDn a page, Home the top,
// End the bottom (live again); ← or Esc gives the sidebar the keys; Enter
// opens the marked command or edit, answers a question or opens a
// workspace's settings. A workspace's form takes its own keys first.
function paneKeys(state, key) {
  const item = currentItem(state);
  if (key === "r" && !state.form) return refreshNow(state);
  if (item.kind === "workspace" && state.form?.workspace === item.workspaceId) {
    const used = formKeys(state, key);
    if (used) return used;
  }
  // A workflow keeps ↑↓ for its agents only when it has some the fleet
  // knows; PgUp PgDn Home End still scroll it.
  const listed =
    item.kind === "group"
      ? listKeys(
          state,
          item,
          groupAgents(orchestratorByName(state, item.owner), item.group),
          key,
          ["up", "down", "pageup", "pagedown", "home", "end"],
        )
      : item.kind === "run"
        ? listKeys(state, item, runAgents(state, item), key, ["up", "down"])
        : null;
  if (listed) return listed;
  if (item.kind === "agent" && (key === "backspace" || key === "delete"))
    return result(backToList(state));
  const box = paneBox(state);
  const model = paneModel(state, item, box);
  const scrolled = scrollPane(state, key, model, box);
  if (scrolled) return result(scrolled);
  if (key === "escape") return result({ ...state, focus: "side" });
  if (key === "enter") {
    const opened =
      model.folds.length &&
      toggleFold(state, model, box, (s) => paneModel(s, item, box));
    if (opened) return result(opened);
    return openActions(state, item);
  }
  return null;
}

// Keys that mean the same wherever the focus is.
function globalKeys(state, key) {
  const item = currentItem(state);
  switch (key) {
    case "q":
      return result(state, [quit]);
    case "/":
      return result({
        ...closeForm(state),
        filtering: true,
        focus: "search",
        moved: true,
      });
    case ":":
      return openPalette(closeForm(state));
    case "[":
    case "]":
      return item.kind === "agent"
        ? result(nextTab(state, item, key === "]" ? 1 : -1))
        : result(state);
    case "escape":
      return result(state.filter ? clearFilter(state) : state);
    default:
      return result(state);
  }
}
function setFilter(state, filter) {
  if (!filter)
    return result(
      reselect({ ...state, filter: "", filtering: false, focus: "search" }),
    );
  let next = { ...state, filter };
  const query = filter.trim(),
    rows = selectable(treeRows(next));
  const hit =
    (query && rows.find((row) => fuzzyMatches(query, row.name))) ?? rows[0];
  if (hit) next = select(next, hit.id);
  return settle(state, result(next));
}
const clearFilter = (state) =>
  reselect({ ...state, filter: "", filtering: false, focus: "side" });
function filterKeys(state, key) {
  if (key === "enter" || key === "down")
    return result({ ...state, filtering: false, focus: "side" });
  if (key === "escape") return result(clearFilter(state));
  if (key === "backspace")
    return setFilter(state, [...state.filter].slice(0, -1).join(""));
  if (key === "ctrl+u") return setFilter(state, "");
  if (printable(key)) return setFilter(state, state.filter + key);
  return result(state);
}
function serviceKeys(state, key) {
  if (key === "q") return result(state, [quit]);
  if (key === "r") return result(state, [refresh]);
  if (key === "enter" && state.service.state === "down")
    return result(
      { ...state, service: { ...state.service, state: "starting" } },
      [{ type: "start-service" }],
    );
  return result(state);
}

function onMouse(state, event) {
  const target = hitTest(state, event);
  if (!target) return result(state);
  if (target.dismiss) return result({ ...state, splash: false });
  if (target.toast !== undefined)
    return result({
      ...state,
      toasts: state.toasts.filter((t) => t.id !== target.toast),
    });
  if (target.menuKey) return runAction(state, target.menuKey);
  if (target.choice !== undefined)
    return modalKeys(
      { ...state, modal: { ...state.modal, index: target.choice } },
      "enter",
    );
  if (target.mode)
    return result({ ...state, modal: { ...state.modal, mode: target.mode } });
  if (target.modalScroll !== undefined)
    return result({
      ...state,
      modal: { ...state.modal, scroll: target.modalScroll },
    });
  if (target.paletteIndex !== undefined)
    return settle(
      state,
      paletteKeys(
        { ...state, palette: { ...state.palette, index: target.paletteIndex } },
        "enter",
      ),
    );
  if (target.paletteStep) {
    let next = state;
    for (let i = 0; i < Math.abs(target.paletteStep); i++)
      next = paletteKeys(next, target.paletteStep > 0 ? "down" : "up").state;
    return result(next);
  }
  if (target.openAgent !== undefined)
    return settle(
      state,
      result(openAgent(closeForm(state), currentItem(state), target.openAgent)),
    );
  // A row that names an item (the Overview's workspaces, orchestrators and
  // agents) goes to it, as the command palette does.
  if (target.jump) return settle(state, jump(closeForm(state), target.jump));
  if (target.select) {
    const next = select(
      { ...closeForm(state), focus: "side", filtering: false },
      target.select,
    );
    return settle(
      state,
      result(
        target.node
          ? setOpen(next, selectedRow(next), target.open)
          : selectedRow(next)?.kind === "more"
            ? toggleMore(next, selectedRow(next))
            : next,
      ),
    );
  }
  if (target.scroll) {
    if (target.side)
      return settle(
        state,
        result(
          moveSelection(
            { ...closeForm(state), focus: "side", filtering: false },
            target.scroll,
          ),
        ),
      );
    let next = state;
    for (let i = 0; i < Math.abs(target.scroll); i++)
      next = scrollFromSide(next, target.scroll > 0 ? "down" : "up");
    return result(next);
  }
  if (target.tab !== undefined) {
    const item = currentItem(state);
    return item.kind === "agent"
      ? result({
          ...state,
          tabs: { ...state.tabs, [item.agentId]: tabs[target.tab] },
        })
      : result(state);
  }
  if (target.foldKey !== undefined) {
    const model = paneModel(state),
      open = state.expanded[model.viewKey] ?? [];
    return result({
      ...state,
      expanded: {
        ...state.expanded,
        [model.viewKey]: open.includes(target.foldKey)
          ? open.filter((key) => key !== target.foldKey)
          : [...open, target.foldKey],
      },
    });
  }
  if (target.field !== undefined) {
    const item = currentItem(state),
      next = state.form ? state : editSettings(state, item.workspace)?.state;
    if (!next) return result(state);
    const focused = {
      ...next,
      focus: "pane",
      form: { ...next.form, index: target.field },
    };
    return target.command ? onKey(focused, target.command) : result(focused);
  }
  if (["q", "/", ":"].includes(target.command))
    return globalKeys(state, target.command);
  return target.command ? onKey(state, target.command) : result(state);
}

const doneText = (effect, value) => {
  try {
    switch (effect.method) {
      case "message":
        return format.message(value);
      case "answer":
        return format.answered(value);
      case "resume":
        return format.resumed(value);
      case "stop":
        return effect.params.all
          ? value.stopped.length
            ? `Stopped ${value.stopped.length} agent${value.stopped.length === 1 ? "" : "s"}.`
            : "Nothing was running or queued."
          : (effect.done ?? format.stopped(value));
      default:
        return effect.done ?? "Done.";
    }
  } catch {
    return effect.done ?? "Done.";
  }
};

function onCalled(state, { effect, result: value, error }) {
  if (error) {
    if (
      error.statusCode === 403 &&
      /belongs to/.test(error.message) &&
      !effect.params?.takeover
    )
      return result({
        ...state,
        modal: {
          kind: "confirm",
          title: "Take this agent over?",
          lines: [
            error.message,
            `You (${state.as}) become its owner, and its questions come to you.`,
          ],
          effect: { ...effect, params: { ...effect.params, takeover: true } },
        },
      });
    return result(toast(state, error.message, "error"), [refresh]);
  }
  let next = toast(state, doneText(effect, value), "ok");
  if (effect.method === "settings" && next.form?.workspace === value?.workspace)
    next = {
      ...next,
      form: {
        ...next.form,
        original: { ...value.settings },
        values: { ...value.settings },
      },
    };
  return result(next, [refresh]);
}

function onService(state, { phase, message }) {
  if (phase === "started")
    return result(
      toast(
        {
          ...state,
          service: { state: "unknown", message: null, tried: true },
        },
        "Pelican started.",
        "ok",
      ),
      [refresh],
    );
  if (phase === "failed")
    return result(
      toast(
        { ...state, service: { state: "down", message } },
        message,
        "error",
      ),
    );
  return result({ ...state, service: { ...state.service, state: "starting" } });
}
