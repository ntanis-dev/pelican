import test from "node:test";
import assert from "node:assert/strict";
import {
  codeLine,
  codeLines,
  outputLines,
  pathLine,
  proseLines,
} from "../src/menu/syntax.js";
import { cutSpans, lineWidth, plain, wrapLine } from "../src/menu/lines.js";
import { chatEntries } from "../src/menu/views/agent.js";
import { entryBody } from "../src/menu/views/common.js";
import { glyphSets } from "../src/menu/theme.js";

// [text, role] for every coloured span, the plain stretches left out.
const coloured = (spans) =>
  spans.filter(([, style]) => style).map(([text, style]) => [text, style]);
// Only what stands out: the base style of output text is left out.
const lit = (spans) => roles(spans.filter(([, style]) => style !== "muted"));
const roles = (spans) =>
  coloured(spans).map(([text, style]) => `${style}:${text}`);

test("a command's name, flags, strings and files each get their own colour", () => {
  const spans = codeLine(
    "Get-Content apps/demo/.data/x/monitor.log -Tail 5; rg -n 'fewer than 5' scripts/score.mjs | Select-String -SimpleMatch x",
  );
  assert.deepEqual(roles(spans), [
    "accent bold:Get-Content",
    "beak:apps/demo/.data/x/monitor.log",
    "info:-Tail",
    "muted:;",
    "accent bold:rg",
    "info:-n",
    "ok:'fewer than 5'",
    "beak:scripts/score.mjs",
    "muted:|",
    "accent bold:Select-String",
    "info:-SimpleMatch",
  ]);
});

test("a command is the first word of each statement, and only there", () => {
  const names = (text) =>
    coloured(codeLine(text))
      .filter(([, style]) => style === "accent bold")
      .map(([name]) => name);
  assert.deepEqual(names("git status && npm test || echo no"), [
    "git",
    "npm",
    "echo",
  ]);
  assert.deepEqual(names("a | b ; c"), ["a", "b", "c"]);
  assert.deepEqual(names("git diff --stat -- src"), ["git"]);
  // A new line starts a statement; a file run as a command is one too.
  assert.deepEqual(
    coloured(codeLines("npm test\nnode run.mjs")[1]).map(([t]) => t),
    ["node", "run.mjs"],
  );
  assert.deepEqual(names("pnpm.cmd exec prettier NOTES.md"), ["pnpm.cmd"]);
});

test("a here-string's program is read as a program, with its markers kept quiet", () => {
  const lines = codeLines(
    "@' import fs from 'node:fs';\nconst a = 1; // note\n'@ | node",
  );
  assert.equal(lines.length, 3);
  assert.deepEqual(roles(lines[0]), [
    "muted:@'",
    "stop:import",
    "stop:from",
    "ok:'node:fs'",
    "muted:;",
  ]);
  assert.deepEqual(roles(lines[1]), [
    "stop:const",
    "muted:=",
    "muted:;",
    "muted italic:// note",
  ]);
  assert.deepEqual(roles(lines[2]), [
    "muted:'@",
    "muted:|",
    "accent bold:node",
  ]);
  // Inside it nothing is a shell command, even at the start of a line.
  assert.ok(!roles(lines[1]).some((r) => r.startsWith("accent")));
  // Summarised, the body is an ellipsis.
  assert.deepEqual(roles(codeLine("@' … '@ | Set-Content a.mjs")), [
    "muted:@'",
    "muted:…",
    "muted:'@",
    "muted:|",
    "accent bold:Set-Content",
    "beak:a.mjs",
  ]);
});

test("variables, comments and JSON keys are told apart from values", () => {
  assert.deepEqual(roles(codeLine("Get-Item $env:TEMP -Force # why")), [
    "accent bold:Get-Item",
    "stop:$env:TEMP",
    "info:-Force",
    "muted italic:# why",
  ]);
  assert.deepEqual(
    roles(codeLine('{"name": "pelican", "ok": true, "n": 3}')).filter((r) =>
      /^(info|ok|stop):/.test(r),
    ),
    ['info:"name"', 'ok:"pelican"', 'info:"ok"', "stop:true", 'info:"n"'],
  );
  // A # inside a word or a link is not a comment.
  assert.deepEqual(roles(codeLine("curl https://x.io/a#b")).slice(0, 1), [
    "accent bold:curl",
  ]);
  assert.ok(
    !roles(codeLine("curl https://x.io/a#b")).some((r) => r.includes("italic")),
  );
});

