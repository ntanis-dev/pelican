import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Fleet } from "../src/fleet.js";
import { Workspaces } from "../src/workspaces.js";
import { Gateway } from "../src/gateway.js";
import { root } from "../src/config.js";
import { main } from "../src/cli.js";
import { parseWorkflow } from "../src/workflow.js";
import { callHash } from "../src/runner.js";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeWorker, harness, until } from "./helpers.js";

// Workflow runs against fake Codex workers: the script runs for real in its
// worker thread; the agents are the test's to finish.
const finish = (worker, { result, report, summary } = {}) => {
  if (result !== undefined || report !== undefined)
    worker.call("pelican_report", {
      report: report ?? `Report of ${worker.job.name}`,
      ...(result !== undefined ? { result: JSON.stringify(result) } : {}),
    });
  worker.say(summary ?? `${worker.job.name} done`);
  worker.complete();
};
// The nth worker (from 1) for agents labelled so, once its turn runs.
async function agentNamed(workers, label, nth = 1) {
  let found;
  await until(() => {
    found = workers.filter((w) => w.job.name === label)[nth - 1];
    return found?.job.status === "running" && found.turnId;
  });
  return found;
}
async function setup(t, overrides) {
  const fx = await harness(t, overrides);
  t.after(() => fx.gateway.runner.close());
  const script = async (name, text) => {
    const file = join(fx.dir, name);
    await writeFile(file, text);
    return file;
  };
  return {
    ...fx,
    lead: fx.as("lead", { cwd: fx.dir }),
    script,
    agent: (label, nth) => agentNamed(fx.workers, label, nth),
  };
}
// One workspace over an existing folder, as a service start opens it.
function world(dir) {
  const store = new Store(dir),
    workers = [];
  const fleet = new Fleet({
    store,
    config: {
      dataDir: dir,
      codexBin: "codex",
      token: "test-only-token-12345678901234567890",
      host: "127.0.0.1",
      port: 0,
      workspace: { id: "test-ws", name: "Test", folder: dir },
    },
    workerFactory: (job) => {
      const worker = new FakeWorker(job);
      workers.push(worker);
      return worker;
    },
  });
  const hub = Workspaces.single(fleet);
  const gateway = new Gateway(hub, {
    account: {
      status: async () => ({ connected: true }),
      close: async () => {},
    },
  });
  return {
    store,
    fleet,
    hub,
    gateway,
    workers,
    lead: gateway.as("lead", { cwd: dir }),
  };
}

test("workflow scripts: meta is a plain literal, exports and syntax errors are checked with their line", () => {
  const parsed = parseWorkflow(
    `#!/usr/bin/env node
export const meta = {
  name: "demo", // a } in a comment
  description: 'a { and a \` in a string',
  phases: [{ title: "A", detail: "first" }, { title: "B" }, { title: "A" }],
};
const pattern = /[}'"]/g;
const prompt = \`
export default stays text inside a template \${"}"}
\`;
export const twice = (n) => n * 2 / 1;
return twice(args.n);
`,
    "demo.js",
  );
  assert.deepEqual(parsed.meta, {
    name: "demo",
    description: "a { and a ` in a string",
    phases: [{ title: "A", detail: "first" }, { title: "B" }],
  });
  assert.match(parsed.code, /export default stays text/);
  assert.match(parsed.code, /^const twice/m);
  for (const [source, error] of [
    ["const x = 1;", /starts with export const meta/],
    [`export const meta = { name: x, description: "d" };`, /plain literal/],
    [`export const meta = { name: "n" };`, /description/],
    [
      `export const meta = { name: "n", description: "d" };\nconst = 2;`,
      /bad\.js:2: /,
    ],
    [
      `export const meta = { name: "n", description: "d" };\nimport fs from "node:fs";`,
      /cannot import modules/,
    ],
    [
      `export const meta = { name: "n", description: "d" };\nexport { meta as m };`,
      /only export const meta and export default/,
    ],
  ])
    assert.throws(() => parseWorkflow(source, "bad.js"), error);
  // The journal hash covers what shapes the work, not how it is shown.
  assert.equal(
    callHash("p", { label: "a", phase: "X", name: "n", priority: 3 }),
    callHash("p", {}),
  );
  assert.notEqual(callHash("p", { effort: "low" }), callHash("p", {}));
  assert.equal(
    callHash("p", { schema: { type: "object", required: ["a"] } }),
    callHash("p", { schema: { required: ["a"], type: "object" } }),
  );
});

