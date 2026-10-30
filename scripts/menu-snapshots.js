// The menu's frames on the fixtures of test/menu-fixtures.js, as
// ink-testing-library draws them without colours.
//
//   node scripts/menu-snapshots.js                  rewrites test/menu-snapshots.js
//   node scripts/menu-snapshots.js --frames <dir>   also writes every screen at
//                                                   every size there, for review
//
// Run it after a deliberate change to the look, read the diff, then commit.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { Screen } from "../src/menu/ui/app.js";
import { needs, statusRequest } from "../src/menu/data.js";
import { reduce } from "../src/menu/reducer.js";
import { select } from "../src/menu/tree.js";
import * as f from "../test/menu-fixtures.js";

const plan = { needs, statusRequest };
export const sizes = {
  "80x24": { cols: 80, rows: 24 },
  "100x30": { cols: 100, rows: 30 },
  "120x30": { cols: 120, rows: 30 },
  "160x45": { cols: 160, rows: 45 },
};
// Each screen: the keys that lead there from a fresh, loaded menu (which
// opens on the first open question). In a narrow window, where one pane
// shows at a time, the screens of the right pane end with Enter.
export const screens = {
  sidebar: [],
  overview: ["home"],
  orchestrator: [{ select: "orch:lead" }],
  group: [{ select: "group:lead/asking" }],
  agent: [{ select: "agent:" + f.agents[0].id }],
  "agent-result": [{ select: "agent:" + f.agents[0].id }, "]", "]"],
  question: [],
  run: [{ select: "run:" + f.run.id }],
  workspace: [{ select: "ws:demo-2694" }],
  settings: [{ select: "ws:demo-2694" }, "enter", "e"],
  events: ["end"],
  actions: [{ select: "agent:" + f.agents[0].id }, "enter"],
  palette: [":", "a", "m", "b"],
  filter: ["/", "l", "e", "a", "d"],
  splash: [],
  service: [],
};
// The frames test/menu.test.js compares.
export const snapshots = [
  ["80x24", "sidebar"],
  ["100x30", "overview"],
  ["100x30", "agent"],
  ["120x30", "group"],
  ["120x30", "question"],
  ["120x30", "actions"],
  ["120x30", "settings"],
  ["120x30", "palette"],
  ["120x30", "splash"],
  ["120x30", "service"],
  ["160x45", "overview"],
];
export const snapshotName = (size, screen) =>
  `s${size}_${screen.replace(/-/g, "_")}`;

export function go(state, ...keys) {
  for (const key of keys) {
    const out = key.select
      ? reduce(select(state, key.select), { type: "tick" })
      : reduce(state, { type: "key", key });
    state = out.effects.some((e) => e.type === "refresh")
      ? f.load(out.state, plan)
      : out.state;
  }
  return state;
}
export function screenState(size, screen) {
  const state = go(
    f.load(f.fresh({ size: sizes[size] }), plan),
    ...screens[screen],
  );
  if (screen === "splash") return { ...state, splash: true };
  if (screen === "service")
    return {
      ...state,
      service: {
        state: "down",
        message: "Nothing answers at http://127.0.0.1:4319.",
      },
    };
  return state;
}

// ink-testing-library's terminal is 100 columns wide; each frame gets a
// terminal of its own width.
let columns = 100;
let patched = false;
function patch() {
  if (patched) return;
  patched = true;
  const probe = render(h("ink-text", null));
  Object.defineProperty(Object.getPrototypeOf(probe.stdout), "columns", {
    configurable: true,
    get: () => columns,
  });
  probe.unmount();
}
const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function frame(state) {
  patch();
  columns = state.size.cols;
  const app = render(h(Screen, { state }));
  try {
    return app.lastFrame().replace(ansi, "").split("\n");
  } finally {
    app.unmount();
  }
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  const out = [
    "// Frames of the menu on the fixtures of menu-fixtures.js, as",
    "// ink-testing-library draws them without colours. menu.test.js compares them.",
    "// scripts/menu-snapshots.js writes them; read the diff before keeping it.",
  ];
  for (const [size, screen] of snapshots) {
    out.push(`export const ${snapshotName(size, screen)} = [`);
    for (const line of frame(screenState(size, screen)))
      out.push(`  ${JSON.stringify(line)},`);
    out.push("];");
  }
  await writeFile(
    new URL("../test/menu-snapshots.js", import.meta.url),
    `${out.join("\n")}\n`,
  );
  console.log(`Wrote ${snapshots.length} frames to test/menu-snapshots.js.`);
  const at = process.argv.indexOf("--frames");
  if (at > 0) {
    const dir = resolve(process.argv[at + 1] ?? ".cache/menu-frames");
    await mkdir(dir, { recursive: true });
    const all = [];
    for (const size of Object.keys(sizes))
      for (const screen of Object.keys(screens)) {
        const text = frame(screenState(size, screen)).join("\n");
        await writeFile(join(dir, `${size}-${screen}.txt`), `${text}\n`);
        all.push(`=== ${size} ${screen} ===`, text, "");
      }
    await writeFile(join(dir, "all.txt"), all.join("\n"));
    console.log(
      `Wrote ${Object.keys(sizes).length * Object.keys(screens).length} frames to ${dir}.`,
    );
  }
}