test("what looks like a path but is not stays plain", () => {
  // A lone slash is punctuation; a fraction is not a path.
  assert.deepEqual(roles(codeLine("echo 71/71 a / b")), [
    "accent bold:echo",
    "muted:/",
  ]);
  assert.deepEqual(roles(proseLines("71/71 tests, and/or read/write")[0]), []);
  assert.deepEqual(roles(proseLines("two parts only: src/menu")[0]), []);
  // In a command, two parts are a folder.
  assert.deepEqual(roles(codeLine("ls src/menu")), [
    "accent bold:ls",
    "beak:src/menu",
  ]);
  assert.deepEqual(
    roles(proseLines("ok a/b/c and src/x.js and ./z and C:\\a\\b.txt.")[0]),
    ["beak:a/b/c", "beak:src/x.js", "beak:./z", "beak:C:\\a\\b.txt"],
  );
});

test("prose has its code, links, paths and flags coloured and its punctuation left alone", () => {
  const [line] = proseLines(
    "Run `pnpm test` in apps/demo/NOTES.md, see https://example.com/x). Use --keep-going.",
  );
  assert.deepEqual(roles(line), [
    "muted:`",
    "beak:pnpm test",
    "muted:`",
    "beak:apps/demo/NOTES.md",
    "info underline:https://example.com/x",
    "info:--keep-going",
  ]);
  assert.equal(
    plain(line),
    "Run `pnpm test` in apps/demo/NOTES.md, see https://example.com/x). Use --keep-going.",
  );
  // Thinking stays italic and muted around the colour.
  const thinking = proseLines("look at src/a.js now", "muted italic")[0];
  assert.deepEqual(
    thinking.map(([, style]) => style),
    ["muted italic", "muted italic beak", "muted italic"],
  );
});

test("output shows its files, with the line after the colon, and how it went", () => {
  const rows = outputLines(
    "scripts/sweep/score.mjs:42:  // fewer than 5\nnot ok 1 login\nok 2 logout\n3 errors, 1 warning, PASS ✓",
  );
  assert.deepEqual(lit(rows[0]), ["beak:scripts/sweep/score.mjs"]);
  assert.equal(plain(rows[0]), "scripts/sweep/score.mjs:42:  // fewer than 5");
  assert.deepEqual(lit(rows[1]), ["err:not ok"]);
  assert.deepEqual(lit(rows[2]), ["ok:ok"]);
  assert.deepEqual(lit(rows[3]), [
    "err:errors",
    "warn:warning",
    "ok:PASS",
    "ok:✓",
  ]);
  // The rest is the base style, muted unless said.
  assert.deepEqual(
    rows[1].map(([, s]) => s),
    ["err", "muted"],
  );
  assert.equal(outputLines("x", "").at(0)[0][1], "");
});

test("colouring never changes the text: every line comes back as it went in", () => {
  const samples = [
    "",
    "plain words and spaces   with  gaps",
    "Get-Content a.log -Tail 5; node 'unterminated",
    "@' @'@ unclosed here-string",
    "tabs\tand \x1b[31mescapes\x1b[0m and \x1b]0;title\x07",
    "uni 日本語 and … and emoji 🙂 src/a.js",
    "line one\n\nline three with `tick` and a/b/c.md.\n  indented",
    '{"a": [1, 2, {"b": null}]}',
    "`unclosed tick and C:\\Users\\x\\file.ts:3:4 and ./a/../b",
  ];
  const clean = (t) =>
    t
      .replace(
        /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
        "",
      )
      .replace(/\t/g, "  ");
  for (const text of samples) {
    const want = clean(text);
    assert.equal(codeLines(text).map(plain).join("\n"), want, `code: ${text}`);
    assert.equal(
      proseLines(text).map(plain).join("\n"),
      want,
      `prose: ${text}`,
    );
    assert.equal(
      outputLines(text).map(plain).join("\n"),
      want,
      `output: ${text}`,
    );
  }
  assert.equal(
    pathLine(["src/a.js", "src/b.js"])
      .map(([t]) => t)
      .join(""),
    "src/a.js, src/b.js",
  );
});

test("a line is cut to its room with the ellipsis in the colour of what it follows", () => {
  const line = [
    ["Get-Content ", "accent bold"],
    ["apps/demo/monitor.log", "beak"],
  ];
  assert.equal(cutSpans(line, 80), line);
  const cut = cutSpans(line, 20);
  assert.equal(plain(cut), "Get-Content apps/de…");
  assert.equal(lineWidth(cut), 20);
  assert.deepEqual(cut.at(-1), ["…", "beak"]);
  assert.deepEqual(cutSpans(line, 5).at(-1), ["…", "accent bold"]);
  assert.deepEqual(cutSpans(line, 0), []);
});

