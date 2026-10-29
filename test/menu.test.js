import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { renderToString } from "ink";
import { App, Screen } from "../src/menu/ui/app.js";
import { createStore } from "../src/menu/index.js";
import { createReplyFilter } from "../src/menu/input.js";
import { clean, cut, fit, width, wrap } from "../src/menu/text.js";
import { keyOf } from "../src/menu/keys.js";
import {
  fitLine,
  lineWidth,
  plain,
  restyle,
  s,
  spread,
  wrapFacts,
  wrapLine,
} from "../src/menu/lines.js";
import { needs, statusRequest } from "../src/menu/data.js";
import { reduce } from "../src/menu/reducer.js";
import {
  initialState,
  lastToast,
  metricsEveryMs,
  orchestrators,
} from "../src/menu/state.js";
import { timelineEntry } from "../src/timeline.js";
import { isNarrow } from "../src/menu/layout.js";
import {
  rowLines,
  select,
  selectable,
  sideWidth,
  treeRows,
} from "../src/menu/tree.js";
import {
  currentItem,
  paneBox,
  paneModel,
  paneWindow,
} from "../src/menu/pane.js";
import { runAgents } from "../src/menu/views/run.js";
import { fuzzy, matchFields } from "../src/menu/fuzzy.js";
import {
  chart,
  gauge,
  phaseStates,
  progress,
  spark,
  stepper,
  strip,
} from "../src/menu/charts.js";
import { glyphSets, makeTheme, pickGlyphs } from "../src/menu/theme.js";
import {
  logo,
  mark,
  pelican,
  wordmark,
  slogan,
  motto,
} from "../src/menu/art.js";
import { paletteResults } from "../src/menu/palette.js";
import { footerHints } from "../src/menu/ui/chrome.js";
import {
  frame,
  screens,
  screenState,
  snapshotName,
  snapshots,
} from "../scripts/menu-snapshots.js";
import { until } from "./helpers.js";
import * as f from "./menu-fixtures.js";
import * as frames from "./menu-snapshots.js";

// The menu without a terminal: the reducer on fixture data and a fixed
// clock, and its frames drawn by Ink (ink-testing-library for the
// snapshots, renderToString, which draws the same, for the other checks).
const plan = { needs, statusRequest };
const at = (cols, rows) => ({ size: { cols, rows } });
const loaded = (extra, overrides) => f.load(f.fresh(extra), plan, overrides);
// Presses keys one by one; after each, the refresh it asks for is answered
// from the fixtures (and the overrides of using()). A key may be { text } or
// { paste }. Returns the state and the last key's effects.
let fixture = {};
const using = (overrides, run) => {
  fixture = overrides;
  try {
    return run();
  } finally {
    fixture = {};
  }
};
function press(state, ...keys) {
  let effects = [];
  for (const key of keys) {
    const action =
      typeof key === "object"
        ? key.paste !== undefined
          ? { type: "paste", text: key.paste }
          : { type: "text", text: key.text }
        : { type: "key", key };
    const out = reduce(state, action);
    effects = out.effects;
    state = effects.some((e) => e.type === "refresh")
      ? f.load(out.state, plan, fixture)
      : out.state;
  }
  return { state, effects };
}
const go = (state, ...keys) => press(state, ...keys).state;
const calls = (effects) => effects.filter((e) => e.type === "call");
// Selects a sidebar item directly; its pane is read as a refresh would.
const to = (state, id) =>
  f.load(reduce(select(state, id), { type: "tick" }).state, plan, fixture);
const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const nbsp = new RegExp(String.fromCharCode(0xa0), "g");
const text = (state) =>
  renderToString(h(Screen, { state }), { columns: state.size.cols })
    .replace(ansi, "")
    .replace(nbsp, " ");
const lines = (state) => text(state).split("\n");
// The right pane's lines, without its border.
function paneLines(state) {
  return lines(state)
    .slice(0, -1)
    .map((line) => line.slice(49));
}
// The right pane's content, and the sidebar's column, as text.
const pane = (state) =>
  paneLines(state)
    .map((l) => l.trimEnd())
    .join("\n");
const side = (state) => {
  const cells = isNarrow(state) ? state.size.cols : sideWidth(state);
  return lines(state)
    .map((l) => [...l].slice(0, cells).join(""))
    .join("\n");
};
const flat = (list) => list.join(" ").replace(/\s+/g, " ");
const ids = (state) => selectable(treeRows(state)).map((r) => r.id);
const w = (state) => paneWindow(state, paneModel(state), paneBox(state));

const [amber, cedar, jade, opal] = f.agents.map((a) => a.id);
const q1 = `q:${amber}/q1111111-aaaa`;
const q2 = `q:${cedar}/q2222222-bbbb`;
// Amber Heron's chat, with the right pane's keys.
const chat = (size = at(100, 30)) =>
  go(loaded(size), "down", "down", "down", "enter");

test("text is cleaned of control sequences, measured in cells, cut and wrapped", () => {
  assert.equal(
    clean("a\x1b[31mred\x1b[0m\tb\x07\x1b]0;title\x07!"),
    "ared  b!",
  );
  assert.equal(clean("one\r\ntwo\rthree"), "one\ntwo\nthree");
  assert.equal(width("日本"), 4);
  assert.equal(width("é"), 1);
  assert.equal(width("🙂"), 2);
  assert.equal(cut("abcdef", 4), "abc…");
  assert.equal(fit("ab", 4), "ab  ");
  assert.equal(width(fit("日本語", 4)), 4);
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrap("averyveryverylongword", 8, "> "), [
    "averyver",
    "> yveryl",
    "> ongwor",
    "> d",
  ]);
});

test("keys come from Ink's input events", () => {
  const k = (input, key = {}) => keyOf(input, key);
  assert.equal(k("", { upArrow: true }), "up");
  assert.equal(k("", { pageDown: true }), "pagedown");
  assert.equal(k("", { home: true }), "home");
  assert.equal(k("\r", { return: true }), "enter");
  assert.equal(k("", { escape: true }), "escape");
  assert.equal(k("", { tab: true }), "tab");
  assert.equal(k("", { tab: true, shift: true }), "shift+tab");
  assert.equal(k("", { backspace: true }), "backspace");
  assert.equal(k("", { delete: true }), "delete");
  assert.equal(k("c", { ctrl: true }), "ctrl+c");
  assert.equal(k("k", { ctrl: true }), "ctrl+k");
  assert.equal(k("S", { shift: true }), "S");
  assert.equal(k(":"), ":");
  assert.equal(k("["), "[");
  assert.equal(k("é"), "é");
  assert.equal(k("q", { meta: true }), null);
  assert.equal(k("\x07"), null);
  // Several characters at once are text (a paste without bracketed paste).
  assert.deepEqual(k("abc"), { text: "abc" });
});

