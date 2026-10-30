import { createElement } from "react";
import { render } from "ink";
import { connect, connection } from "../client.js";
import { startService as startInBackground } from "../service.js";
import { needs, statusRequest } from "./data.js";
import { reduce } from "./reducer.js";
import { initialState } from "./state.js";
import { pickGlyphs } from "./theme.js";
import { App } from "./ui/app.js";
import { TerminalInput } from "./input.js";

// The terminal menu: `pelican` with no arguments in a terminal, or `pelican
// menu`. It is a client like any other: every read and action is a gateway
// call through the same client the CLI uses, under the menu's caller name
// (--as, PELICAN_AS, default "menu"). State changes go through the reducer;
// Ink draws the state (src/menu/ui/) on the alternate screen, rewriting only
// the lines that changed.
const problem = (error) => ({
  message: error?.message ?? String(error),
  statusCode: error?.statusCode,
  code: error?.code,
});
const sizeOf = (output) => ({
  cols: output.columns || 80,
  rows: output.rows || 24,
});

// The state and what carries out the reducer's effects: gateway calls,
// starting the service, refreshes (one at a time; asking during one runs
// another after it). The App component subscribes to it.
export function createStore({
  client,
  as = "menu",
  url = null,
  size = { cols: 120, rows: 30 },
  now = Date.now,
  color = true,
  glyphs = "rich",
  splash = false,
  startService = startInBackground,
  onQuit = () => {},
  onRedraw = () => {},
  onError = (error) => {
    throw error;
  },
}) {
  let state = initialState({
    as,
    url,
    size,
    now: now(),
    color,
    glyphs,
    splash,
  });
  let closed = false,
    refreshing = false,
    again = false;
  const listeners = new Set();
  function dispatch(action) {
    if (closed) return;
    const out = reduce(state, { now: now(), ...action });
    if (out.state !== state) {
      state = out.state;
      for (const listener of listeners) listener();
    }
    for (const effect of out.effects) perform(effect);
  }
  async function fetch(request) {
    let action;
    try {
      action = {
        type: "data",
        request,
        result: await client.call(request.method, request.params),
      };
    } catch (error) {
      action = { type: "data", request, error: problem(error) };
    }
    dispatch(action);
  }
  async function refresh() {
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      do {
        again = false;
        await fetch(statusRequest);
        if (!closed && state.service.state === "up")
          await Promise.all(needs(state).map(fetch));
      } while (again && !closed);
    } finally {
      refreshing = false;
    }
  }
  function perform(effect) {
    switch (effect.type) {
      case "quit":
        return onQuit();
      case "refresh":
        return void refresh().catch(onError);
      case "redraw":
        return onRedraw();
      case "call":
        return void client
          .call(effect.method, effect.params)
          .then(
            (value) => dispatch({ type: "called", effect, result: value }),
            (error) =>
              dispatch({ type: "called", effect, error: problem(error) }),
          )
          .catch(onError);
      case "start-service":
        return void Promise.resolve()
          .then(() => startService())
          .then(
            () => dispatch({ type: "service", phase: "started" }),
            (error) =>
              dispatch({
                type: "service",
                phase: "failed",
                message: problem(error).message,
              }),
          )
          .catch(onError);
      default:
        return undefined;
    }
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

// Line wrap off while the menu runs: a cell written in the last column
// never pushes the cursor to the next line.
const wrapOff = "\x1b[?7l";
const wrapOn = "\x1b[?7h";
const mouseOn = "\x1b[?1000h\x1b[?1006h";
const mouseOff = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
const signals = { SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 };

// The menu in a terminal until q: Ink on the alternate screen, straight on
// the layout, the refresh every refreshMs, and the terminal put back as it
// was on quit, on errors and on signals. The terminal's own replies (focus
// events, cursor reports, device attributes) never reach the keys.
export function runMenu({
  client,
  as = "menu",
  url = null,
  input = process.stdin,
  output = process.stdout,
  refreshMs = 2000,
  startService = startInBackground,
  now = Date.now,
  color = !process.env.NO_COLOR,
  glyphs = pickGlyphs(),
  splash = process.env.PELICAN_SPLASH !== "off",
  mouse = process.env.PELICAN_MOUSE !== "off",
  handleSignals = false,
  ink = {},
}) {
  return new Promise((resolve, reject) => {
    const tty = Boolean(output.isTTY);
    let closed = false,
      timer = null,
      instance = null;
    const keys = new TerminalInput(input, {
      onMouse: (event) => {
        if (mouse && tty && !closed) {
          try {
            store.dispatch({ type: "mouse", ...event });
          } catch (error) {
            finish(error);
          }
        }
      },
    });
    const cleanups = [];
    const restoreWrap = () => {
      if (!tty) return;
      try {
        output.write(mouseOff + wrapOn);
      } catch {
        /* The terminal may be gone. */
      }
    };
    function finish(error) {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const cleanup of cleanups) cleanup();
      store.close();
      try {
        instance?.unmount();
      } catch {
        /* Unmounting a broken tree. */
      }
      keys.close();
      restoreWrap();
      if (error) reject(error);
      else resolve(0);
    }
    const store = createStore({
      client,
      as,
      url,
      size: sizeOf(output),
      now,
      color,
      glyphs,
      splash: tty && splash,
      startService,
      onQuit: () => finish(),
      onError: finish,
      // Ctrl+L: forget what is on screen and draw it all again.
      onRedraw: () => {
        instance?.clear();
        instance?.rerender(createElement(App, { store }));
      },
    });
    const guard =
      (fn) =>
      (...args) => {
        try {
          return fn(...args);
        } catch (error) {
          finish(error);
        }
      };
    try {
      if (tty) output.write(wrapOff);
      instance = render(createElement(App, { store }), {
        stdout: output,
        stdin: keys,
        exitOnCtrlC: false,
        patchConsole: false,
        alternateScreen: true,
        incrementalRendering: true,
        interactive: tty,
        maxFps: 30,
        ...ink,
      });
      if (tty && mouse) output.write(mouseOn);
      const resized = guard(() => {
        const size = sizeOf(output);
        const { cols, rows } = store.getState().size;
        if (size.cols !== cols || size.rows !== rows)
          store.dispatch({ type: "resize", ...size });
      });
      output.on?.("resize", resized);
      cleanups.push(() => output.off?.("resize", resized));
      if (handleSignals) {
        process.on("exit", restoreWrap);
        cleanups.push(() => process.off("exit", restoreWrap));
        for (const [signal, code] of Object.entries(signals)) {
          const stop = () => {
            finish();
            process.exit(code);
          };
          process.on(signal, stop);
          cleanups.push(() => process.off(signal, stop));
        }
      }
      // The resize event is the fast path; the tick also notices a new size.
      timer = setInterval(
        guard(() => {
          resized();
          store.dispatch({ type: "tick" });
        }),
        refreshMs,
      );
      store.dispatch({ type: "tick" });
    } catch (error) {
      finish(error);
    }
  });
}

// `pelican menu` from the CLI: ctx is the command's context. Without a
// terminal (or with --json) the CLI prints pelican status instead; see
// src/cli.js.
export async function menu(
  ctx,
  { input = process.stdin, output = process.stdout } = {},
) {
  const as = ctx.client.context?.as || "menu";
  const client = ctx.client.context?.as
    ? ctx.client
    : connect({ ...ctx.client.context, as });
  let url;
  try {
    ({ url } = await connection());
  } catch {
    url = process.env.PELICAN_URL ?? "http://127.0.0.1:4319";
  }
  await runMenu({ client, as, url, input, output, handleSignals: true });
  return null;
}
