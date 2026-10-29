import test from "node:test";
import assert from "node:assert/strict";
import { harness, until } from "./helpers.js";

const running = (o, id) => until(() => o.get(id).status === "running");

test("every orchestrator sees every agent; directing another's needs takeover", async (t) => {
  const { o, spec, workers, as, store } = await harness(t);
  const lead = as("lead"),
    reviewer = as("reviewer");
  await assert.rejects(as(undefined).spawn(spec("Anonymous")), /Name yourself/);
  await assert.rejects(
    as("pelican").spawn(spec("Impostor")),
    /Pelican's own name/,
  );
  await assert.rejects(as("-bad").spawn(spec("Bad name")), /caller name/);
  const mine = await lead.spawn(spec("Lead's"));
  const theirs = await reviewer.spawn(spec("Reviewer's"));
  await running(o, mine.id);
  await running(o, theirs.id);
  assert.equal((await reviewer.list()).length, 2);
  assert.deepEqual(
    (await reviewer.list({ owner: "lead" })).map((r) => r.id),
    [mine.id],
  );
  assert.equal((await reviewer.get(mine.id)).owner, "lead");
  await assert.rejects(reviewer.message(mine.id, "Hello"), /belongs to lead/);
  await assert.rejects(reviewer.resume(mine.id), /belongs to lead/);
  // Takeover moves the agent, and its questions, to the new owner.
  workers[0].call("pelican_ask", { question: "Merge now?" }, "ask");
  const sent = await reviewer.message(mine.id, "I take this one", {
    takeover: true,
  });
  assert.equal(sent.agent.owner, "reviewer");
  assert.equal((await lead.questions())[0].owner, "reviewer");
  assert.ok(
    store
      .events({ jobId: mine.id })
      .some(
        (e) =>
          e.type === "job.owner" &&
          e.data.from === "lead" &&
          e.data.to === "reviewer",
      ),
  );
  assert.match(o.instructions(o.get(mine.id)), /reviewer is the orchestrator/);
  // Anyone may stop any agent; the journal says who.
  const stopped = await lead.stop(theirs.id, { reason: "Not needed" });
  assert.equal(stopped.stopped[0].status, "interrupted");
  assert.equal(
    store
      .events({ jobId: theirs.id })
      .find((e) => e.type === "job.stopRequested").data.by,
    "lead",
  );
});

test("messages steer a running turn, follow it, join a queued brief or resume a finished agent", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Talk"));
  await running(o, job.id);
  const steered = await lead.message(job.id, "Prefer small commits");
  assert.equal(steered.delivery, "steered");
  const followup = await lead.message(job.id, "Then update the README", {
    mode: "followup",
  });
  assert.equal(followup.delivery, "followup");
  workers[0].complete();
  // The followup is the next assignment, in the same conversation.
  await until(() => workers.length === 2 && o.get(job.id).status === "running");
  assert.match(
    workers[1].last("turn/start").params.input[0].text,
    /^Assignment from lead:\nThen update the README/,
  );
  workers[1].complete();
  await until(() => o.get(job.id).status === "completed");
  const resumed = await lead.message(job.id, "One more thing");
  assert.equal(resumed.delivery, "resumed");
  await until(() => workers.length === 3);
  workers[2].complete();
  await until(() => o.get(job.id).status === "completed");
  o.updateSettings({ paused: true });
  const queued = await lead.spawn(spec("Queued"));
  assert.equal(
    (await lead.message(queued.id, "Mind the cache")).delivery,
    "queued",
  );
  o.updateSettings({ paused: false });
  await until(() => workers.length === 4);
  assert.match(
    workers[3].last("turn/start").params.input[0].text,
    /Complete Queued\n\nUpdate from lead:\nMind the cache/,
  );
  const detail = await lead.get(job.id);
  assert.deepEqual(
    detail.messages.map((m) => [m.mode, m.delivered]),
    [
      ["steer", true],
      ["followup", true],
      ["steer", true],
    ],
  );
});

test("wait returns when all are done, any is done, a question comes in, or time runs out", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  const [a, b] = await lead.batch([spec("A"), spec("B")]);
  await running(o, a.id);
  await running(o, b.id);
  const slow = await lead.wait([a.id, b.id], { timeoutMs: 50 });
  assert.equal(slow.reason, "timeout");
  assert.ok(slow.agents.every((x) => !x.done));
  const all = lead.wait([a.id, b.id], { timeoutMs: 5000 });
  const any = lead.wait([a.id, b.id], { any: true, timeoutMs: 5000 });
  workers[0].complete();
  assert.equal((await any).reason, "done");
  workers[1].call("pelican_ask", { question: "Keep going?" }, "q");
  const asked = await all;
  assert.equal(asked.reason, "question");
  assert.equal(asked.agents[1].questions[0].question, "Keep going?");
  await lead.answer(b.id, asked.agents[1].questions[0].requestId, "Yes");
  workers[1].complete();
  const done = await lead.wait([a.id, b.id, a.id], { timeoutMs: 5000 });
  assert.equal(done.reason, "done");
  assert.deepEqual(
    done.agents.map((x) => x.status),
    ["completed", "completed"],
  );
  await assert.rejects(lead.wait(["nobody"]), /No agent/);
});