test("terminal replies never become keys: focus events, cursor reports, device attributes and string replies are dropped, also when split", () => {
  const filter = createReplyFilter();
  const replies = [
    "\x1b[I",
    "\x1b[O",
    "\x1b[12;40R",
    "\x1b[?1;2c",
    "\x1b[>0;276;0c",
    "\x1b[0n",
    "\x1b[?2026;2$y",
    "\x1b[?0u",
    "\x1b[8;30;100t",
    "\x1b[<0;12;5M",
    "\x1b]11;rgb:0000/0000/0000\x1b\\",
    "\x1b]10;rgb:ffff/ffff/ffff\x07",
    "\x1bP>|xterm(380)\x1b\\",
  ];
  for (const reply of replies)
    assert.equal(filter.push(reply), "", JSON.stringify(reply));
  // Keys pass: letters, arrows, Enter, Tab, a paste, between replies.
  assert.equal(
    filter.push("j\x1b[I\x1b[Ak\r\t\x1b[O\x1b[200~text\x1b[201~"),
    "j\x1b[Ak\r\t\x1b[200~text\x1b[201~",
  );
  // A reply split across reads is held until its end comes.
  assert.equal(filter.push("x\x1b]11;rgb:00"), "x");
  assert.equal(filter.pending, true);
  assert.equal(filter.push("00/0000/0000\x1b\\y"), "y");
  assert.equal(filter.push("\x1b[12;"), "");
  assert.equal(filter.push("40Rz"), "z");
  // A lone Escape waits a moment for the rest, then goes on as a key.
  assert.equal(filter.push("\x1b"), "");
  assert.equal(filter.wait, 25);
  assert.equal(filter.flush(), "\x1b");
  // A string start that never ends was a key (Alt+]): its ESC is dropped.
  assert.equal(filter.push("\x1b]q"), "");
  assert.equal(filter.wait, 150);
  assert.equal(filter.flush(), "q");
  assert.equal(filter.pending, false);
});

test("spans are fitted, spread, restyled and wrapped; facts break between them", () => {
  assert.equal(
    plain(
      fitLine(
        [
          ["abc", "bold"],
          ["defg", ""],
        ],
        5,
      ),
    ),
    "abcde",
  );
  assert.equal(lineWidth(fitLine([["ab", ""]], 6, "selected")), 6);
  assert.equal(
    plain(spread([["left", ""]], [["right", ""]], 12)),
    "left   right",
  );
  // A right part that does not fit is left out.
  assert.equal(
    plain(spread([["a long left", ""]], [["right", ""]], 12)),
    "a long left ",
  );
  assert.deepEqual(
    restyle(
      [
        ["a", "bold accent"],
        ["b", "muted"],
        ["c", "accent spin"],
      ],
      "selected",
    ),
    [
      ["a", "selected bold"],
      ["b", "selected"],
      ["c", "selected spin"],
    ],
  );
  // Wrapping keeps every character: at spaces, after - / : _ . in a long
  // word, and continuation lines are indented.
  const wrapped = (line, cells, indent) =>
    wrapLine(line, cells, indent).map(plain);
  assert.deepEqual(
    wrapped(
      [
        ["$ npm test", "accent"],
        ["  exit 1", "err"],
      ],
      8,
      2,
    ),
    ["$ npm", "  test", "  exit 1"],
  );
  assert.deepEqual(
    wrapped([["  mcp:my-project-monitor-fleet-lead", ""]], 20, 2),
    ["  mcp:my-project-", "  monitor-fleet-lead"],
  );
  assert.deepEqual(wrapped([["averyveryverylongword", ""]], 8, 2), [
    "averyver",
    "  yveryl",
    "  ongwor",
    "  d",
  ]);
  assert.deepEqual(wrapped([], 10), [""]);
  // Styles stay with their text across the break.
  assert.deepEqual(wrapLine([["one two", "ok"]], 4), [
    [["one", "ok"]],
    [["two", "ok"]],
  ]);
  // Facts: a line breaks between two facts, so no separator is left at
  // either end of a line.
  assert.deepEqual(
    wrapFacts(
      [
        [["◆ asking", ""]],
        [["owner lead", ""]],
        [["demo-2694", ""]],
        [["12.3k tokens", ""]],
      ],
      30,
      { indent: 2 },
    ).map(plain),
    ["◆ asking · owner lead", "  demo-2694 · 12.3k tokens"],
  );
  // What agents write cannot reach the terminal as escape sequences.
  assert.equal(plain(fitLine([[clean("\x1b[2Jhi"), ""]], 4)), "hi  ");
});

test("fuzzy matching: substrings and word starts first, every term must match", () => {
  assert.deepEqual(fuzzy("heron", "Amber Heron").positions, [6, 7, 8, 9, 10]);
  assert.ok(fuzzy("ah", "Amber Heron"));
  assert.equal(fuzzy("xz", "Amber Heron"), null);
  assert.ok(
    fuzzy("amb", "Amber Heron").score > fuzzy("amb", "a mobile bay").score,
  );
  assert.ok(fuzzy("fl", "Fix login").score < fuzzy("fl", "flaky").score);
  assert.equal(matchFields("", ["x"]), 0);
  assert.ok(matchFields("lead fix", ["Fix the flaky login test", "lead"]) > 0);
  assert.equal(
    matchFields("lead nope", ["Fix the flaky login test", "lead"]),
    null,
  );
});

test("charts: sparklines, strips, gauges, progress bars, a phase stepper and a bar chart", () => {
  const g = glyphSets.rich;
  assert.equal(plain(spark([0, 1, 2, 4], 4, { g })), "▁▃▅█");
  // Fewer values than room: the baseline fills the left.
  assert.equal(plain(spark([4], 3, { g })), "▁▁█");
  assert.deepEqual(
    spark([0, 4], 2, { g }).map(([, style]) => style),
    ["muted", "accent"],
  );
  assert.equal(plain(strip([0, 1, 2, 3, 4], 5, { g })), "·░▒▓█");
  assert.equal(plain(gauge(2, 10, 10, { g })), "━━────────");
  assert.equal(gauge(10, 10, 4, { g })[0][1], "warn");
  // Any work shows, however little.
  assert.equal(plain(gauge(1, 64, 8, { g })), "━───────");
  assert.deepEqual(
    progress({ done: 1, failed: 1, live: 1, total: 4 }, 8, { g }).map(
      ([t, style]) => [t.length, style],
    ),
    [
      [2, "ok"],
      [2, "err"],
      [2, "accent dim"],
      [2, "muted"],
    ],
  );
  const phases = [
    { title: "Survey", agents: [{ status: "completed" }] },
    {
      title: "Fix login",
      agents: [{ status: "running" }, { status: "failed" }],
    },
    { title: "Review", agents: [] },
  ];
  assert.deepEqual(phaseStates(phases), ["done", "current", "pending"]);
  const nbsp = String.fromCharCode(0xa0);
  const steps = (cells, extra) =>
    stepper(phases, cells, { g, ...extra }).map((l) =>
      plain(l).replaceAll(nbsp, " "),
    );
  assert.deepEqual(steps(80, { runStatus: "running" }), [
    "✓ Survey ━━ ◉ Fix login ── ○ Review",
  ]);
  // A narrow stepper wraps between phases; no title is cut or split.
  assert.deepEqual(steps(20), ["✓ Survey ━━", "◉ Fix login ──", "○ Review"]);
  assert.deepEqual(chart([0, 3, 4], 6, 2, { g }).map(plain), [
    "4 ┤ ▄█",
    "0 ┴▁██",
  ]);
  // The plain glyphs for the classic console host.
  assert.equal(plain(spark([0, 1, 7], 3, { g: glyphSets.plain })), "_.#");
});

