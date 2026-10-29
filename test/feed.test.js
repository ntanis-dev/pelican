import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { parseCursor, formatCursor } from "../src/timeline.js";
import { harness, until } from "./helpers.js";

// Orchestrator timelines: note journals what an orchestrator says, feed
// reads what it said and did and what its agents sent it.
const running = (o, id) => until(() => o.get(id).status === "running");
const texts = (page) => page.entries.map((e) => `${e.kind} ${e.by}: ${e.text}`);

test("an orchestrator's timeline holds its notes, its actions and what its agents sent it", async (t) => {
  const { o, as, spec, workers } = await harness(t);
  const lead = as("lead"),
    reviewer = as("reviewer");
  await assert.rejects(as(undefined).note("Who am I?"), /Name yourself/);
  const noted = await lead.note(
    "Two fixers on the login flake, then a reviewer.",
  );
  assert.equal(noted.workspace, "test-ws");
  assert.equal(noted.by, "lead");
  const job = await lead.spawn(
    spec("Fix", {
      name: "Fix the login test",
      prompt:
        "Find the flake.\nRun npm test three times.\nReport the cause.\nExtra line.",
    }),
  );
  await running(o, job.id);
  await lead.message(job.id, "Use port 4319");
  workers[0].call("pelican_message", {
    message: "The flake is a shared port.",
  });
  workers[0].call("pelican_ask", { question: "Which build?" }, "ask-1");
  await until(() => o.get(job.id).pending.length === 1);
  const [question] = await lead.questions();
  await lead.answer(job.id, question.requestId, "Release");
  await lead.settings({ concurrency: 7 });
  // Someone else's actions stay out of lead's timeline.
  await reviewer.note("Reviewing the parser.");
  const theirs = await reviewer.spawn(
    spec("Review", { name: "Review the parser" }),
  );
  await running(o, theirs.id);
  workers[0].call("pelican_report", { report: "Fixed the shared port." });
  workers[0].complete();
  await until(() => o.get(job.id).status === "completed");
  await lead.stop(theirs.id, { reason: "Not needed now" });
  const page = await lead.feed();
  assert.equal(page.as, "lead");
  const name = job.agentName;
  assert.deepEqual(texts(page), [
    "note lead: Two fixers on the login flake, then a reviewer.",
    `action lead: spawned ${name} (Fix the login test): Find the flake.\nRun npm test three times.\nReport the cause.`,
    `action lead: messaged ${name} (steer, steered): Use port 4319`,
    `agent lead: ${name}: The flake is a shared port.`,
    `agent lead: ${name} asks: Which build?`,
    `action lead: answered ${name} (Which build?): Release`,
    "action lead: changed the settings of test-ws: concurrency 7",
    `agent lead: ${name} reported: Fixed the shared port.`,
    `agent lead: ${name} completed`,
    `action lead: stopped ${theirs.agentName}: Not needed now`,
  ]);
  assert.ok(
    page.entries.every((e) => e.workspace === "test-ws" && e.at && e.seq),
  );
  assert.equal(page.entries[1].jobId, job.id);
  // Another orchestrator's timeline, by name; everyone's with all.
  assert.deepEqual(texts(await lead.feed({ as: "reviewer" })).slice(0, 2), [
    "note reviewer: Reviewing the parser.",
    `action reviewer: spawned ${theirs.agentName} (Review the parser): Complete Review`,
  ]);
  const everyone = await lead.feed({ all: true });
  assert.equal(everyone.as, null);
  assert.ok(everyone.entries.length > page.entries.length);
  assert.deepEqual(
    new Set(everyone.entries.map((e) => e.by)),
    new Set(["lead", "reviewer"]),
  );
  // Paging: the newest few, then what comes after the cursor.
  const recent = await lead.feed({ last: 2 });
  assert.deepEqual(texts(recent), texts(page).slice(-2));
  assert.deepEqual((await lead.feed({ after: recent.cursor })).entries, []);
  const waiting = lead.feed({ after: recent.cursor, timeoutMs: 5000 });
  await reviewer.note("Not for lead.");
  await lead.note("Done for today.");
  assert.deepEqual(texts(await waiting), ["note lead: Done for today."]);
  const limited = await lead.feed({ limit: 3 });
  assert.equal(limited.entries.length, 3);
  assert.deepEqual(
    texts(await lead.feed({ after: limited.cursor, limit: 2 })),
    texts(page).slice(3, 5),
  );
});