test("parallel keeps its thunks' order; pipeline moves each item through its stages on its own", async (t) => {
  const { lead, script, agent } = await setup(t);
  const file = await script(
    "order.js",
    `export const meta = { name: "order", description: "Ordering" };
const fanned = await parallel([
  () => agent("First", { label: "p1", resources: [] }),
  () => agent("Second", { label: "p2", resources: [] }),
  () => agent("Third", { label: "p3", resources: [] }),
]);
const piped = await pipeline(
  ["a", "b"],
  (item) => agent("Stage one of " + item, { label: "one-" + item, resources: [] }),
  (previous, item, index) =>
    agent("Stage two of " + item + " after " + previous.summary + " at " + index, { label: "two-" + item, resources: [] }),
);
return { fanned: fanned.map((r) => r.summary), piped: piped.map((r) => r.summary) };
`,
  );
  const run = await lead.startRun({ file });
  assert.equal(run.status, "running");
  assert.equal(run.owner, "lead");
  assert.equal(run.name, "order");
  const [p1, p2, p3] = await Promise.all(
    ["p1", "p2", "p3"].map((l) => agent(l)),
  );
  finish(p3, { summary: "S3" });
  finish(p2, { summary: "S2" });
  finish(p1, { summary: "S1" });
  const [a1, b1] = await Promise.all([agent("one-a"), agent("one-b")]);
  finish(b1, { summary: "B1" });
  // b reaches its second stage while a is still in its first.
  const b2 = await agent("two-b");
  assert.equal(a1.job.status, "running");
  assert.equal(b2.job.prompt, "Stage two of b after B1 at 1");
  finish(a1, { summary: "A1" });
  const a2 = await agent("two-a");
  finish(b2, { summary: "B2" });
  finish(a2, { summary: "A2" });
  const done = await lead.waitRun(run.id, { timeoutMs: 5000 });
  assert.equal(done.reason, "done");
  assert.equal(done.run.status, "completed");
  assert.deepEqual(done.run.result, {
    fanned: ["S1", "S2", "S3"],
    piped: ["A2", "B2"],
  });
  assert.deepEqual(done.run.agents, { total: 7, live: 0, done: 7, failed: 0 });
  assert.deepEqual(
    done.run.phases.map((p) => p.title),
    ["(no phase)"],
  );
  assert.deepEqual(
    done.run.phases[0].agents.map((a) => a.label),
    ["p1", "p2", "p3", "one-a", "one-b", "two-b", "two-a"],
  );
  assert.ok(
    done.run.phases[0].agents.every((a) => a.status === "completed" && a.jobId),
  );
});

test("with a schema agent() returns the validated result, else summary and report; export default and phases work", async (t) => {
  const { lead, script, agent } = await setup(t);
  const file = await script(
    "schema.js",
    `export const meta = {
  name: "schema",
  description: "Structured results",
  phases: [{ title: "Check", detail: "one agent" }, { title: "Report" }],
};
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
export default async function main(input) {
  phase("Check");
  const verdict = await agent("Check it", { label: "check", resources: [], schema: SCHEMA, effort: "low" });
  log("verdict", verdict.ok);
  const plain = await agent("Say hi", { label: "hi", phase: "Report", resources: [], model: "sonnet" });
  return { verdict, plain, input };
}
`,
  );
  const run = await lead.startRun({ file, args: { n: 1 } });
  const check = await agent("check");
  assert.equal(check.job.effort, "low");
  assert.deepEqual(check.job.resultSchema.required, ["ok"]);
  assert.equal(check.job.owner, "lead");
  finish(check, { result: { ok: true } });
  const hi = await agent("hi");
  // A Claude Code model name leaves the workspace's model in place.
  assert.equal(hi.job.model, "gpt-6.1-sol");
  finish(hi, { report: "Said hi.", summary: "Hi" });
  const { run: done } = await lead.waitRun(run.id, { timeoutMs: 5000 });
  assert.equal(done.status, "completed");
  assert.deepEqual(done.result, {
    verdict: { ok: true },
    plain: { summary: "Hi", report: "Said hi." },
    input: { n: 1 },
  });
  assert.deepEqual(done.phases, [
    {
      title: "Check",
      agents: [{ label: "check", jobId: check.job.id, status: "completed" }],
    },
    {
      title: "Report",
      agents: [{ label: "hi", jobId: hi.job.id, status: "completed" }],
    },
  ]);
  const lines = done.log.map((l) => l.text);
  assert.ok(lines.includes("verdict true"));
  assert.ok(lines.includes("Phase: Check"));
  assert.ok(lines.some((l) => /"sonnet" is a Claude Code model name/.test(l)));
  // The contract's shapes, exactly.
  assert.deepEqual(Object.keys(done).sort(), [
    "agents",
    "cwd",
    "endedAt",
    "error",
    "id",
    "log",
    "name",
    "owner",
    "phases",
    "questions",
    "result",
    "startedAt",
    "status",
    "workspace",
  ]);
  const [row] = await lead.runs();
  assert.deepEqual(row, {
    id: run.id,
    name: "schema",
    workspace: "test-ws",
    cwd: done.cwd,
    owner: "lead",
    status: "completed",
    startedAt: done.startedAt,
    endedAt: done.endedAt,
    agents: { total: 2, live: 0, done: 2, failed: 0 },
  });
  // What the run did is journaled under its owner, with the run's id.
  const journal = (
    await lead.events({ owner: "lead", last: 100 })
  ).events.filter((e) => e.type.startsWith("run."));
  assert.deepEqual(
    journal.map((e) => e.type),
    [
      "run.started",
      "run.note",
      "run.agent",
      "run.note",
      "run.note",
      "run.agent",
      "run.finished",
    ],
  );
  assert.ok(
    journal.every(
      (e) => e.data.runId === run.id && e.data.owner === "lead" && !e.jobId,
    ),
  );
  assert.deepEqual(
    journal
      .filter((e) => e.type === "run.agent")
      .map((e) => [e.data.label, e.data.jobId, e.data.continued]),
    [
      ["check", check.job.id, false],
      ["hi", hi.job.id, false],
    ],
  );
  assert.deepEqual(
    journal
      .filter((e) => e.type === "run.note")
      .map((e) => e.data.text)
      .slice(0, 2),
    ["Phase: Check", "verdict true"],
  );
  assert.equal(journal.at(-1).data.status, "completed");
  assert.deepEqual(journal.at(-1).data.result, done.result);
  assert.deepEqual((await lead.events({ owner: "someone" })).events, []);
  assert.equal((await lead.runs({ status: "running" })).length, 0);
  assert.equal((await lead.runs({ status: ["failed,completed"] })).length, 1);
  await assert.rejects(lead.runs({ status: "sleeping" }), /Unknown run status/);
  assert.equal((await lead.getRun("schema")).id, run.id);
  assert.equal((await lead.getRun(run.id.slice(0, 6))).id, run.id);
  await assert.rejects(lead.getRun("nothing"), /No run "nothing"/);
});

