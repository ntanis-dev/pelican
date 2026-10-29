import test from "node:test";
import assert from "node:assert/strict";
import {
  diffStats,
  promptOf,
  summarize,
  took,
  unwrap,
} from "../src/menu/command.js";
import { journalLine } from "../src/journal.js";
import { chatEntries } from "../src/menu/views/agent.js";
import { entryBody } from "../src/menu/views/common.js";
import { glyphSets } from "../src/menu/theme.js";
import { plain } from "../src/menu/lines.js";
import { width } from "../src/menu/text.js";

const powershell =
  '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command ';

test("a shell's launcher is taken off a command, leaving the script and the shell", () => {
  assert.deepEqual(unwrap(`${powershell}"Get-Content a.log -Tail 5"`), {
    shell: "PowerShell",
    script: "Get-Content a.log -Tail 5",
  });
  assert.deepEqual(
    unwrap("pwsh -NoProfile -ExecutionPolicy Bypass -Command git status"),
    { shell: "PowerShell", script: "git status" },
  );
  assert.deepEqual(unwrap(`/bin/bash -lc 'rg -n "port" src'`), {
    shell: "bash",
    script: 'rg -n "port" src',
  });
  assert.deepEqual(unwrap("cmd.exe /c dir"), { shell: "cmd", script: "dir" });
  // Not a shell's launcher, or a launcher with no script: shown as it is.
  assert.deepEqual(unwrap("npm test"), { shell: null, script: "npm test" });
  assert.deepEqual(unwrap("node script.js --flag"), {
    shell: null,
    script: "node script.js --flag",
  });
  assert.deepEqual(unwrap("bash script.sh"), {
    shell: null,
    script: "bash script.sh",
  });
  assert.deepEqual(unwrap(""), { shell: null, script: "" });
  assert.deepEqual(unwrap(undefined), { shell: null, script: "" });
});

test("quotes come off a script only when they wrap all of it", () => {
  assert.equal(unwrap("sh -c 'echo hi'").script, "echo hi");
  assert.equal(unwrap('sh -c "echo \\"hi\\""').script, 'echo "hi"');
  // Two separate quoted words are not one wrapped script.
  assert.equal(unwrap("sh -c 'a' + 'b'").script, "'a' + 'b'");
});

test("a summary is one line, with a here-string's body left out", () => {
  assert.equal(
    summarize("@' import fs from 'node:fs';\nfs.x(); '@ | node; Get-Content a"),
    "@' … '@ | node; Get-Content a",
  );
  assert.equal(
    summarize('@"\nmulti\nline\n"@ | Set-Content a.txt'),
    '@" … "@ | Set-Content a.txt',
  );
  assert.equal(summarize("git   diff\n  --stat"), "git diff --stat");
  assert.equal(summarize(undefined), "");
  assert.equal(promptOf("PowerShell"), "PS>");
  assert.equal(promptOf("cmd"), ">");
  assert.equal(promptOf("bash"), "$");
  assert.equal(promptOf(null), "$");
});

test("durations and diffs read at a glance", () => {
  assert.equal(took(40), "<0.1s");
  assert.equal(took(500), "0.5s");
  assert.equal(took(58200), "58.2s");
  assert.equal(took(61000), "1m 01s");
  assert.equal(took(null), "");
  assert.equal(took(undefined), "");
  assert.deepEqual(
    diffStats(
      "update a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-old\n+new\n+more",
    ),
    { added: 2, removed: 1 },
  );
  assert.deepEqual(diffStats(""), { added: 0, removed: 0 });
});