test("a takeover shows in both timelines, and the cursor spans workspaces", async (t) => {
  const { o, as, spec, hub } = await harness(t);
  const lead = as("lead"),
    reviewer = as("reviewer");
  const job = await lead.spawn(spec("Talk"));
  await running(o, job.id);
  await reviewer.message(job.id, "Mine now", { takeover: true });
  const took = `action reviewer: ${"reviewer"} took over ${job.agentName} from lead`;
  assert.ok(texts(await lead.feed()).includes(took));
  assert.ok(texts(await reviewer.feed()).includes(took));
  // A second workspace: notes there join the same timeline, by time.
  const folder = await mkdtemp(join(tmpdir(), "pelican-other-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const other = await hub.add({ folder, name: "Other" });
  try {
    const before = await lead.feed();
    await lead.note("Over in the other workspace.", { workspace: other.id });
    await lead.note("Back here.", { workspace: "test-ws" });
    const after = await lead.feed({ after: before.cursor });
    assert.deepEqual(
      after.entries.map((e) => [e.workspace, e.text]),
      [
        [other.id, "Over in the other workspace."],
        ["test-ws", "Back here."],
      ],
    );
    const cursor = parseCursor(after.cursor);
    assert.deepEqual(Object.keys(cursor).sort(), [other.id, "test-ws"].sort());
    assert.equal(formatCursor(cursor), after.cursor);
    assert.deepEqual(
      (await lead.feed({ workspace: other.id })).entries.map((e) => e.text),
      ["Over in the other workspace."],
    );
    // With several workspaces, a note needs to know which one.
    await assert.rejects(lead.note("Where?"), /Choose a workspace/);
  } finally {
    await hub.remove(other.id);
  }
});

test("tail --full is the agent's whole conversation: kinds, senders, outputs, diffs and reasoning", async (t) => {
  const { o, as, spec, workers } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Chat", { prompt: "Fix the flake." }));
  await running(o, job.id);
  const worker = workers[0];
  const item = (type, extra) => ({ item: { id: `${type}-1`, type, ...extra } });
  worker.emit("notification", {
    method: "item/completed",
    params: item("reasoning", {
      summary: ["Look at the port first."],
      content: [],
    }),
  });
  worker.emit("notification", {
    method: "item/started",
    params: item("commandExecution", { command: "npm test" }),
  });
  worker.emit("notification", {
    method: "item/completed",
    params: item("commandExecution", {
      command: "npm test",
      exitCode: 1,
      durationMs: 2000,
      aggregatedOutput: "not ok 1 login\n",
    }),
  });
  worker.emit("notification", {
    method: "item/completed",
    params: item("fileChange", {
      changes: [{ path: "src/a.js", kind: { type: "update" }, diff: "-a\n+b" }],
    }),
  });
  worker.say("Fixed it.");
  await lead.message(job.id, "Thanks");
  const plain = await lead.tail(job.id);
  assert.equal(plain.lines.length, 7);
  assert.ok(plain.lines.every((l) => !("kind" in l)));
  assert.ok(!plain.lines.some((l) => l.text.startsWith("Thinking")));
  const full = await lead.tail(job.id, { full: true });
  assert.deepEqual(
    full.lines.map((l) => [
      l.kind,
      l.from ?? l.to ?? null,
      l.text.split("\n")[0],
    ]),
    [
      ["brief", "lead", "Assignment from lead: Fix the flake."],
      ["status", null, "Started (gpt-6.1-sol, high, network off)"],
      ["reasoning", null, "Thinking: Look at the port first."],
      ["command", null, "$ npm test"],
      ["command", null, "  exit 1, 2.0s"],
      ["edit", null, "Edited src/a.js"],
      ["agent", null, "Agent: Fixed it."],
      ["message", "lead", "Message from lead (steer, steered): Thanks"],
    ],
  );
  const byKind = (kind) => full.lines.filter((l) => l.kind === kind);
  assert.equal(byKind("brief")[0].detail, "Fix the flake.");
  assert.equal(byKind("command")[1].detail, "not ok 1 login\n");
  assert.equal(byKind("command")[1].item, byKind("command")[0].item);
  assert.equal(byKind("command")[1].exitCode, 1);
  assert.equal(byKind("edit")[0].detail, "update src/a.js\n-a\n+b");
  assert.equal(byKind("reasoning")[0].detail, "Look at the port first.");
});

test("pelican note and pelican feed from the command line", async (t) => {
  const { gateway, dir } = await harness(t);
  const run = async (argv) => {
    const out = [];
    const code = await main(argv, {
      print: (text) => out.push(text),
      error: (text) => out.push(text),
      client: gateway.as("lead", { cwd: dir }),
    });
    return { code, out: out.join("\n") };
  };
  assert.match(
    (await run(["note", "Starting", "the", "sweep"])).out,
    /^Noted in test-ws as lead \(#\d+\)\.$/,
  );
  assert.equal((await run(["note"])).code, 1);
  const feed = await run(["feed"]);
  assert.equal(feed.code, 0);
  assert.match(
    feed.out,
    /^\d\d:\d\d:\d\d test-ws lead note: Starting the sweep$/,
  );
  assert.match(
    (await run(["feed", "nobody"])).out,
    /Nothing in this timeline yet\./,
  );
  const json = JSON.parse((await run(["feed", "--all", "--json"])).out);
  assert.equal(json.entries[0].text, "Starting the sweep");
  assert.match(json.cursor, /^test-ws:\d+$/);
  // tail --full gives the conversation's kinds and full texts.
  const job = JSON.parse(
    (await run(["spawn", "--prompt", "Look around", "--read-only", "--json"]))
      .out,
  );
  const full = JSON.parse(
    (await run(["tail", job.id, "--full", "--json"])).out,
  );
  assert.deepEqual(
    [full.lines[0].kind, full.lines[0].from, full.lines[0].detail],
    ["brief", "lead", "Look around"],
  );
  assert.match(
    (await run(["feed"])).out,
    /lead did: spawned \S+ \S+ \(Look around\): Look around$/m,
  );
});
