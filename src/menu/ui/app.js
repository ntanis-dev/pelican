import { useMemo, useSyncExternalStore } from "react";
import { Box, useInput, usePaste } from "ink";
import { s, wrapLine } from "../lines.js";
import { makeTheme, ThemeContext, useTheme } from "../theme.js";
import { bodyHeight, frameCols, frameRows, tooSmall } from "../layout.js";
import { keyOf } from "../keys.js";
import { paneBox } from "../pane.js";
import { sideWidth } from "../tree.js";
import { footerLine } from "./chrome.js";
import { h, Lines } from "./kit.js";
import { Sidebar } from "./sidebar.js";
import { RightPane } from "./pane.js";
import { Modal, Palette, Toasts } from "./overlays.js";
import { Splash } from "./splash.js";
import { sectionRule } from "../views/common.js";

function ServiceNotice({ state, box }) {
  const { g } = useTheme(),
    width = box.room.width;
  const phase = state.service.state;
  const message = String(state.service.message ?? "").replace(
    /^Pelican is not running \((.*)\)\..*$/s,
    (_, why) => why[0].toUpperCase() + why.slice(1) + ".",
  );
  const title =
    phase === "down"
      ? "Pelican is not running."
      : phase === "starting"
        ? "Starting Pelican."
        : phase === "error"
          ? "The service could not connect."
          : "Connecting to Pelican.";
  const words = [
    [],
    [s("Pelican service", "bold")],
    [s(state.url ?? "Local connection", "muted")],
    [],
    [],
    sectionRule("CONNECTION", width, g),
    [],
    [s(title, phase === "error" ? "err bold" : "bold")],
    [],
    ...wrapLine(
      [
        s(
          message ||
            (phase === "starting"
              ? "Your workspace opens as soon as the service answers."
              : "Your agents and workspaces will appear here."),
          "muted",
        ),
      ],
      width,
    ),
  ];
  return h(
    Box,
    {
      width: box.width,
      height: box.height,
      paddingX: 3,
      flexDirection: "column",
    },
    h(Lines, { lines: words, width, height: box.height }),
  );
}
function Body({ state }) {
  const width = frameCols(state),
    height = bodyHeight(state),
    box = paneBox(state);
  return h(
    Box,
    { width, height, flexDirection: "row" },
    h(Sidebar, { state, width: sideWidth(state), height }),
    state.service.state === "up"
      ? h(RightPane, { state, box })
      : h(ServiceNotice, { state, box }),
  );
}
function Frame({ state }) {
  const theme = useTheme(),
    cols = frameCols(state),
    rows = frameRows(state);
  return h(
    Box,
    {
      width: cols,
      height: rows,
      flexDirection: "column",
      backgroundColor: theme.tone("background"),
    },
    tooSmall(state) || state.splash
      ? h(Splash, { state, error: tooSmall(state) })
      : h(
          Box,
          { width: cols, height: rows, flexDirection: "column" },
          h(Body, { state }),
          h(Lines, {
            lines: [footerLine(state, theme.g)],
            width: cols,
            height: 1,
          }),
          ...(state.toasts.length ? [h(Toasts, { key: "toasts", state })] : []),
          ...(state.palette ? [h(Palette, { key: "palette", state })] : []),
          ...(state.modal ? [h(Modal, { key: "modal", state })] : []),
        ),
  );
}
export function Screen({ state }) {
  const theme = useMemo(
    () => makeTheme({ color: state.color, glyphs: state.glyphs }),
    [state.color, state.glyphs],
  );
  return h(ThemeContext.Provider, { value: theme }, h(Frame, { state }));
}
export function App({ store }) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  useInput((input, key) => {
    const name = keyOf(input, key);
    if (name && typeof name === "object")
      store.dispatch({ type: "text", text: name.text });
    else if (name) store.dispatch({ type: "key", key: name });
  });
  usePaste((text) => store.dispatch({ type: "paste", text }));
  return h(Screen, { state });
}