test("a failed agent gives null and the script goes on; a script that throws fails its run; mistakes are caught at the start", async (t) => {
  const { lead, script, agent, as } = await setup(t);
  const file = await script(
    "fails.js",
    `export const meta = { name: "fails", description: "Failures" };
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const results = await parallel([
  () => agent("Will fail", { label: "bad", resources: [], schema: SCHEMA }),
  () => agent("Will pass", { label: "good", resources: [] }),
  () => { throw new Error("thunk bug"); },
]);
let thrown = null;
try {
  await agent("Unsatisfiable", { label: "wat", resources: [], schema: { type: "wat" } });
} catch (error) {
  thrown = error.message;
}
return { results: results.map((r) => r && r.summary), thrown };
`,
  );
  const run = await lead.startRun({ file });
  const [bad, good] = await Promise.all([agent("bad"), agent("good")]);
  finish(good, { summary: "fine" });
  // No result: Pelican resumes it once, then it fails.
  finish(bad);
  finish(await agent("bad", 2));
  const { run: done } = await lead.waitRun(run.id, { timeoutMs: 5000 });
  assert.equal(done.status, "completed");
  assert.deepEqual(done.result.results, [null, "fine", null]);
  assert.match(done.result.thrown, /not a usable JSON Schema/);
  assert.deepEqual(done.agents, { total: 3, live: 0, done: 1, failed: 2 });
  const text = done.log.map((l) => l.text).join("\n");
  assert.match(
    text,
    /bad: .* failed: Finished without a valid result.*agent\(\) returns null/,
  );
  assert.match(text, /parallel item 2 failed: thunk bug/);
  assert.match(text, /wat: .*not a usable JSON Schema/);
  // A script that throws fails the run and says where.
  const boom = await lead.startRun({
    source: `export const meta = { name: "boom", description: "Throws" };\nlog("before");\nthrow new Error("boom");\n`,
  });
  const failed = await lead.waitRun(boom.id, { timeoutMs: 5000 });
  assert.equal(failed.run.status, "failed");
  assert.match(failed.run.error, /^boom \(at workflow\.js:3:/);
  assert.equal(failed.run.log[1].text, "before");
  // What the start refuses.
  const meta = `export const meta = { name: "n", description: "d" };\n`;
  await assert.rejects(
    lead.startRun({ source: "const x = 1" }),
    /export const meta/,
  );
  await assert.rejects(
    lead.startRun({ source: `${meta}const = 2;` }),
    /workflow\.js:2: /,
  );
  await assert.rejects(
    lead.startRun({ file: join(root, "no-such-workflow.js") }),
    /no such file/,
  );
  await assert.rejects(lead.startRun({}), /file \(its path\) or source/);
  await assert.rejects(lead.startRun({ file, source: meta }), /not both/);
  await assert.rejects(
    as(undefined).startRun({ source: meta }),
    /Name yourself/,
  );
  // An agent() call with bad options rejects in the script.
  const opts = await lead.startRun({
    source: `${meta}try { await agent("x", { colour: "red" }); } catch (e) { return e.message; }`,
  });
  const refused = await lead.waitRun(opts.id, { timeoutMs: 5000 });
  assert.match(refused.run.result, /agent\(\) options: .*colour/s);
});

test("run-stop ends the script and its agents; resume replays what completed, continues what was cut off and runs what changed", async (t) => {
  const { lead, script, agent, workers, store, as, o } = await setup(t);
  const steps = (
    third,
  ) => `export const meta = { name: "resumable", description: "Three steps" };
const a = await agent("Step one", { label: "one", resources: [] });
const b = await agent("Step two after " + a.summary, { label: "two", resources: [] });
const c = await agent(${JSON.stringify(third)}, { label: "three", resources: [] });
return [a.summary, b.summary, c.summary];
`;
  const file = await script("steps.js", steps("Step three"));
  const run = await lead.startRun({ file });
  finish(await agent("one"), { summary: "A" });
  const two = await agent("two");
  const stopped = await as("reviewer").stopRun(run.id, { reason: "Lunch" });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.error, "Stopped by reviewer: Lunch");
  assert.equal(two.job.status, "interrupted");
  assert.deepEqual(
    stopped.phases[0].agents.map((a) => [a.label, a.status]),
    [
      ["one", "completed"],
      ["two", "interrupted"],
    ],
  );
  assert.deepEqual(stopped.agents, { total: 2, live: 0, done: 1, failed: 1 });
  // The script is gone: nothing else starts.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(workers.length, 2);
  assert.equal((await lead.stopRun(run.id)).status, "stopped");
  await assert.rejects(as("reviewer").resumeRun(run.id), /belongs to lead/);
  // Step one replays; step two's agent continues its own conversation.
  const resumed = await lead.resumeRun(run.id);
  assert.equal(resumed.status, "running");
  const twoAgain = await agent("two", 2);
  assert.equal(twoAgain.job.id, two.job.id);
  assert.ok(twoAgain.last("thread/resume"));
  assert.match(
    twoAgain.last("turn/start").params.input[0].text,
    /Continue the assignment from the existing state/,
  );
  await assert.rejects(lead.resumeRun(run.id), /still running/);
  finish(twoAgain, { summary: "B" });
  finish(await agent("three"), { summary: "C" });
  const first = await lead.waitRun(run.id, { timeoutMs: 5000 });
  assert.deepEqual(first.run.result, ["A", "B", "C"]);
  assert.deepEqual(
    first.run.phases[0].agents.map((a) => a.status),
    ["replayed", "completed", "completed"],
  );
  assert.equal(workers.filter((w) => w.job.name === "one").length, 1);
  // An edited script resumes against the same journal: only the changed
  // call runs.
  await writeFile(file, steps("Step three, edited"));
  const count = workers.length;
  await lead.resumeRun(run.id);
  const three = await agent("three", 2);
  assert.notEqual(three.job.id, first.run.phases[0].agents[2].jobId);
  assert.equal(three.job.prompt, "Step three, edited");
  finish(three, { summary: "C2" });
  const second = await lead.waitRun(run.id, { timeoutMs: 5000 });
  assert.deepEqual(second.run.result, ["A", "B", "C2"]);
  assert.equal(workers.length, count + 1);
  assert.deepEqual(
    second.run.phases[0].agents.map((a) => a.status),
    ["replayed", "replayed", "completed"],
  );
  assert.match(
    second.run.log.at(-1).text,
    /Completed: 3 agent calls, 2 replayed from the journal/,
  );
  // New args are new prompts; the same args again replay everything.
  await lead.resumeRun(run.id, { args: { unused: true } });
  const third = await lead.waitRun(run.id, { timeoutMs: 5000 });
  assert.deepEqual(third.run.result, ["A", "B", "C2"]);
  assert.equal(workers.length, count + 1);
  const runEvents = store
    .events({ types: ["run.*"] })
    .filter((e) => e.data.runId === run.id);
  const stop = runEvents.find((e) => e.type === "run.stopped");
  assert.deepEqual(
    [stop.data.by, stop.data.to, stop.data.reason],
    ["reviewer", "lead", "Lunch"],
  );
  // Both the owner's and the stopper's timelines show the stop.
  for (const who of ["lead", "reviewer"])
    assert.ok(
      (await lead.call("feed", { as: who, last: 200 })).entries.some(
        (e) => e.type === "run.stopped" && e.runId === run.id,
      ),
      who,
    );
  assert.deepEqual(
    runEvents
      .filter((e) => e.type === "run.resumed")
      .map((e) => [e.data.execution, e.data.replayable]),
    // By execution 4 both versions of step three hold a result.
    [
      [2, 1],
      [3, 3],
      [4, 4],
    ],
  );
  assert.ok(
    runEvents.some(
      (e) =>
        e.type === "run.agent" && e.data.label === "two" && e.data.continued,
    ),
  );
  // The journal holds every call of every execution.
  const journal = store.runCalls(run.id);
  assert.deepEqual(
    journal.map((e) => [e.execution, e.index, e.label, e.status]),
    [
      [1, 0, "one", "completed"],
      [1, 1, "two", "interrupted"],
      [2, 0, "one", "replayed"],
      [2, 1, "two", "completed"],
      [2, 2, "three", "completed"],
      [3, 0, "one", "replayed"],
      [3, 1, "two", "replayed"],
      [3, 2, "three", "completed"],
      [4, 0, "one", "replayed"],
      [4, 1, "two", "replayed"],
      [4, 2, "three", "replayed"],
    ],
  );
  assert.equal(journal[1].jobId, journal[3].jobId);
  assert.equal(journal[0].hash, journal[2].hash);
  assert.notEqual(journal[4].hash, journal[7].hash);
  // A script whose file is gone resumes from the copy kept at its start.
  await rm(file);
  await lead.resumeRun(run.id);
  const kept = await lead.waitRun(run.id, { timeoutMs: 5000 });
  assert.deepEqual(kept.run.result, ["A", "B", "C2"]);
  assert.ok(
    kept.run.log.some((l) =>
      /could not be read; resuming with the copy/.test(l.text),
    ),
  );
  assert.equal(o.active.size, 0);
});