test("the theme maps styles to Ink props; NO_COLOR keeps bold and inverse; glyphs follow the terminal", () => {
  const coloured = makeTheme({ color: true });
  assert.deepEqual(coloured.props("ok bold"), { bold: true, color: "#92ae99" });
  assert.deepEqual(coloured.props("selected bold"), {
    bold: true,
    color: "#d0e3e1",
    backgroundColor: "#293738",
  });
  assert.deepEqual(coloured.props("on-err bold"), {
    bold: true,
    color: "whiteBright",
    backgroundColor: "#cf8b82",
  });
  assert.deepEqual(coloured.props("muted"), { color: "#7e858e" });
  assert.deepEqual(coloured.props("dim"), { color: "#7e858e" });
  assert.deepEqual(coloured.props("bold #22d3ee"), {
    bold: true,
    color: "#22d3ee",
  });
  assert.equal(coloured.tone("accent"), "#8bbebb");
  const bare = makeTheme({ color: false });
  assert.deepEqual(bare.props("ok bold"), { bold: true });
  assert.deepEqual(bare.props("selected"), { inverse: true, bold: true });
  assert.deepEqual(bare.props("on-ok"), { inverse: true });
  assert.deepEqual(bare.props("dim"), { dimColor: true });
  assert.equal(bare.tone("accent"), undefined);
  // Rich glyphs where the fonts have them, plain ones in the console host.
  assert.equal(pickGlyphs({}, "linux"), "rich");
  assert.equal(pickGlyphs({ WT_SESSION: "x" }, "win32"), "rich");
  assert.equal(pickGlyphs({ TERM_PROGRAM: "vscode" }, "win32"), "rich");
  assert.equal(pickGlyphs({ TERM: "xterm-256color" }, "win32"), "rich");
  assert.equal(pickGlyphs({}, "win32"), "plain");
  assert.equal(pickGlyphs({ PELICAN_GLYPHS: "plain" }, "darwin"), "plain");
  // The art: the header's one-row mark, a pelican and the wordmark.
  assert.equal(plain(mark()), "(o)__");
  assert.equal(pelican("bust").map(plain)[1].trimEnd(), "   / o  `.________");
  assert.equal(wordmark().map(plain)[0], logo[0]);
});

const wholePane = (state) => {
  const model = paneModel(state);
  return [...model.head, ...model.body].map(plain).join("\n");
};
function locate(state, label, paneOnly = false) {
  for (const [y, line] of lines(state).entries()) {
    let from = 0;
    while (from < line.length) {
      const index = line.indexOf(label, from);
      if (index < 0) break;
      const x = width(line.slice(0, index));
      if (!paneOnly || x >= 46) return { x, y };
      from = index + 1;
    }
  }
  assert.fail("Missing control " + label + "\n" + text(state));
}
function mouse(state, x, y, rest = {}) {
  const out = reduce(state, {
    type: "mouse",
    kind: "press",
    button: 0,
    x,
    y,
    ...rest,
  });
  return {
    ...out,
    state: out.effects.some((e) => e.type === "refresh")
      ? f.load(out.state, plan, fixture)
      : out.state,
  };
}
function click(state, label, paneOnly = false) {
  const { x, y } = locate(state, label, paneOnly);
  return mouse(state, x, y);
}
test("supported screens fill the frame and small terminals show a branded notice", () => {
  for (const size of ["80x24", "100x30", "120x30", "160x45"])
    for (const name of Object.keys(screens)) {
      const state = screenState(size, name),
        shown = lines(state);
      assert.equal(shown.length, state.size.rows - 1, size + " " + name);
      assert.ok(
        shown.every((line) => width(line) <= state.size.cols),
        size + " " + name,
      );
      if (size === "80x24")
        assert.match(shown.join("\n"), /Pelican needs 100 x 28/);
      else
        // Nothing is cut but the summary of a collapsed command or edit,
        // known by its verb or, when a menu covers the start of the row, by
        // the status at its end.
        for (const row of shown)
          if (row.includes("…"))
            assert.match(
              row,
              /[▸>] (?:Ran|Running|Edited) |… {2,}[✓✗●+]/,
              `${size} ${name}: ${row}`,
            );
    }
});

test("reviewed fixture frames match the rendered screens", () => {
  for (const [size, screen] of snapshots)
    assert.deepEqual(
      frame(screenState(size, screen)),
      frames[snapshotName(size, screen)],
      size + " " + screen,
    );
});

test("the splash keeps one ASCII alignment and waits for any key", () => {
  const state = { ...loaded(at(120, 30)), splash: true };
  const shown = lines(state),
    value = shown.join("\n");
  assert.match(value, /Press any key to start/);
  const caption = [slogan, ...motto];
  const captionAt = shown.findIndex((line) => line.includes(slogan));
  assert.deepEqual(
    shown.slice(captionAt, captionAt + 3).map((line) => line.trim()),
    caption,
  );
  assert.equal(
    new Set(caption.map((line, i) => shown[captionAt + i].indexOf(line))).size,
    1,
  );
  assert.equal(new Set(logo.map((line) => width(line))).size, 1);
  const offsets = logo.map(
    (line) =>
      shown.find((row) => row.includes(line.trim())).indexOf(line.trim()) -
      line.search(/\S/),
  );
  assert.equal(new Set(offsets).size, 1);
  assert.equal(reduce(state, { type: "tick" }).state.splash, true);
  const out = press(state, "m");
  assert.equal(out.state.splash, false);
  assert.equal(out.state.modal, null);
  assert.deepEqual(calls(out.effects), []);
  assert.equal(sideWidth(state), 46);
  const main = to({ ...state, splash: false }, "pelican");
  assert.match(
    side(main),
    /Briefs out\. Results back\.[\s\S]*Codex agents for any orchestrator\.[\s\S]*Queued, watched, on the record\./,
  );
});