test("the journal gives a command's text when it starts and its duration and status when it ends", () => {
  const started = journalLine(
    {
      seq: 1,
      at: "2026-10-29T12:00:00Z",
      type: "item/started",
      data: {
        item: { id: "c1", type: "commandExecution", command: "npm test" },
      },
    },
    { full: true },
  );
  assert.equal(started.command, "npm test");
  assert.equal(started.text, "$ npm test");
  const done = journalLine(
    {
      seq: 2,
      at: "2026-10-29T12:00:02Z",
      type: "item/completed",
      data: {
        item: {
          id: "c1",
          type: "commandExecution",
          command: ["npm", "test"],
          exitCode: 1,
          durationMs: 1500,
          status: "failed",
          aggregatedOutput: "not ok\n",
        },
      },
    },
    { full: true },
  );
  assert.equal(done.command, "npm test");
  assert.equal(done.exitCode, 1);
  assert.equal(done.durationMs, 1500);
  assert.equal(done.status, "failed");
  // The plain tail is unchanged.
  assert.equal(
    journalLine({
      seq: 2,
      at: "2026-10-29T12:00:02Z",
      type: "item/completed",
      data: {
        item: {
          type: "commandExecution",
          command: "npm test",
          exitCode: 0,
          durationMs: 1500,
        },
      },
    }).text,
    "  exit 0, 1.5s",
  );
});

const at = "2026-10-29T12:50:00Z";
const started = (seq, item, command) => ({
  seq,
  at,
  type: "item/started",
  text: `$ ${command}`,
  kind: "command",
  item,
  command,
});
const finished = (seq, item, command, extra) => ({
  seq,
  at,
  type: "item/completed",
  text: "  exit",
  kind: "command",
  item,
  command,
  exitCode: 0,
  durationMs: 1500,
  status: "completed",
  detail: "ok 1 login\n",
  ...extra,
});
const script = `${powershell}"@' ${"x".repeat(200)} '@ | node .temp/run.mjs; Get-Content a.log"`;
const chat = (lines, glyphs = "rich") =>
  chatEntries({ lines }, "Amber", glyphSets[glyphs]);
const shown = (lines, w, expanded = [], glyphs = "rich") =>
  entryBody(chat(lines, glyphs), w, { expanded, g: glyphSets[glyphs] });
const text = (body) => body.body.map(plain);

test("a collapsed command is one line: Ran, its summary, and how it went at the right edge", () => {
  const body = shown(
    [
      started(1, "c1", script),
      finished(2, "c1", script),
      started(3, "c2", "npm test"),
      finished(4, "c2", "npm test", {
        exitCode: 1,
        durationMs: 20000,
        status: "failed",
      }),
    ],
    90,
  );
  const rows = text(body);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    body.folds.map((f) => f.size),
    [1, 1],
  );
  assert.match(
    rows[0],
    /^12:50 ▸ Ran {2}@' … '@ \| node \.temp\/run\.mjs; Get-Content a\.log {2,}✓ 1\.5s$/,
  );
  assert.match(rows[1], /^12:50 ▸ Ran {2}npm test {2,}✗ exit 1 · 20\.0s$/);
  assert.ok(rows.every((row) => width(row) <= 90));
  assert.doesNotMatch(rows.join("\n"), /powershell\.exe/i);
});

test("a long summary is cut with an ellipsis and every collapsed row stays one line at any width", () => {
  const long = `${powershell}"Get-Content ${"apps/demo/.data/".repeat(12)}monitor.log -Tail 5"`;
  const lines = [started(1, "c1", long), finished(2, "c1", long)];
  for (const glyphs of ["rich", "plain"])
    for (const w of [120, 80, 50, 30, 20]) {
      const body = shown(lines, w, [], glyphs);
      const rows = text(body);
      assert.equal(rows.length, 1, `${glyphs} ${w}`);
      assert.ok(width(rows[0]) <= w, `${glyphs} ${w}`);
      if (w <= 80) assert.match(rows[0], /…/, `${glyphs} ${w}`);
    }
  // The chip gives way before the summary shrinks to a few words.
  assert.doesNotMatch(text(shown(lines, 30))[0], /1\.5s/);
  assert.match(text(shown(lines, 120))[0], /1\.5s$/);
});

test("a command that is still running says so, and opens to its script at the shell's prompt", () => {
  const lines = [started(1, "c1", script)];
  const rows = text(shown(lines, 100));
  assert.match(rows[0], /^12:50 ▸ Running {2}@' … '@ .*● running$/);
  const open = text(shown(lines, 100, [1]));
  assert.match(open[0], /^12:50 ▾ Running/);
  assert.equal(open[1], "      │ PS> @'");
  assert.match(open[2], /^ {6}│ {5}x+/);
  assert.match(open.at(-1), /^ {6}│ \(running, no output yet\)$/);
});

