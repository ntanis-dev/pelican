import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commands, main } from "../src/cli.js";
import { harness, until } from "./helpers.js";
import * as format from "../src/format.js";
import { makePaint } from "../src/paint.js";

// What a terminal gets; the tests' own printer is a pipe, so plain text.
const terminal = makePaint({ pretty: true, color: true, depth: 24 });
const bare = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// The CLI against an in-process gateway: the same calls the HTTP client makes.
async function cli(t) {
  const fixture = await harness(t);
  const run = async (argv, as = "lead", paint) => {
    const out = [],
      err = [];
    const code = await main(argv, {
      print: (text) => out.push(text),
      error: (text) => err.push(text),
      client: fixture.gateway.as(as, { cwd: fixture.dir }),
      ...(paint ? { paint } : {}),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { ...fixture, run };
}

test("help lists every command, and each command has usage and an example", async (t) => {
  const { run } = await cli(t);
  const all = await run(["help"]);
  assert.equal(all.code, 0);
  for (const name of [
    "start",
    "stop-service",
    "status",
    "login",
    "doctor",
    "workspaces",
    "workspace",
    "settings",
    "spawn",
    "batch",
    "list",
    "get",
    "tail",
    "wait",
    "message",
    "resume",
    "answer",
    "questions",
    "stop",
    "events",
  ])
    assert.match(all.out, new RegExp(`^  ${name} `, "m"), name);
  for (const [name, entry] of commands) {
    assert.ok(entry.usage.startsWith(`pelican ${name}`), name);
    assert.ok(entry.example && entry.summary && entry.group, name);
  }
  assert.match((await run(["spawn", "--help"])).out, /--result-schema/);
  const unknown = await run(["fly"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown command fly/);
  const badFlag = await run(["list", "--colour"]);
  assert.equal(badFlag.code, 1);
  assert.match(badFlag.err, /Usage: pelican list/);
});

test("spawn, list, get, answer and wait from the command line", async (t) => {
  const { run, o, dir, workers } = await cli(t);
  const schemaFile = join(dir, "result.json");
  await writeFile(
    schemaFile,
    JSON.stringify({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    }),
  );
  const spawned = await run([
    "spawn",
    "--prompt",
    "Check the build\nand report",
    "--read-only",
    "--effort",
    "low",
    "--result-schema",
    schemaFile,
    "--json",
  ]);
  assert.equal(spawned.code, 0, spawned.err);
  const job = JSON.parse(spawned.out);
  assert.equal(job.name, "Check the build");
  assert.equal(job.effort, "low");
  assert.equal(job.owner, "lead");
  assert.deepEqual(o.get(job.id).resources, []);
  assert.deepEqual(o.get(job.id).resultSchema.required, ["ok"]);
  await until(() => o.get(job.id).status === "running");
  const listed = await run(["list", "--mine"]);
  assert.match(listed.out, /^ID\s+STATUS\s+AGENT/m);
  assert.match(listed.out, new RegExp(`${job.id.slice(0, 8)}\\s+running`));
  assert.match((await run(["list", "--owner", "someone"])).out, /No agents/);
  workers[0].call("pelican_ask", { question: "Which build?" }, "q");
  const waited = await run(["wait", job.id.slice(0, 8)]);
  assert.equal(waited.code, 3);
  assert.match(waited.out, /waiting for an answer/);
  const questions = await run(["questions", "--json"]);
  const [question] = JSON.parse(questions.out);
  assert.match((await run(["questions"])).out, /For lead:[\s\S]*Which build\?/);
  const answered = await run([
    "answer",
    job.id,
    question.requestId.slice(0, 8),
    "The",
    "release",
    "build",
  ]);
  assert.equal(answered.code, 0, answered.err);
  assert.equal(
    JSON.parse(workers[0].answer("q").result.contentItems[0].text).answer,
    "The release build",
  );
  const detail = await run(["get", job.agentName]);
  assert.match(detail.out, /status: running/);
  assert.match(detail.out, /reserves: nothing \(read-only\)/);
  assert.match(detail.out, /result: not given yet/);
  workers[0].call("pelican_report", {
    report: "Build is fine.",
    result: '{"ok":true}',
  });
  workers[0].complete();
  const done = await run(["wait", job.id, "--timeout", "5"]);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^Done\./);
  assert.match(done.out, /"ok": true/);
  assert.match(done.out, /report:\n\s+Build is fine\./);
  const timedOut = await run([
    "spawn",
    "--prompt",
    "Slow",
    "--read-only",
    "--wait",
    "--timeout",
    "0.05",
  ]);
  assert.equal(timedOut.code, 2);
  assert.match(timedOut.out, /timed out/);
});

test("settings, messages and stop take readable flags and reject bad ones", async (t) => {
  const { run, o, workers } = await cli(t);
  const changed = await run([
    "settings",
    "--network",
    "true",
    "--concurrency",
    "10",
    "--paused",
    "false",
  ]);
  assert.equal(changed.code, 0, changed.err);
  assert.match(
    changed.out,
    /concurrency 10, paused false, model gpt-6.1-sol, effort high, network true/,
  );
  assert.equal(o.settings.network, true);
  const bad = await run(["settings", "--network", "maybe"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--network takes true or false/);
  const anonymous = await run(
    ["spawn", "--prompt", "Who am I", "--read-only"],
    null,
  );
  assert.equal(anonymous.code, 1);
  assert.match(anonymous.err, /Name yourself/);
  const job = JSON.parse(
    (await run(["spawn", "--prompt", "Talk", "--read-only", "--json"])).out,
  );
  await until(() => o.get(job.id).status === "running");
  const message = await run(["message", job.id, "Use", "port", "4319"]);
  assert.match(message.out, /steered into its running turn/);
  assert.match(
    workers[0].last("turn/steer").params.input[0].text,
    /Use port 4319/,
  );
  assert.equal((await run(["stop"])).code, 1);
  const stopped = await run(["stop", job.id, "--reason", "Enough"]);
  assert.match(stopped.out, /Stopped .*interrupted/);
  const tail = await run(["tail", job.id]);
  assert.match(tail.out, /Assignment from lead: Talk/);
  assert.match(tail.out, /Stop requested by lead: Enough/);
  const events = await run(["events"]);
  assert.match(events.out, /spawned by lead: Talk/);
  assert.match(events.out, /settings changed by lead: .*network true/);
});

test("watch prints one line per question, finish and quiet agent, and resumes from its state file", async (t) => {
  const { run, o, spec, workers, dir } = await cli(t);
  const done = (worker) => {
    worker.say(`${worker.job.name} is done`);
    worker.complete();
  };
  const named = (name) =>
    until(() => workers.some((w) => w.job.name === name && w.turnId)).then(() =>
      workers.find((w) => w.job.name === name),
    );
  // Finished before anyone watched: not news.
  const old = await o.create(spec("Old"), "lead");
  done(await named("Old"));
  await until(() => old.status === "completed");
  const state = join(dir, "watch.cursor");
  const watching = run([
    "watch",
    "--state",
    state,
    "--stall",
    "0",
    "--for",
    "3",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await o.create(spec("Asker"), "lead");
  (await named("Asker")).call("pelican_ask", { question: "Which way?" });
  const doer = await o.create(spec("Doer"), "lead");
  done(await named("Doer"));
  await until(() => doer.status === "completed");
  await o.create(spec("Quiet"), "lead");
  await named("Quiet");
  const first = await watching;
  assert.equal(first.code, 0);
  const lines = first.out.split("\n");
  assert.match(lines[0], /Watching lead: questions/);
  assert.ok(lines.every((line) => /^\d\d:\d\d:\d\d /.test(line)));
  assert.match(
    first.out,
    /asks \(\w{8}, Asker\): Which way\? \| pelican answer \w{8} \w{8} <answer>/,
  );
  assert.match(first.out, /completed \(\w{8}, Doer\): Doer is done/);
  assert.match(first.out, /\(\w{8}, Quiet\) has been quiet for 0 min/);
  assert.doesNotMatch(first.out, /, Old\)/);
  // What happens between two watches comes first in the next one.
  const between = await o.create(spec("Between"), "lead");
  done(await named("Between"));
  await until(() => between.status === "completed");
  const second = await run(["watch", "--state", state, "--for", "1"]);
  assert.match(second.out, /completed \(\w{8}, Between\)/);
  assert.doesNotMatch(second.out, /, Doer\)|, Asker\)/);
  assert.match((await run(["watch", "--for", "1"], "")).err, /Name yourself/);
});

test("usage prints the account's limits, and --refresh asks for a fresh reading", async (t) => {
  const { run, usage, usageCalls } = await cli(t);
  const plain = await run(["usage"]);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /Codex usage \(pro\), read 12m ago:/);
  assert.match(plain.out, /5h +█+░+ +35% used, resets in 2h 10m/);
  assert.match(plain.out, /weekly +█+░+ +12% used, resets in 3d 4h/);
  assert.match(plain.out, /credits none/);
  const fresh = await run(["usage", "--refresh", "--json"]);
  assert.deepEqual(JSON.parse(fresh.out), usage);
  assert.deepEqual(usageCalls, [{ refresh: false }, { refresh: true }]);
  const paid = {
    ...usage,
    credits: { unlimited: false, has: true, balance: "21870.7527170000" },
  };
  assert.match(format.usage(paid), /credits balance 21,870.75/);
  assert.match(
    format.usage({ ...paid, credits: { ...paid.credits, unlimited: true } }),
    /credits unlimited/,
  );
  assert.match((await run(["help"])).out, /\n {2}usage +The Codex account/);
});

test("a terminal gets colour and marks; a pipe, --json and --plain get plain text", async (t) => {
  const { run, o, spec, workers } = await cli(t);
  await o.create(spec("Fix the flaky login test"), "lead");
  await until(() => workers.some((w) => w.turnId));
  const piped = await run(["list"]);
  assert.doesNotMatch(piped.out, /\x1b|●/);
  assert.match(piped.out, /^ID\s+STATUS\s+AGENT/m);
  assert.match(piped.out, /\brunning\b/);
  const styled = await run(["list"], "lead", terminal);
  assert.match(styled.out, /\x1b\[/);
  assert.match(bare(styled.out), /^ID\s+STATUS\s+AGENT/m);
  assert.match(bare(styled.out), /● running/);
  // Colour and marks never move a column.
  const [head, first] = bare(styled.out).split("\n");
  assert.equal(first.indexOf("Fix the flaky login test"), head.indexOf("TASK"));
  assert.equal(first.indexOf("lead"), head.indexOf("OWNER"));
  const asJson = await run(["list", "--json"], "lead", terminal);
  assert.doesNotMatch(asJson.out, /\x1b/);
  assert.equal(JSON.parse(asJson.out).length, 1);
  const plain = await run(["list", "--plain"], "lead", terminal);
  assert.equal(plain.out, piped.out);
  // Errors take the mark on a terminal and nothing in a pipe.
  const bad = await run(["get"], "lead", terminal);
  assert.match(bare(bad.err), /^✗ pelican get: Usage: pelican get <id>/);
  assert.doesNotMatch((await run(["get"])).err, /\x1b|✗/);
  assert.match(
    bare((await run(["help"], "lead", terminal)).out),
    /Briefs out\. Results back\./,
  );
  assert.doesNotMatch((await run(["help"])).out, /\x1b|Briefs out/);
  assert.match((await run(["help"])).out, /--plain/);
});

test("on a terminal an open question shows its answer command and agent text is cleaned", async (t) => {
  const { run, o, spec, workers } = await cli(t);
  const job = await o.create(spec("Pick a build"), "lead");
  await until(() => workers.some((w) => w.turnId));
  workers[0].call("pelican_ask", {
    question: "Which build?\u001b]0;owned\u0007 \u001b[31mred",
  });
  await until(() => job.pending.length === 1);
  const styled = bare((await run(["questions"], "lead", terminal)).out);
  assert.match(styled, /^For lead:/);
  assert.match(styled, /◆ .* \(\w{8}\) in test-ws/);
  assert.match(styled, /Which build\? red/);
  assert.match(styled, /answer: pelican answer \w{8} \w{8} <answer>/);
  assert.doesNotMatch(styled, /\x1b|owned/);
  const detail = bare(
    (await run(["get", job.id.slice(0, 8)], "lead", terminal)).out,
  );
  assert.match(detail, /status +◆ waiting\? · owner lead/);
  assert.match(detail, /reserves +/);
});

test("watch on a terminal lights its lines and keeps the answer command", async (t) => {
  const { run, o, spec, workers } = await cli(t);
  const watching = run(
    ["watch", "--stall", "0", "--for", "2"],
    "lead",
    terminal,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await o.create(spec("Asker"), "lead");
  await until(() => workers.some((w) => w.job.name === "Asker" && w.turnId));
  workers
    .find((w) => w.job.name === "Asker")
    .call("pelican_ask", {
      question: "Which way?",
    });
  const { out, code } = await watching;
  assert.equal(code, 0);
  assert.match(out, /\x1b\[/);
  const lines = bare(out).split("\n");
  assert.ok(lines.every((line) => /^\d\d:\d\d:\d\d /.test(line)));
  assert.match(lines[0], /^\d\d:\d\d:\d\d ● Watching lead: questions/);
  assert.match(
    out && bare(out),
    /\[test-ws\] ◆ .* asks \(\w{8}, Asker\): Which way\? \| pelican answer \w{8} \w{8} <answer>/,
  );
});

test("a long body never cuts the answer command off a watch line", () => {
  const entry = {
    type: "agent.question",
    workspace: "w",
    jobId: "a".repeat(32),
    title: "Quiet asks",
    body: "word ".repeat(400),
    data: { pending: [{ id: "b".repeat(32) }] },
  };
  const line = format.watchLine(entry);
  assert.match(line, /… \| pelican answer aaaaaaaa bbbbbbbb <answer>$/);
  assert.ok(line.length < 700);
  assert.doesNotMatch(line, /\n/);
});