test("stop all stops one owner's agents or everyone's, queued first", async (t) => {
  const { o, spec, as } = await harness(t);
  o.updateSettings({ concurrency: 1 });
  const lead = as("lead");
  const first = await lead.spawn(spec("First"));
  const second = await lead.spawn(spec("Second"));
  const other = await as("reviewer").spawn(spec("Other"));
  await running(o, first.id);
  await assert.rejects(lead.stop(), /Name an agent/);
  const mine = await lead.stop({
    all: true,
    owner: "lead",
    reason: "Change of plan",
  });
  assert.deepEqual(
    mine.stopped.map((r) => r.id).sort(),
    [first.id, second.id].sort(),
  );
  assert.equal(o.get(second.id).status, "cancelled");
  assert.equal(o.get(first.id).status, "interrupted");
  await running(o, other.id);
  const everyone = await lead.stop({ all: true });
  assert.deepEqual(
    everyone.stopped.map((r) => r.id),
    [other.id],
  );
  assert.equal(o.active.size, 0);
});

test("the event feed and an agent's tail read as the orchestrator needs them", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Journal", { name: "Journal task" }));
  await running(o, job.id);
  const worker = workers[0];
  worker.emit("notification", {
    method: "item/started",
    params: {
      item: { id: "c1", type: "commandExecution", command: "npm test" },
    },
  });
  worker.emit("notification", {
    method: "item/commandExecution/outputDelta",
    params: { itemId: "c1", delta: "ok 1\n" },
  });
  worker.emit("notification", {
    method: "item/completed",
    params: {
      item: {
        id: "c1",
        type: "commandExecution",
        command: "npm test",
        exitCode: 0,
        durationMs: 1500,
      },
    },
  });
  worker.emit("notification", {
    method: "item/completed",
    params: {
      item: { id: "f1", type: "fileChange", changes: [{ path: "src/a.js" }] },
    },
  });
  worker.call("pelican_message", { message: "Tests pass" });
  worker.call("pelican_report", { report: "Fixed a.js" });
  worker.say("Done.");
  worker.complete();
  await until(() => o.get(job.id).status === "completed");
  const page = await lead.tail(job.id);
  assert.deepEqual(
    page.lines.map((l) => l.text),
    [
      "Assignment from lead: Complete Journal",
      "Started (gpt-6.1-sol, high, network off)",
      "$ npm test",
      "  exit 0, 1.5s",
      "Edited src/a.js",
      "Note to lead: Tests pass",
      "Report: Fixed a.js",
      "Agent: Done.",
      "Finished: completed",
    ],
  );
  assert.ok(page.done);
  assert.deepEqual((await lead.tail(job.id, { after: page.cursor })).lines, []);
  assert.equal(
    (await lead.tail(job.id, { last: 2 })).lines.at(-1).text,
    "Finished: completed",
  );
  // The workspace feed leaves out the protocol noise unless raw.
  const feed = await lead.events();
  const types = feed.events.map((e) => e.type);
  assert.ok(types.includes("job.created") && types.includes("job.finished"));
  assert.ok(types.includes("agent.message") && types.includes("agent.report"));
  assert.ok(!types.some((type) => type.startsWith("item/")));
  assert.ok(
    (await lead.events({ raw: true })).events.some((e) =>
      e.type.startsWith("item/"),
    ),
  );
  assert.equal((await lead.events({ last: 1 })).events[0].type, "job.finished");
  assert.deepEqual((await lead.events({ owner: "nobody" })).events, []);
  // Following waits for the next entry.
  const next = lead.events({ after: feed.cursor, timeoutMs: 5000 });
  await lead.message(job.id, "Also add a test");
  const followed = await next;
  assert.ok(followed.events.length);
  assert.ok(followed.cursor > feed.cursor);
});

test("list filters by status group and settings changes are recorded", async (t) => {
  const { o, spec, workers, as, store } = await harness(t);
  const lead = as("lead");
  const done = await lead.spawn(spec("Done"));
  await running(o, done.id);
  workers[0].complete();
  await until(() => o.get(done.id).status === "completed");
  await lead.settings({ paused: true });
  const waiting = await lead.spawn(spec("Waits"));
  assert.deepEqual(
    (await lead.list({ status: ["done"] })).map((r) => r.id),
    [done.id],
  );
  assert.deepEqual(
    (await lead.list({ status: ["live"] })).map((r) => r.id),
    [waiting.id],
  );
  assert.deepEqual(
    (await lead.list({ status: ["queued,completed"] })).length,
    2,
  );
  await assert.rejects(lead.list({ status: ["sleeping"] }), /Unknown status/);
  assert.equal((await lead.list({ limit: 1 }))[0].id, waiting.id);
  const changed = store.events({ types: ["settings.updated"] }).at(-1);
  assert.deepEqual(changed.data.changes, { paused: true });
  assert.equal(changed.data.by, "lead");
  const status = await lead.status();
  assert.equal(status.workspaces[0].settings.paused, true);
  assert.equal(status.totals.queued, 1);
});