test("selections display immediately; Enter opens visible actions and headers stay quiet", () => {
  const state = to(loaded(at(120, 30)), "agent:" + amber);
  assert.match(pane(state), /Amber Heron/);
  assert.equal(state.focus, "side");
  assert.doesNotMatch(lines(state).slice(0, 4).join("\n"), /Actions|Refresh/);
  assert.match(lines(state).at(-1), /Actions/);
  const menu = go(state, "enter");
  assert.equal(menu.modal.kind, "actions");
  assert.match(text(menu), /Answer\s+a/);
  assert.match(text(menu), /Refresh\s+r/);
  for (const key of [
    "a",
    "m",
    "x",
    "u",
    "e",
    "S",
    "r",
    "?",
    "ctrl+k",
    "ctrl+l",
    "j",
    "k",
    "g",
    "G",
    "tab",
    "shift+tab",
  ]) {
    const out = press(state, key);
    assert.equal(out.state, state, key);
    assert.deepEqual(out.effects, [], key);
  }
  assert.deepEqual(press(menu, "r").effects, [{ type: "refresh" }]);
});

test("the fixed sidebar has arrow-reachable Search and Commands", () => {
  const state = go(loaded(at(120, 30)), "home");
  const search = go(state, "up");
  assert.equal(search.focus, "search");
  assert.equal(search.selected, "pelican");
  assert.match(side(search), /› \/ Search/);
  const filtered = go(search, "enter", "a", "m", "b");
  assert.equal(filtered.filter, "amb");
  assert.equal(filtered.selected, q1);
  const commands = go(state, "end", "down");
  assert.equal(commands.focus, "commands");
  assert.match(side(commands), /› : Commands/);
  assert.ok(go(commands, "enter").palette);
  assert.equal(sideWidth({ ...state, size: { cols: 160, rows: 45 } }), 46);
});

test("search restores its placeholder when empty, and no matches clear the detail pane", () => {
  const state = to(loaded(at(120, 30)), "agent:" + amber);
  assert.ok(
    !footerHints({ ...state, focus: "search" }).some(([key]) => key === "[]"),
  );
  const empty = go(state, "/", { text: "zzzz-no-matches" });
  assert.match(side(empty), /Nothing matches/);
  assert.ok(
    lines(empty)
      .slice(0, -1)
      .every((line) => !line.slice(46).trim()),
  );
  const ignored = press(empty, "enter", "x", "m");
  assert.equal(ignored.state.modal, null);
  assert.deepEqual(calls(ignored.effects), []);
  assert.ok(!needs(empty).some((r) => ["get", "tail"].includes(r.method)));
  const cleared = go(empty, "ctrl+u");
  assert.equal(cleared.filtering, false);
  assert.equal(cleared.focus, "search");
  assert.match(side(cleared), /› \/ Search/);
  const typed = go(
    cleared,
    "a",
    "m",
    "b",
    "backspace",
    "backspace",
    "backspace",
  );
  assert.equal(typed.filtering, false);
  assert.equal(typed.filter, "");
  const resumed = go(typed, { text: "cedar" });
  assert.equal(resumed.filtering, true);
  assert.equal(go(resumed, "down").focus, "side");
  assert.equal(go(resumed, "escape").filter, "");
});

test("changing settings alone does not list a caller as an orchestrator", () => {
  const entries = ["menu", "terminal"].map((by, i) =>
    timelineEntry(
      {
        seq: i + 1,
        at: f.at(10 - i),
        type: "settings.updated",
        data: { by, changes: { effort: "max" } },
      },
      "demo-2694",
    ),
  );
  const state = loaded(at(120, 30), {
    list: () => [],
    questions: () => [],
    "runs.list": () => [],
    feed: () => ({ entries, cursor: "demo-2694:2" }),
  });
  assert.deepEqual(orchestrators(state), []);
  assert.ok(!ids(state).some((id) => id.startsWith("orch:")));
  assert.ok(!paletteResults(state).some((r) => r.kind === "orchestrator"));
  assert.match(wholePane(state), /Nobody has orchestrated yet/);
  assert.deepEqual(state.timeline.entries, entries);

  // The same caller becomes an orchestrator by narrating its work. Its
  // earlier settings change still belongs to its timeline and last action.
  const noted = reduce(state, {
    type: "data",
    request: {
      key: "timeline",
      method: "feed",
      params: { all: true, after: state.timeline.cursor },
    },
    result: {
      cursor: "demo-2694:3",
      entries: [
        timelineEntry(
          {
            seq: 3,
            at: f.at(0),
            type: "orchestrator.note",
            data: { by: "menu", text: "Preparing the agents." },
          },
          "demo-2694",
        ),
      ],
    },
  }).state;
  assert.deepEqual(
    orchestrators(noted).map((r) => r.name),
    ["menu"],
  );
  assert.equal(orchestrators(noted)[0].lastAction, entries[0]);
  assert.ok(ids(noted).includes("orch:menu"));

  // Agent ownership also qualifies, even with only settings in the feed.
  const owned = { ...state, data: { ...state.data, fleet: [f.agents[3]] } };
  assert.deepEqual(
    orchestrators(owned).map((r) => r.name),
    ["menu"],
  );
  assert.equal(orchestrators(owned)[0].lastAction, entries[0]);
});

function crowdAgent(n, status, extra = {}) {
  return {
    ...f.agents[3],
    id: `eeee${String(n).padStart(4, "0")}-0000-4000-8000-000000000000`,
    agentName: `Agent ${n}`,
    name: `Task ${n}`,
    owner: "lead",
    workspace: "demo-2694",
    status,
    questions: 0,
    tokens: n * 100,
    ...extra,
  };
}
// Lead's agents: two working, one asking, three done, one failed, one stopped.
const crowd = [
  ...[1, 2].map((n) => crowdAgent(n, "running")),
  crowdAgent(3, "waiting", { questions: 1 }),
  ...[4, 5, 6].map((n) =>
    crowdAgent(n, "completed", { finishedAt: f.at(1000 - n) }),
  ),
  crowdAgent(7, "failed", { finishedAt: f.at(900) }),
  crowdAgent(8, "cancelled", { finishedAt: f.at(800) }),
];
// Runs with these agents in the fleet; run gets the loaded menu.
const withFleet = (list, run) =>
  using({ list: () => list }, () =>
    run(f.load(f.fresh(at(120, 30)), plan, fixture)),
  );