test("stop --all stops runs before agents, and a workspace with a running run stays", async (t) => {
  const { lead, script, agent, gateway, workers } = await setup(t);
  const file = await script(
    "loop.js",
    `export const meta = { name: "loop", description: "Keeps going" };
const out = [];
for (let i = 0; i < 5; i++) out.push(await agent("Item " + i, { label: "item-" + i, resources: [] }));
return out;
`,
  );
  const run = await lead.startRun({ file });
  await agent("item-0");
  await assert.rejects(
    gateway.invoke("workspace.remove", { workspace: "test-ws" }),
    /1 workflow run running/,
  );
  const all = await lead.stop({ all: true });
  assert.deepEqual(
    all.runs.map((r) => [r.id, r.status]),
    [[run.id, "stopped"]],
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Its script did not go on to item-1.
  assert.equal(workers.length, 1);
  assert.equal((await lead.getRun(run.id)).status, "stopped");
});

test("an agent's question waits for the run's owner and shows in the run", async (t) => {
  const { lead, script, agent, as } = await setup(t);
  const file = await script(
    "ask.js",
    `export const meta = { name: "ask", description: "Asks" };
const answer = await agent("Ask first", { label: "asker", resources: [] });
return answer.summary;
`,
  );
  const reviewer = as("reviewer", { cwd: lead.context.cwd });
  const run = await reviewer.startRun({ file });
  const asker = await agent("asker");
  asker.call("pelican_ask", { question: "Which database?" }, "q1");
  const waited = await reviewer.waitRun(run.id, { timeoutMs: 5000 });
  assert.equal(waited.reason, "question");
  assert.equal(waited.run.status, "running");
  const [question] = waited.run.questions;
  assert.equal(question.question, "Which database?");
  assert.equal(question.owner, "reviewer");
  assert.equal(question.label, "asker");
  assert.equal(question.jobId, asker.job.id);
  assert.deepEqual(
    (await lead.questions()).map((q) => [q.owner, q.requestId]),
    [["reviewer", question.requestId]],
  );
  await assert.rejects(
    lead.answer(asker.job.id, question.requestId, "SQLite"),
    /belongs to reviewer/,
  );
  await reviewer.answer(asker.job.id, question.requestId, "SQLite");
  assert.equal(
    JSON.parse(asker.answer("q1").result.contentItems[0].text).answer,
    "SQLite",
  );
  assert.deepEqual((await reviewer.getRun(run.id)).questions, []);
  // The run kept waiting meanwhile.
  finish(asker, { summary: "Used SQLite" });
  const done = await reviewer.waitRun(run.id, { timeoutMs: 5000 });
  assert.equal(done.reason, "done");
  assert.equal(done.run.result, "Used SQLite");
  // With after, a wait returns at the next change instead.
  const since = await reviewer.waitRun(run.id, { timeoutMs: 0, after: 0 });
  assert.equal(since.reason, "done");
  assert.ok(since.version > 0);
});

test("a run that was running when the service stopped is interrupted on the next start and resumes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pelican-runs-"));
  const opened = [];
  t.after(async () => {
    for (const w of opened) {
      w.gateway.runner.close();
      if (w.store.closed) continue;
      await w.fleet.shutdown();
      w.store.close();
    }
    await rm(dir, { recursive: true, force: true });
  });
  const first = world(dir);
  opened.push(first);
  const file = join(dir, "long.js");
  await writeFile(
    file,
    `export const meta = { name: "long", description: "One long agent" };
const done = await agent("Work a long time", { label: "long", resources: [] });
return done.summary;
`,
  );
  const run = await first.lead.startRun({ file });
  const long = await agentNamed(first.workers, "long");
  // The process dies: nothing is written on the way out.
  first.gateway.runner.close();
  first.store.close();
  const second = world(dir);
  opened.push(second);
  const after = await second.lead.getRun(run.id);
  assert.equal(after.status, "interrupted");
  assert.match(after.error, /restarted while this run was working/);
  assert.equal(second.fleet.get(long.job.id).status, "interrupted");
  assert.deepEqual(after.phases[0].agents, [
    { label: "long", jobId: long.job.id, status: "interrupted" },
  ]);
  assert.equal(
    (await second.lead.runs({ status: "interrupted" }))[0].id,
    run.id,
  );
  // Nothing runs again by itself.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(second.workers.length, 0);
  await second.lead.resumeRun(run.id);
  const again = await agentNamed(second.workers, "long");
  assert.equal(again.job.id, long.job.id);
  finish(again, { summary: "Long done" });
  const done = await second.lead.waitRun(run.id, { timeoutMs: 5000 });
  assert.equal(done.run.result, "Long done");
  // A graceful shutdown interrupts a live run too, and says so.
  const live = await second.lead.startRun({
    source: `export const meta = { name: "live", description: "Live" };\nawait agent("Still going", { label: "live", resources: [] });\n`,
  });
  await agentNamed(second.workers, "live");
  await second.hub.shutdown();
  const interrupted = await second.lead.getRun(live.id);
  assert.equal(interrupted.status, "interrupted");
  assert.match(interrupted.error, /shut down while this run was working/);
  const timeline = await second.lead.call("feed", { as: "lead", last: 200 });
  assert.ok(
    timeline.entries.some(
      (e) =>
        e.type === "run.finished" &&
        e.runId === live.id &&
        e.data.status === "interrupted",
    ),
  );
  assert.ok(
    timeline.entries.some(
      (e) =>
        e.type === "run.finished" &&
        e.runId === run.id &&
        e.data.status === "interrupted" &&
        /restarted/.test(e.data.error),
    ),
  );
  assert.equal(second.hub.listenerCount("closing"), 0);
});