test("an opened command shows its whole script, a rule and its output beside a rail", () => {
  const lines = [
    started(1, "c1", `${powershell}"Set-Content a.txt 'one'; node a.txt"`),
    finished(2, "c1", `${powershell}"Set-Content a.txt 'one'; node a.txt"`, {
      detail: "line one\nline two\n",
    }),
  ];
  const rows = text(shown(lines, 60, [1]));
  assert.deepEqual(rows, [
    rows[0],
    "      │ PS> Set-Content a.txt 'one'; node a.txt",
    "      │ ────────────────────────",
    "      │ line one",
    "      │ line two",
  ]);
  assert.match(
    rows[0],
    /^12:50 ▾ Ran {2}Set-Content a\.txt 'one'; node a\.txt {2,}✓ 1\.5s$/,
  );
  // A command with no shell is at a plain prompt, with no output said so.
  const bare = text(
    shown(
      [
        started(1, "c", "npm test"),
        finished(2, "c", "npm test", { detail: "" }),
      ],
      60,
      [1],
    ),
  );
  assert.equal(bare[1], "      │ $ npm test");
  assert.equal(bare.at(-1), "      │ (no output)");
});

test("an opened script keeps its line breaks and wraps under its prompt", () => {
  const multi = "sh -c 'echo one\necho two and a rather long second line here'";
  const rows = text(
    shown([started(1, "c", multi), finished(2, "c", multi)], 40, [1]),
  );
  assert.equal(rows[1], "      │ $ echo one");
  assert.match(rows[2], /^ {6}│ {3}echo two and a/);
  assert.ok(rows.every((row) => width(row) <= 40));
});

test("a failed command opens beside a red rail, and an edit shows what it added and removed", () => {
  const lines = [
    started(1, "c", "npm test"),
    finished(2, "c", "npm test", {
      exitCode: 2,
      durationMs: 61000,
      status: "failed",
      detail: "not ok",
    }),
    {
      seq: 3,
      at,
      type: "item/completed",
      text: "Edited src/a.js, src/b.js",
      kind: "edit",
      item: "f",
      detail: "update src/a.js\n-a\n+b\n+c\nupdate src/b.js\n-d",
    },
  ];
  const entries = chat(lines);
  assert.equal(entries[0].rail, "err");
  const closed = text(shown(lines, 70));
  assert.match(closed[0], /✗ exit 2 · 1m 01s$/);
  assert.match(
    closed[1],
    /^12:50 ▸ Edited {2}src\/a\.js, src\/b\.js {2,}\+2 -2$/,
  );
  const open = text(shown(lines, 70, [3]));
  assert.equal(open[2], "      │ update src/a.js");
  assert.ok(open.includes("      │ +c"));
  // A command the Codex app-server declined has no exit code to show.
  const declined = chat([
    started(1, "c", "rm -rf x"),
    finished(2, "c", "rm -rf x", {
      exitCode: null,
      status: "declined",
      durationMs: null,
    }),
  ]);
  const row = text(
    entryBody(declined, 60, { expanded: [], g: glyphSets.rich }),
  )[0];
  assert.match(row, /✗ declined$/);
});

test("an opened command and its output survive the cache, and a finished one replaces its running row", () => {
  const lines = [started(1, "c1", "npm test")];
  const scope = "agent:a#chat";
  const before = text(
    entryBody(chat(lines), 60, { expanded: [1], g: glyphSets.rich, scope }),
  );
  assert.match(before[0], /● running$/);
  lines.push(finished(2, "c1", "npm test"));
  const after = text(
    entryBody(chat(lines), 60, { expanded: [1], g: glyphSets.rich, scope }),
  );
  assert.match(after[0], /Ran {2}npm test {2,}✓ 1\.5s$/);
  assert.equal(after.at(-1), "      │ ok 1 login");
});