test("an orchestrator counts its agents in groups instead of listing them", () => {
  withFleet(crowd, (base) => {
    const state = to(base, "orch:lead");
    assert.ok(!ids(state).some((id) => id.startsWith("agent:")));
    const groups = treeRows(state).filter((r) => r.kind === "group");
    assert.deepEqual(
      groups.map((r) => [r.id, r.name, r.tail[0][0]]),
      [
        ["group:lead/asking", "asking", "1"],
        ["group:lead/working", "working", "2"],
        ["group:lead/done", "done", "3"],
        ["group:lead/failed", "failed", "1"],
        ["group:lead/stopped", "stopped", "1"],
      ],
    );
    // Empty groups are not listed; the others sit under their orchestrator.
    assert.ok(groups.every((r) => r.parent === "orch:lead" && r.depth === 1));
    const shown = side(state);
    assert.match(shown, /◆ asking +1/);
    assert.match(shown, /✓ done +3/);
    assert.doesNotMatch(shown, /Agent \d/);
    assert.doesNotMatch(shown, /finished/);
    // The orchestrator still folds, and its groups go with it.
    const closed = go(state, "left");
    assert.ok(!ids(closed).some((id) => id.startsWith("group:lead/")));
    const opened = go(closed, "right");
    assert.ok(ids(opened).includes("group:lead/done"));
    assert.equal(
      go(to(opened, "group:lead/done"), "left").selected,
      "orch:lead",
    );
    assert.match(lines(state).at(-1), /Fold/);
    // The orchestrator of the selected group stays open.
    const kept = to(
      { ...state, open: { ...state.open, lead: false } },
      "group:lead/done",
    );
    assert.ok(ids(kept).includes("group:lead/done"));
  });
});

test("a group lists its agents in the right pane: arrows pick, Enter opens, Backspace goes back", () => {
  withFleet(crowd, (base) => {
    const start = to(base, "group:lead/done");
    const listed = pane(start);
    for (const n of [4, 5, 6]) assert.match(listed, new RegExp(`Agent ${n}`));
    assert.doesNotMatch(listed, /Agent [1-3]|Agent [78]/);
    assert.match(listed, /3 agents/);
    // Newest first: Agent 6, then 5, then 4.
    const [first, second, third] = [6, 5, 4].map(
      (n) => crowd.find((a) => a.agentName === `Agent ${n}`).id,
    );

    // Enter on the group hands the keys to its list; the first agent is
    // picked, and ↓ picks the next one.
    const focused = go(start, "enter");
    assert.equal(focused.focus, "pane");
    assert.equal(focused.selected, "group:lead/done");
    assert.deepEqual(
      footerHints(focused).map((h) => h[1]),
      ["Refresh", "Select", "Jump", "Open", "Sidebar", "Quit"],
    );
    const next = go(focused, "down");
    assert.equal(next.pick["group:lead/done"], second);
    assert.equal(go(next, "up").pick["group:lead/done"], first);
    assert.equal(go(focused, "end").pick["group:lead/done"], third);
    assert.equal(go(focused, "right").pick["group:lead/done"], undefined);

    // Enter opens the picked agent: its row shows under its group, its
    // conversation in the pane, and the pane keeps the keys.
    const opened = go(next, "enter");
    assert.equal(opened.selected, "agent:" + second);
    assert.equal(opened.focus, "pane");
    const rows = treeRows(opened);
    const at = rows.findIndex((r) => r.id === "agent:" + second);
    assert.equal(rows[at - 1].id, "group:lead/done");
    assert.equal(rows[at].parent, "group:lead/done");
    assert.equal(rows.filter((r) => r.kind === "agent").length, 1);
    assert.ok(footerHints(opened).some((h) => h[0] === "Backspace"));

    // Backspace comes back to the list with that agent still picked.
    for (const key of ["backspace", "delete"]) {
      const back = go(opened, key);
      assert.equal(back.selected, "group:lead/done");
      assert.equal(back.focus, "pane");
      assert.equal(back.pick["group:lead/done"], second);
      assert.ok(!ids(back).some((id) => id.startsWith("agent:")));
    }
    // From the sidebar, Backspace and ← do the same and leave the keys there.
    const aside = to(start, "agent:" + second);
    assert.ok(footerHints(aside).some((h) => h[0] === "Backspace"));
    for (const key of ["backspace", "left"]) {
      const back = go(aside, key);
      assert.equal(back.selected, "group:lead/done");
      assert.equal(back.focus, "side");
      assert.equal(back.pick["group:lead/done"], second);
    }
    // Backspace elsewhere does nothing.
    assert.equal(go(start, "backspace").selected, "group:lead/done");

    // A click on an agent of the list opens it.
    const { x, y } = locate(start, "Agent 5", true);
    const clicked = mouse(start, x, y).state;
    assert.equal(clicked.selected, "agent:" + second);
    assert.equal(clicked.focus, "pane");
  });
});

test("a group's list scrolls to keep its picked agent in view", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    crowdAgent(i + 10, "completed", { finishedAt: f.at(2000 - i) }),
  );
  withFleet(many, (base) => {
    const state = go(to(base, "group:lead/done"), "enter");
    const inView = (s) => {
      const model = paneModel(s),
        view = paneWindow(s, model, paneBox(s));
      return (
        model.pickLine.line >= view.top &&
        model.pickLine.line + model.pickLine.size <= view.top + view.room
      );
    };
    // Newest first, so the last in the list is the oldest.
    const last = go(state, "end");
    assert.equal(last.pick["group:lead/done"], many[0].id);
    assert.ok(inView(last));
    assert.ok(paneWindow(last, paneModel(last), paneBox(last)).top > 0);
    const up = go(last, "pageup", "pageup");
    assert.ok(inView(up));
    assert.notEqual(up.pick["group:lead/done"], many[0].id);
    const top = go(up, "home");
    assert.equal(top.pick["group:lead/done"], many.at(-1).id);
    assert.ok(inView(top));
  });
});

test("a group that empties leaves the selection on a row that exists", () => {
  withFleet(crowd, (base) => {
    const start = to(base, "group:lead/working");
    const rest = crowd.filter((a) => a.status !== "running");
    const gone = using({ list: () => rest }, () =>
      f.load(start, plan, fixture),
    );
    assert.ok(!ids(gone).includes("group:lead/working"));
    assert.ok(ids(gone).includes(gone.selected));
  });
});