// The CLI against an in-process gateway, as cli.test.js does.
test("the workflow commands: run, runs, run-status, run-stop, run-wait, run --resume", async (t) => {
  const fx = await setup(t);
  const { script, agent, workers } = fx;
  const run = async (argv) => {
    const out = [],
      err = [];
    const code = await main(argv, {
      print: (text) => out.push(text),
      error: (text) => err.push(text),
      client: fx.gateway.as("lead", { cwd: fx.dir }),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const file = await script(
    "hello.js",
    `export const meta = { name: "hello", description: "One agent", phases: [{ title: "Greet" }] };
phase("Greet");
const greeting = await agent("Greet " + args.who, { label: "greet", resources: [] });
return { said: greeting.summary };
`,
  );
  const help = await run(["help"]);
  assert.match(help.out, /^Workflows:/m);
  for (const name of ["run", "runs", "run-status", "run-stop", "run-wait"])
    assert.match(help.out, new RegExp(`^  ${name} `, "m"), name);
  assert.match((await run(["run", "--help"])).out, /--resume <run>/);
  const started = await run(["run", file, "--args", '{"who":"Ana"}', "--json"]);
  assert.equal(started.code, 0, started.err);
  const row = JSON.parse(started.out);
  assert.equal(row.name, "hello");
  assert.equal(row.owner, "lead");
  const greet = await agent("greet");
  assert.equal(greet.job.prompt, "Greet Ana");
  const listed = await run(["runs"]);
  assert.match(listed.out, /^ID\s+STATUS\s+NAME\s+OWNER/m);
  assert.match(
    listed.out,
    new RegExp(`${row.id.slice(0, 8)}\\s+running\\s+hello\\s+lead`),
  );
  assert.match((await run(["runs", "--status", "completed"])).out, /No runs/);
  const status = await run(["run-status", row.id.slice(0, 8)]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /status: running, owner lead, workspace test-ws/);
  assert.match(status.out, /\n  Greet\n\s+greet\s+running/);
  // --follow prints the changes until the run ends.
  const following = run(["run-status", row.id, "--follow"]);
  finish(greet, { summary: "Hello, Ana" });
  const followed = await following;
  assert.equal(followed.code, 0, followed.err);
  assert.match(followed.out, /greet: completed/);
  assert.match(followed.out, /Run completed;/);
  assert.match(followed.out, /"said": "Hello, Ana"/);
  const events = await run(["events", "--mine"]);
  assert.match(events.out, /run hello \(\w+\) started by lead/);
  assert.match(
    events.out,
    /run hello \(\w+\) starts \S+ \S+ \(\w+\) for greet/,
  );
  assert.match(events.out, /run hello \(\w+\): Phase: Greet/);
  assert.match(events.out, /run hello \(\w+\) completed/);
  const waited = await run(["run-wait", row.id]);
  assert.equal(waited.code, 0);
  assert.match(waited.out, /^Run completed\./);
  // --wait returns when an agent asks (exit 3) like pelican wait.
  const asking = run([
    "run",
    file,
    "--args",
    '{"who":"Bo"}',
    "--wait",
    "--json",
  ]);
  const bo = await agent("greet", 2);
  bo.call("pelican_ask", { question: "Formal?" }, "formal");
  const asked = await asking;
  assert.equal(asked.code, 3, asked.err);
  const outcome = JSON.parse(asked.out);
  assert.equal(outcome.reason, "question");
  assert.equal(outcome.run.questions[0].question, "Formal?");
  const id = outcome.run.id;
  const stopped = await run([
    "run-stop",
    id.slice(0, 8),
    "--reason",
    "Not now",
  ]);
  assert.match(
    stopped.out,
    /^Stopped run hello \(\w+\): Stopped by lead: Not now\nResume it: pelican run --resume/,
  );
  assert.equal((await run(["run-wait", id])).code, 1);
  // Resume: the stopped agent continues; --wait prints the result.
  const resumed = run(["run", "--resume", id, "--wait", "--timeout", "5"]);
  finish(await agent("greet", 3), { summary: "Hi Bo" });
  const back = await resumed;
  assert.equal(back.code, 0, back.err);
  assert.match(back.err, /^Resumed run hello/);
  assert.match(back.out, /"said": "Hi Bo"/);
  // A timeout exits 2; stop --all stops the run.
  const third = JSON.parse(
    (await run(["run", file, "--args", '{"who":"Cy"}', "--json"])).out,
  );
  const timedOut = await run(["run-wait", third.id, "--timeout", "0.05"]);
  assert.equal(timedOut.code, 2);
  assert.match(timedOut.out, /^Still running \(timed out\)/);
  await agent("greet", 4);
  const all = await run(["stop", "--all"]);
  assert.match(all.out, /^Stopped run hello \(\w+\) in test-ws/);
  assert.equal(workers.length, 4);
  // Usage mistakes.
  assert.equal((await run(["run"])).code, 1);
  assert.equal((await run(["run-status"])).code, 1);
  assert.match((await run(["run-status", "nothing"])).err, /No run "nothing"/);
  assert.match(
    (await run(["run", "--resume", id, "--name", "x"])).err,
    /--name names a new run/,
  );
});

// The examples, end to end, with agents that answer by their label.
class Scripted extends FakeWorker {
  constructor(job, respond) {
    super(job);
    this.respond = respond;
  }
  async request(method, params) {
    const reply = await super.request(method, params);
    if (method === "turn/start")
      setImmediate(() => {
        const { result, summary } = this.respond(
          this.job,
          params.input[0].text,
        );
        finish(this, { result, summary });
      });
    return reply;
  }
}

test("examples/owner-reviewer.js carries a reviewer's findings into the next owner round", async (t) => {
  const prompts = new Map();
  const respond = (job, text) => {
    prompts.set(job.name, text);
    const [role, rest] = job.name.split(":");
    const [item, round] = rest.split("#");
    if (role === "own")
      return {
        result: {
          done: true,
          changes: [`${item} round ${round}`],
          checks: "npm test: 3 passed",
          open: [],
        },
      };
    const approved = item === "a" || round === "2";
    return {
      result: {
        approved,
        findings: approved ? [] : ["the new flag has no test"],
        checks: "read the diff",
      },
    };
  };
  const workers = [];
  const { lead } = await setup(t, {
    workerFactory: (job) => {
      const worker = new Scripted(job, respond);
      workers.push(worker);
      return worker;
    },
  });
  const run = await lead.startRun({
    file: join(root, "examples/owner-reviewer.js"),
    args: {
      items: [
        { id: "a", task: "Do A", resources: [] },
        { id: "b", task: "Do B", resources: [] },
      ],
      rounds: 2,
    },
  });
  const { run: done } = await lead.waitRun(run.id, { timeoutMs: 10000 });
  assert.equal(done.status, "completed", done.error);
  const [a, b] = done.result.results;
  assert.deepEqual([a.item, a.outcome, a.round], ["a", "approved", 1]);
  assert.deepEqual([b.item, b.outcome, b.round], ["b", "approved", 2]);
  assert.deepEqual(b.notes, ["reviewer, round 1: the new flag has no test"]);
  assert.match(prompts.get("own:b#2"), /round 2 of 2/);
  assert.match(
    prompts.get("own:b#2"),
    /reviewer, round 1: the new flag has no test/,
  );
  assert.match(prompts.get("review:b#2"), /Earlier findings[\s\S]*no test/);
  // The items run side by side, so their calls interleave in any order.
  assert.deepEqual(
    done.phases.map((p) => [p.title, p.agents.map((x) => x.label).sort()]),
    [
      ["Own", ["own:a#1", "own:b#1", "own:b#2"]],
      ["Review", ["review:a#1", "review:b#1", "review:b#2"]],
    ],
  );
  assert.ok(workers.every((w) => w.job.status === "completed"));
  // The reviewers reserve nothing.
  assert.ok(
    workers
      .filter((w) => w.job.name.startsWith("review:"))
      .every((w) => w.job.resources.length === 0),
  );
});

test("examples/hello.js runs two agents side by side and sums up", async (t) => {
  const respond = (job) =>
    job.name === "layout"
      ? { result: { entries: ["README.md", "src"] } }
      : { summary: `${job.name} says hello` };
  const { lead } = await setup(t, {
    workerFactory: (job) => new Scripted(job, respond),
  });
  const run = await lead.startRun({
    file: join(root, "examples/hello.js"),
    args: { topic: "Pelican" },
  });
  const { run: done } = await lead.waitRun(run.id, { timeoutMs: 10000 });
  assert.equal(done.status, "completed", done.error);
  assert.deepEqual(done.result.entries, ["README.md", "src"]);
  assert.equal(done.result.introduction, "sum-up says hello");
  assert.deepEqual(
    done.phases.map((p) => [p.title, p.agents.map((a) => a.label)]),
    [
      ["Look", ["layout", "purpose"]],
      ["Sum up", ["sum-up"]],
    ],
  );
});

test("the MCP tools start, follow and wait for a run", async (t) => {
  const fx = await setup(t);
  const service = await createServer({
    config: fx.config,
    gateway: fx.gateway,
  });
  t.after(() => service.close());
  const client = new Client({ name: "pelican-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "src/mcp.js"), "--as", "claude-lead"],
      cwd: fx.dir,
      env: {
        ...process.env,
        PELICAN_URL: service.origin,
        PELICAN_TOKEN: fx.config.token,
      },
    }),
  );
  try {
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, response.content[0].text);
      return JSON.parse(response.content[0].text);
    };
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "pelican_runs_start",
      "pelican_runs_list",
      "pelican_runs_get",
      "pelican_runs_stop",
      "pelican_runs_resume",
      "pelican_runs_wait",
    ])
      assert.ok(names.includes(name), name);
    const run = await call("pelican_runs_start", {
      source: `export const meta = { name: "mcp", description: "From Claude Code" };
const r = await agent("Count " + args.items.length + " items", { label: "count", resources: [] });
return { items: args.items, said: r.summary };
`,
      args: { items: ["a", "b"] },
    });
    assert.equal(run.owner, "claude-lead");
    const counter = await fx.agent("count");
    assert.equal(counter.job.prompt, "Count 2 items");
    assert.equal(
      (await call("pelican_runs_list", { status: "running" }))[0].id,
      run.id,
    );
    finish(counter, { summary: "Two" });
    const done = await call("pelican_runs_wait", {
      id: run.id,
      timeoutMs: 5000,
    });
    assert.equal(done.reason, "done");
    assert.deepEqual(done.run.result, { items: ["a", "b"], said: "Two" });
    assert.equal(
      (await call("pelican_runs_get", { id: run.id })).status,
      "completed",
    );
  } finally {
    await client.close();
  }
});

