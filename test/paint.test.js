import test from "node:test";
import assert from "node:assert/strict";
import { detectPaint, makePaint, plain } from "../src/paint.js";

const tty = (depth = 24, columns = 80) => ({
  isTTY: true,
  columns,
  getColorDepth: () => depth,
});

test("only a terminal gets colour; a pipe, TERM=dumb and --plain get the plain text", () => {
  assert.equal(detectPaint({ isTTY: false }, {}), plain);
  assert.equal(detectPaint(undefined, {}), plain);
  assert.equal(detectPaint(tty(), { TERM: "dumb" }), plain);
  assert.equal(detectPaint(tty(), {}, { plain: true }), plain);
  const p = detectPaint(tty(24, 120), {});
  assert.ok(p.pretty && p.color);
  assert.equal(p.columns, 120);
  assert.match(p.accent("x"), /^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[0m$/);
});

test("NO_COLOR keeps the marks and drops the colour; FORCE_COLOR colours a pipe", () => {
  const dim = detectPaint(tty(), { NO_COLOR: "1" });
  assert.ok(dim.pretty);
  assert.equal(dim.color, false);
  assert.equal(dim.accent("x"), "x");
  assert.equal(dim.check("done"), `${dim.g.check} done`);
  const off = detectPaint(tty(), { FORCE_COLOR: "0" });
  assert.ok(off.pretty);
  assert.equal(off.color, false);
  const forced = detectPaint({ isTTY: false }, { FORCE_COLOR: "1" });
  assert.ok(forced.pretty && forced.color);
  assert.equal(forced.accent("x"), "\x1b[36mx\x1b[0m");
  const rich = detectPaint({ isTTY: false }, { FORCE_COLOR: "3" });
  assert.match(rich.accent("x"), /38;2;/);
});

test("colour follows the terminal's depth", () => {
  const at = (depth) => makePaint({ pretty: true, depth }).err("x");
  assert.match(at(24), /^\x1b\[38;2;207;139;130mx/);
  assert.match(at(8), /^\x1b\[38;5;\d+mx/);
  assert.equal(at(4), "\x1b[31mx\x1b[0m");
  assert.equal(at(1), "x");
});

test("the plain paint changes nothing, so piped output is what it always was", () => {
  assert.equal(plain.pretty, false);
  assert.equal(plain.accent("x"), "x");
  assert.equal(plain("bold err", "a\tb\x1b[31m"), "a\tb\x1b[31m");
  assert.equal(plain.check("Added it"), "Added it");
  assert.equal(plain.status("running"), "running");
  assert.equal(plain.status("waiting", 1), "waiting?");
  assert.equal(plain.who("lead"), "lead");
  assert.equal(plain.safe("a\x1b[31mb"), "a\x1b[31mb");
});

test("on a terminal, text from agents loses its control sequences", () => {
  const p = makePaint({ pretty: true, color: true });
  const evil = "hi \x1b]0;owned\x07\x1b[31mred\x1b[0m there";
  assert.equal(p.safe(evil), "hi red there");
  const painted = p.accent(evil).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(painted, "hi red there");
});

test("multi-line text is painted line by line, so prefixes and indents stay outside the colour", () => {
  const p = makePaint({ pretty: true, color: true, depth: 4 });
  assert.equal(p.warn("a\n\nb"), "\x1b[33ma\x1b[0m\n\n\x1b[33mb\x1b[0m");
});

test("status cells measure as plain text and mark each state", () => {
  const p = makePaint({ pretty: true, color: true });
  assert.equal(p.statusText("running"), `${p.g.dot} running`);
  assert.equal(p.statusText("completed"), `${p.g.check} completed`);
  assert.equal(p.statusText("failed"), `${p.g.cross} failed`);
  assert.equal(p.statusText("waiting", 1), `${p.g.diamond} waiting?`);
  assert.equal(p.statusText("queued"), `${p.g.ring} queued`);
  assert.equal(p.status("running").replace(/\x1b\[[0-9;]*m/g, ""), "● running");
});

test("bars warm up as they fill, and the legacy console gets ASCII marks", () => {
  const p = makePaint({ pretty: true, color: true, depth: 4 });
  assert.match(p.bar(35), /^\x1b\[32m/);
  assert.match(p.bar(75), /^\x1b\[33m/);
  assert.match(p.bar(95), /^\x1b\[31m/);
  assert.equal(p.bar(50).replace(/\x1b\[[0-9;]*m/g, "").length, 16);
  const legacy = makePaint({ pretty: true, glyphs: "plain" });
  assert.equal(legacy.g.check, "+");
  assert.equal(legacy.g.cross, "x");
});

test("an orchestrator's name always gets the same colour", () => {
  const p = makePaint({ pretty: true, color: true });
  assert.equal(p.who("lead"), p.who("lead"));
  assert.equal(p.who("lead").replace(/\x1b\[[0-9;]*m/g, ""), "lead");
});