test("a workflow's agents can be clicked or picked, and Backspace comes back to it", () => {
  const id = "run:" + f.run.id;
  const start = to(loaded(at(120, 30)), id);
  // Opal Lark (Survey), Amber Heron and Cedar Wren (Fix), in phase order.
  const [first, second, third] = [opal, amber, cedar];
  assert.match(pane(start), /Fix login/);

  // Clicking an agent opens it; Backspace returns to the workflow.
  const { x, y } = locate(start, "Fix login", true);
  const clicked = mouse(start, x, y).state;
  assert.equal(clicked.selected, "agent:" + amber);
  assert.equal(clicked.focus, "pane");
  assert.deepEqual(clicked.from, { agent: amber, to: id });
  const back = go(clicked, "backspace");
  assert.equal(back.selected, id);
  assert.equal(back.focus, "pane");
  assert.equal(back.pick[id], amber);
  assert.equal(back.from, null);

  // → gives the workflow the keys; ↑↓ pick, Enter opens.
  assert.ok(footerHints(start).some((h) => h[0] === "right"));
  const focused = go(start, "right");
  assert.equal(focused.focus, "pane");
  assert.deepEqual(
    footerHints(focused).map((h) => h[1]),
    ["Refresh", "Select", "Jump", "Scroll", "Open", "Sidebar", "Quit"],
  );
  const next = go(focused, "down");
  assert.equal(next.pick[id], second);
  assert.equal(go(next, "down", "down").pick[id], third);
  assert.equal(go(next, "up").pick[id], first);
  const opened = go(next, "enter");
  assert.equal(opened.selected, "agent:" + amber);
  assert.deepEqual(opened.from, { agent: amber, to: id });
  // From the sidebar, Backspace and ← go back to the workflow too, and the
  // memory ends when the selection goes elsewhere.
  for (const key of ["backspace", "left"]) {
    const aside = { ...opened, focus: "side" };
    assert.equal(go(aside, key).selected, id);
  }
  assert.equal(go({ ...opened, focus: "side" }, "down").from, null);
  // An agent opened any other way goes back to its group.
  assert.equal(
    go(to(start, "agent:" + amber), "backspace").selected,
    "group:lead/asking",
  );
  // PgUp, PgDn, Home and End still scroll a workflow.
  assert.equal(go(focused, "end").pick[id], undefined);

  // Agents the fleet does not know are not offered.
  using({ list: () => f.agents.filter((a) => a.id !== cedar) }, () => {
    const some = to(loaded(at(120, 30), undefined), id);
    assert.deepEqual(
      runAgents(some, currentItem(some)).map((a) => a.id),
      [opal, amber],
    );
  });
});

test("a workflow's count stays on its row when its name is long", () => {
  const g = glyphSets.rich;
  const row = (name) => ({
    id: "run:x",
    kind: "run",
    depth: 0,
    icon: s("●"),
    name,
    nameStyle: "",
    tail: [s("2/3")],
    keepTail: true,
  });
  const long = "Reconcile every bookmaker market with its exchange price";
  const shown = rowLines(row(long), 43, { g }).map(plain);
  assert.ok(shown.length > 1);
  assert.match(shown[0], /2\/3 *$/);
  assert.ok(shown.slice(1).every((line) => !/2\/3/.test(line)));
  assert.equal(
    shown.join("").replace(/[\s●›]+|2\/3/g, ""),
    long.replace(/\s/g, ""),
  );
  assert.ok(shown.every((line) => width(line) <= 43));
  // A name that fits is on one line, as before.
  assert.equal(rowLines(row("Short"), 43, { g }).length, 1);
  // The sidebar's workflow rows ask for it.
  const state = loaded(at(120, 30));
  assert.ok(
    treeRows(state)
      .filter((r) => r.kind === "run")
      .every((r) => r.keepTail),
  );
});

test("agent menu actions keep confirmations, messages, resume and takeover semantics", () => {
  const state = to(loaded(at(120, 30)), "agent:" + amber);
  const stopped = go(state, "enter", "x");
  assert.equal(stopped.modal.kind, "confirm");
  assert.equal(
    calls(press(stopped, "enter").effects).length,
    0,
    "destructive confirmation defaults to No",
  );
  const effect = calls(press(stopped, "y").effects)[0];
  assert.deepEqual(effect.params, {
    id: amber,
    reason: "Stopped from the Pelican menu by menu",
  });
  let message = go(state, "enter", "m", {
    paste: "Fix the parser\nRun its tests",
  });
  assert.equal(message.modal.value, "Fix the parser\nRun its tests");
  message = go(message, "tab");
  assert.equal(message.modal.mode, "followup");
  const sent = press(message, "enter");
  assert.deepEqual(calls(sent.effects)[0].params, {
    id: amber,
    text: "Fix the parser\nRun its tests",
    mode: "followup",
  });
  const takeover = reduce(sent.state, {
    type: "called",
    effect: calls(sent.effects)[0],
    error: { statusCode: 403, message: "Agent belongs to lead." },
  }).state;
  assert.equal(takeover.modal.kind, "confirm");
  assert.equal(calls(press(takeover, "y").effects)[0].params.takeover, true);
  const done = to(state, "agent:" + opal),
    resume = go(done, "enter", "u", { text: "Check the final result" });
  assert.equal(calls(press(resume, "enter").effects)[0].method, "resume");
});

test("question menus answer text and approval decisions", () => {
  const question = to(loaded(at(120, 30)), q1),
    answer = go(question, "enter", "a", { text: "Release build" });
  const effect = calls(press(answer, "enter").effects)[0];
  assert.equal(effect.method, "answer");
  assert.equal(effect.params.id, amber);
  assert.equal(effect.params.answer, "Release build");
  const approval = go(to(question, q2), "enter", "a");
  assert.equal(approval.modal.kind, "choice");
  const choice = press(approval, "2");
  assert.equal(calls(choice.effects)[0].method, "answer");
  assert.ok(calls(choice.effects)[0].params.answer);
});

test("workspace settings have fixed field positions and a header unsaved count", () => {
  const state = to(loaded(at(120, 30)), "ws:demo-2694"),
    form = go(state, "enter", "e");
  assert.equal(form.focus, "pane");
  const labels = ["Concurrency", "Paused", "Model", "Effort", "Network"];
  const positions = (s) =>
    labels.map((label) =>
      lines(s).findIndex((line) => line.slice(46).includes(label)),
    );
  const before = positions(form),
    edited = go(
      form,
      "right",
      "right",
      "down",
      "right",
      "down",
      "enter",
      "ctrl+u",
      { text: "gpt-fixture" },
      "enter",
      "down",
      "left",
    );
  assert.deepEqual(positions(edited), before);
  assert.match(lines(edited)[2], /4 unsaved/);
  assert.deepEqual(edited.form.values, {
    concurrency: 12,
    paused: true,
    model: "gpt-fixture",
    effort: "medium",
    network: true,
  });
  const confirm = go(edited, "end", "enter");
  assert.equal(confirm.modal.kind, "confirm");
  const effect = calls(press(confirm, "enter").effects)[0];
  assert.deepEqual(effect.params, {
    workspace: "demo-2694",
    concurrency: 12,
    paused: true,
    model: "gpt-fixture",
    effort: "medium",
  });
  const leave = go(edited, "escape");
  assert.equal(leave.form, null);
  assert.equal(leave.focus, "side");
  assert.match(lastToast(leave), /Settings left unchanged/);
});