test("a run's agents work in the workspace's folder wherever its caller is, or in the cwd it names", async (t) => {
  const fx = await setup(t);
  const sub = join(fx.dir, "scripts");
  await mkdir(sub);
  const file = await fx.script(
    "scripts/one.js",
    `export const meta = { name: "one", description: "one agent" };
return await agent("Do it", { label: "one", resources: [] });`,
  );
  const fromSub = fx.as("lead", { cwd: sub });
  const atRoot = await fromSub.startRun({ file });
  assert.equal(atRoot.cwd, fx.dir);
  const first = await fx.agent("one");
  assert.equal(first.job.cwd, await realpath(fx.dir));
  finish(first);
  assert.equal(
    (await fx.lead.waitRun(atRoot.id, { timeoutMs: 5000 })).run.status,
    "completed",
  );
  const named = await fromSub.startRun({ file, cwd: "." });
  assert.equal(named.cwd, sub);
  const second = await fx.agent("one", 2);
  assert.equal(second.job.cwd, await realpath(sub));
  finish(second);
  await fx.lead.waitRun(named.id, { timeoutMs: 5000 });
  await assert.rejects(
    fromSub.startRun({ file, cwd: join(fx.dir, "missing") }),
    /is not an existing directory/,
  );
  await assert.rejects(
    fromSub.startRun({ file, cwd: tmpdir() }),
    /inside the workspace's folder|workspace/,
  );
});