test("a word in two colours wraps as one word, so a comma never starts a line", () => {
  const words = [
    ["touch ", ""],
    ["src/parser.js", "beak"],
    [", because it is owned", ""],
  ];
  assert.deepEqual(wrapLine(words, 22).map(plain), [
    "touch src/parser.js,",
    "because it is owned",
  ]);
  assert.deepEqual(wrapLine(words, 14).map(plain), [
    "touch",
    "src/parser.js,",
    "because it is",
    "owned",
  ]);
  // At every width that holds the word (14 cells with its comma).
  for (let w = 14; w <= 40; w++)
    for (const row of wrapLine(words, w).map(plain))
      assert.doesNotMatch(row, /^,/, `width ${w}: ${row}`);
  // A word wider than the line still breaks, whatever its colours.
  assert.ok(
    wrapLine(
      [
        ["abcdef", "beak"],
        ["ghijkl", "ok"],
      ],
      5,
    ).length >= 3,
  );
});

test("the chat colours what agents and commands wrote, and the rows keep their layout", () => {
  const at = "2026-10-29T12:50:00Z";
  const command =
    '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content apps/demo/monitor.log -Tail 5"';
  const lines = [
    {
      seq: 1,
      at,
      type: "item/started",
      text: `$ ${command}`,
      kind: "command",
      item: "c",
      command,
    },
    {
      seq: 2,
      at,
      type: "item/completed",
      text: "x",
      kind: "command",
      item: "c",
      command,
      exitCode: 1,
      durationMs: 900,
      status: "failed",
      detail: "src/a.js:3: not ok\n",
    },
    {
      seq: 3,
      at,
      type: "item/completed",
      text: "Edited src/a.js, src/b.js",
      kind: "edit",
      item: "f",
      detail: "update src/a.js\n-a\n+b",
    },
    {
      seq: 4,
      at,
      type: "item/completed",
      text: "x",
      kind: "agent",
      phase: "commentary",
      detail: "Fixed `retry` in src/a.js.",
    },
  ];
  const g = glyphSets.rich;
  const body = entryBody(chatEntries({ lines }, "Amber", g), 90, {
    expanded: [1, 3],
    g,
  });
  const all = body.body.flat();
  const styleOf = (text) => all.find(([t]) => t === text)?.[1];
  assert.equal(styleOf("Get-Content"), "accent bold");
  assert.equal(styleOf("-Tail"), "info");
  assert.equal(styleOf("update"), "muted bold");
  assert.equal(styleOf("not"), "err");
  assert.ok(all.some(([t, s]) => t === "src/a.js" && s === "beak"));
  assert.ok(all.some(([t, s]) => t === "retry" && s === "beak"));
  // Collapsed, the summary and the edit's files are coloured on their one line.
  const closed = entryBody(chatEntries({ lines }, "Amber", g), 90, {
    expanded: [],
    g,
  });
  assert.deepEqual(
    closed.folds.map((f) => f.size),
    [1, 1],
  );
  const row = closed.body[0];
  assert.ok(
    row.some(([t, s]) => t === "apps/demo/monitor.log" && s === "beak"),
  );
  assert.ok(closed.body[1].some(([t, s]) => t === "src/a.js" && s === "beak"));
});

test("odd or huge text is coloured quickly: a long run of one kind of character cannot stall the pane", () => {
  const inputs = [
    "a".repeat(49000),
    ".".repeat(49000),
    "-".repeat(49000),
    "ab-".repeat(16000),
    "a/".repeat(24000),
    `a/${".".repeat(49000)}x`,
    `"${"x ".repeat(24000)}`,
  ];
  for (const text of inputs)
    for (const lex of [codeLines, proseLines, outputLines]) {
      const started = performance.now();
      const rows = lex(text);
      // These took seconds when each position of a run was a fresh start.
      assert.ok(
        performance.now() - started < 400,
        `${lex.name} on ${text.slice(0, 12)}…`,
      );
      assert.equal(rows.map(plain).join("\n"), text);
    }
});

test("text past the limit is left as it is, in one style", () => {
  const huge = "src/a.js ".repeat(10000);
  for (const rows of [codeLines(huge), proseLines(huge), outputLines(huge)]) {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].length, 1);
    assert.equal(plain(rows[0]), huge);
  }
  assert.equal(proseLines(huge, "muted italic")[0][0][1], "muted italic");
});