test("overview actions expose refresh, workspace registration and typed stop-all", () => {
  const state = to(loaded(at(120, 30)), "pelican");
  const menu = go(state, "enter");
  assert.match(text(menu), /Refresh\s+r/);
  assert.equal(press(menu, "r").effects[0].type, "refresh");
  const add = go(menu, "+", { text: "E:\\GitHub\\example" });
  const effect = calls(press(add, "enter").effects)[0];
  assert.deepEqual(
    [effect.method, effect.params],
    ["workspace.add", { folder: "E:\\GitHub\\example" }],
  );
  const stop = go(menu, "S");
  assert.equal(stop.modal.kind, "typed");
  assert.equal(calls(press(stop, { text: "no" }, "enter").effects).length, 0);
  assert.equal(
    calls(press(stop, { text: "yes" }, "enter").effects)[0].params.all,
    true,
  );
});

test("run and orchestrator actions retain the existing gateway methods", () => {
  const run = to(loaded(at(120, 30)), "run:" + f.run.id);
  assert.equal(
    calls(press(go(run, "enter", "x"), "y").effects)[0].method,
    "runs.stop",
  );
  const owner = go(to(run, "orch:lead"), "enter", "x", { text: "yes" });
  assert.deepEqual(calls(press(owner, "enter").effects)[0].params, {
    all: true,
    owner: "lead",
    reason: "Stopped from the Pelican menu by menu",
  });
});

test("agent tabs and inspect mode retain full conversation folds and live following", () => {
  let state = to(loaded(at(120, 30)), "agent:" + amber);
  assert.match(pane(state), /Chat\s+Brief\s+Result\s+Resources/);
  state = go(state, "]");
  assert.match(wholePane(state), /Prompt/);
  state = go(state, "]");
  assert.match(wholePane(state), /Result/);
  state = go(state, "[", "[", "enter", "i");
  assert.equal(state.focus, "pane");
  assert.match(lines(state).at(-1), /r Refresh/);
  assert.deepEqual(press(state, "r").effects, [{ type: "refresh" }]);
  assert.deepEqual(click(state, "Refresh").effects, [{ type: "refresh" }]);
  const model = paneModel(state);
  assert.ok(model.folds.length > 0);
  const original = w(state),
    scrolled = go(state, "up");
  assert.equal(w(scrolled).follow, false);
  assert.equal(go(scrolled, "end").views[model.viewKey].follow, true);
  const fold = w(state).current;
  if (fold) {
    const toggled = go(state, "enter");
    assert.ok(toggled.expanded[model.viewKey].includes(fold.key));
  }
  assert.equal(go(state, "escape").focus, "side");
  assert.ok(original.total > 0);
});

test("the command palette stays accessible and has no Help entry or hidden shortcut", () => {
  const state = loaded(at(120, 30)),
    palette = go(state, ":", { text: "cedar" });
  assert.ok(palette.palette);
  assert.ok(
    paletteResults(palette).some((item) => item.label === "Cedar Wren"),
  );
  const index = paletteResults(palette).findIndex(
    (item) => item.id === "agent:" + cedar,
  );
  const jumped = go(palette, ...Array(index).fill("down"), "enter");
  assert.equal(jumped.selected, "agent:" + cedar);
  assert.equal(jumped.focus, "side");
  assert.ok(
    !paletteResults(go(state, ":")).some((item) => /help/i.test(item.label)),
  );
  assert.equal(go(state, "ctrl+k").palette, null);
  const cleared = go(palette, "ctrl+u");
  assert.equal(cleared.palette.value, "");
  assert.equal(go(cleared, "escape").palette, null);
});

test("status badges differ from highlighted keyboard hints", () => {
  const state = to(loaded(at(120, 30)), "agent:" + amber),
    theme = makeTheme();
  const label = theme.props("label"),
    key = theme.props("accent bold");
  assert.notDeepEqual(label, key);
  assert.ok(label.backgroundColor);
  assert.equal(key.bold, true);
  assert.match(lines(state).at(-2), /working|asking/i);
  assert.doesNotMatch(text(state), /Help/);
});

test("errors are branded, retries are visible and service start remains explicit", () => {
  const state = {
    ...f.fresh({ size: { cols: 120, rows: 30 } }),
    service: { state: "down", message: "Nothing answers at 127.0.0.1:4319." },
  };
  assert.match(text(state), /Pelican is not running/);
  assert.match(text(state), /Start service/);
  assert.deepEqual(press(state, "enter").effects, [{ type: "start-service" }]);
  assert.deepEqual(press(state, "r").effects, [{ type: "refresh" }]);
  assert.deepEqual(press(state, "q").effects, [{ type: "quit" }]);
  const tiny = { ...state, size: { cols: 80, rows: 24 } };
  assert.deepEqual(press(tiny, "enter").effects, []);
  assert.match(text(tiny), /Pelican needs 100 x 28/);
});

test("long names wrap completely and selection remains readable", () => {
  const state = loaded(at(120, 30));
  const long = "A very long orchestrator identity with enough words to wrap";
  const fleet = state.data.fleet.map((agent) => ({
    ...agent,
    owner: agent.owner === "lead" ? long : agent.owner,
  }));
  const changed = reduce(
    select({ ...state, data: { ...state.data, fleet } }, "agent:" + amber),
    { type: "tick" },
  ).state;
  // The count stays on the name's first line and the name wraps around it.
  const shown = side(changed)
    .replace(/[\s│›▾★]+/g, "")
    .replace(/\d+live|◆\d+/g, "");
  assert.ok(shown.includes(long.replace(/\s/g, "")));
  const owner = treeRows(changed).find((r) => r.id === "orch:" + long);
  const [first, ...rest] = rowLines(owner, 43, { g: glyphSets.rich }).map(
    plain,
  );
  assert.match(first, /2 live/);
  assert.ok(rest.length && rest.every((line) => !/live/.test(line)));
  const row = treeRows(changed).find((r) => r.id === "agent:" + amber);
  for (const line of rowLines(row, 43, {
    selected: true,
    focused: true,
    g: glyphSets.rich,
  }))
    for (const [, style] of line) {
      assert.match(style, /selected/);
      assert.doesNotMatch(style, /muted|dim/);
    }
});

test("the overview's workspaces, orchestrators and top agents open on a click", () => {
  const overview = to(loaded(at(140, 90)), "pelican");
  assert.equal(
    click(overview, "demo-2694", true).state.selected,
    "ws:demo-2694",
  );
  // The orchestrator's own line (its name starts it), not a note naming it.
  const y = lines(overview).findIndex((line) =>
    line.slice(46).trim().startsWith("reviewer "),
  );
  assert.ok(y >= 0, text(overview));
  const row = lines(overview)[y];
  const x = width(row.slice(0, row.indexOf("reviewer", 46)));
  assert.equal(mouse(overview, x, y).state.selected, "orch:reviewer");
  const agent = click(overview, "Amber Heron", true).state;
  assert.match(agent.selected, /^agent:/);
  assert.equal(currentItem(agent).kind, "agent");
});

test("the overview shows the Codex usage limits as the service last read them", () => {
  const state = to(loaded(at(120, 30)), "pelican");
  const shown = pane(state);
  assert.match(shown, /CODEX USAGE +─+ pro · read 12m ago/);
  assert.match(shown, /5h +━+─+ +35% +resets in 2h 10m/);
  assert.match(shown, /weekly +━+─* +91% +resets in 3d 4h/);
  assert.match(shown, /credits +none/);
  // Green while there is room, red from 90%.
  const tones = (label) => {
    const line = paneModel(state).body.find((l) => plain(l).startsWith(label));
    return line.map(([, style]) => style);
  };
  assert.ok(tones("5h").includes("ok") && !tones("5h").includes("err"));
  assert.ok(tones("weekly").includes("err"));
  // The service answers from its last reading, so the menu asks once a
  // minute: now, and again a minute after it was answered.
  const asked = (s) => needs(s).some((r) => r.method === "usage");
  assert.ok(asked(f.fresh(at(120, 30))));
  assert.ok(!asked(state));
  assert.ok(!asked({ ...state, now: state.now + 59000 }));
  assert.ok(asked({ ...state, now: state.now + 60000 }));
});

test("the usage section says when the limits are missing, failed or reached", () => {
  // A method the service refuses is an error like any other: shown as is and
  // asked again a minute later, never a standing "restart it" notice.
  const unknown = using(
    {
      usage: () =>
        Object.assign(new Error("Unknown method: usage"), { statusCode: 404 }),
    },
    () => to(loaded(at(120, 30), fixture), "pelican"),
  );
  assert.match(pane(unknown), /Unknown method: usage/);
  assert.doesNotMatch(pane(unknown), /restart/i);
  assert.ok(
    needs({ ...unknown, now: unknown.now + 60000 }).some(
      (r) => r.method === "usage",
    ),
  );

  const failed = using(
    { usage: () => Object.assign(new Error("Connection reset")) },
    () => to(loaded(at(120, 30), fixture), "pelican"),
  );
  assert.match(pane(failed), /Connection reset/);

  const never = using(
    {
      usage: () => ({
        ...f.usage,
        at: null,
        limits: [],
        credits: null,
        error: "Not signed in",
      }),
    },
    () => to(loaded(at(120, 30), fixture), "pelican"),
  );
  assert.match(pane(never), /Usage limits are not available: Not signed in/);

  const reached = using(
    {
      usage: () => ({
        ...f.usage,
        reached: "workspace_member_usage_limit_reached",
        error: "Timed out",
      }),
    },
    () => to(loaded(at(120, 30), fixture), "pelican"),
  );
  assert.match(
    pane(reached),
    /limit reached: workspace member usage limit reached/,
  );
  assert.match(pane(reached), /The last read failed: Timed out/);
  // A weekly window next to the short one, and several limits named.
  const two = using(
    {
      usage: () => ({
        ...f.usage,
        limits: [
          f.usage.limits[0],
          { ...f.usage.limits[0], id: "codex_other", name: "GPT-6 Sol" },
        ],
      }),
    },
    () => to(loaded(at(120, 30), fixture), "pelican"),
  );
  assert.match(pane(two), /codex\n5h[^]*GPT-6 Sol\n5h/);
});

test("every selected detail preserves its content and scoped read requests", () => {
  const state = loaded(at(120, 30)),
    agent = to(state, "agent:" + amber);
  assert.ok(
    needs(agent).some((r) => r.method === "tail" && r.params.id === amber),
  );
  assert.ok(
    needs(to(state, "orch:lead")).some(
      (r) => r.method === "feed" && r.params.as === "lead",
    ),
  );
  assert.ok(
    needs(to(state, "run:" + f.run.id)).some((r) => r.method === "runs.get"),
  );
  assert.ok(needs(to(state, "events")).some((r) => r.method === "events"));
  assert.match(
    wholePane(to(state, "pelican")),
    /ACTIVITY[\s\S]*WORKSPACES[\s\S]*ORCHESTRATORS[\s\S]*TOP TOKENS/,
  );
  const later = reduce(state, {
    type: "tick",
    now: f.now + metricsEveryMs,
  }).state;
  assert.ok(needs(later).some((r) => r.method === "metrics"));
  assert.deepEqual(press(state, "ctrl+c").effects, [{ type: "quit" }]);
});

test("mouse reporting is decoded across chunks and paste cannot click", () => {
  const events = [],
    filter = createReplyFilter((event) => events.push(event));
  assert.equal(filter.push("\x1b[<0;12;"), "");
  assert.equal(filter.push("8M"), "");
  assert.equal(events[0].x, 11);
  assert.equal(events[0].y, 7);
  filter.push("\x1b[200~text\x1b[<0;2;3M\x1b[201~");
  assert.equal(events.length, 1);
});

test("mouse controls select, activate actions, edit settings, tabs and folds", () => {
  let state = to(loaded(at(120, 30)), "agent:" + amber);
  const menu = click(state, "Actions");
  assert.equal(menu.state.modal.kind, "actions");
  const message = click(menu.state, "Message");
  assert.equal(message.state.modal.kind, "input");
  let form = go(to(state, "ws:demo-2694"), "enter", "e");
  const field = locate(form, "Concurrency", true),
    before = field.y;
  form = mouse(form, field.x + 14, field.y).state;
  assert.equal(form.form.values.concurrency, 9);
  assert.equal(locate(form, "Concurrency", true).y, before);
  assert.equal(click(form, "Apply 1 change", true).state.modal.kind, "confirm");
  state = click(state, "Result", true).state;
  assert.equal(state.tabs[amber], "result");
  state = go(state, "[", "[");
  const model = paneModel(state),
    box = paneBox(state),
    view = paneWindow(state, model, box);
  const fold = model.folds.find(
    (f) => f.line >= view.top && f.line < view.top + view.room,
  );
  if (fold) {
    const y = 4 + model.head.length + fold.line - view.top;
    const opened = mouse(state, 50, y).state;
    assert.ok(opened.expanded[model.viewKey].includes(fold.key));
  }
  const search = click(state, "/ Search").state;
  assert.equal(search.filtering, true);
  assert.equal(click(search, "/ ").state.filter, "");
  const palette = click(state, ": Commands").state;
  assert.ok(palette.palette);
  assert.equal(click(palette, "Close").state.palette, null);
});
