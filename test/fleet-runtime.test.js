import test from "node:test";
import assert from "node:assert/strict";
import { Fleet, toolsVersion } from "../src/fleet.js";
import { networkKey } from "../src/worker-permissions.js";
import { FakeWorker, harness, until } from "./helpers.js";

const running = (job) => until(() => job.status === "running");

test("agents start in Codex auto mode with only Pelican's four tools", async (t) => {
  const { o, spec, workers } = await harness(t);
  const job = await o.create(spec("Auto"), "lead");
  await running(job);
  const start = workers[0].last("thread/start");
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.approvalPolicy, "on-request");
  assert.equal(start.params.approvalsReviewer, "auto_review");
  assert.deepEqual(start.params.dynamicTools.map((tool) => tool.name).sort(), [
    "pelican_ask",
    "pelican_inbox",
    "pelican_message",
    "pelican_report",
  ]);
  assert.match(start.params.developerInstructions, /lead is the orchestrator/);
  assert.match(start.params.developerInstructions, /no human to ask/);
  assert.equal(start.params.model, "gpt-6.1-sol");
  const turn = workers[0].last("turn/start");
  assert.equal(turn.params.effort, "high");
  assert.equal(turn.params.approvalPolicy, "on-request");
  assert.equal(turn.params.approvalsReviewer, "auto_review");
  assert.match(
    turn.params.input[0].text,
    /^Assignment from lead:\nComplete Auto/,
  );
  assert.equal(job.permissions.approvalsReviewer, "auto_review");
  assert.equal(job.toolsVersion, toolsVersion);
});

test("the workspace's network switch reaches each agent's thread and turn", async (t) => {
  const { o, spec, workers } = await harness(t);
  // Off by default: Codex's per-command review applies.
  const off = await o.create(spec("Offline"), "lead");
  await running(off);
  assert.equal(
    workers[0].last("thread/start").params.config[networkKey],
    false,
  );
  assert.equal(
    workers[0].last("turn/start").params.sandboxPolicy.networkAccess,
    false,
  );
  assert.equal(off.network, false);
  assert.match(
    workers[0].last("thread/start").params.developerInstructions,
    /need network access.*reviewed automatically/,
  );
  workers[0].complete();
  await until(() => off.status === "completed");
  // On: the thread config and every turn's sandbox carry it.
  o.updateSettings({ network: true }, "lead");
  const on = await o.create(spec("Online"), "lead");
  await running(on);
  const thread = workers[1].last("thread/start");
  assert.equal(thread.params.config[networkKey], true);
  assert.match(thread.params.developerInstructions, /Network access is on/);
  const turn = workers[1].last("turn/start");
  assert.deepEqual(turn.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: true,
  });
  assert.equal(on.permissions.networkAccess, true);
  // A resumed agent takes the switch as it is now.
  o.resume(off.id, { prompt: "Fetch it now" }, "lead");
  await running(off);
  const resumed = workers[2].last("thread/resume");
  assert.equal(resumed.params.config[networkKey], true);
  assert.equal(
    workers[2].last("turn/start").params.sandboxPolicy.networkAccess,
    true,
  );
  workers[1].complete();
  workers[2].complete();
  await until(() => !o.active.size);
  o.updateSettings({ network: false }, "lead");
  o.resume(on.id, {}, "lead");
  await running(on);
  assert.equal(
    workers[3].last("thread/resume").params.config[networkKey],
    false,
  );
  assert.equal(
    workers[3].last("turn/start").params.sandboxPolicy.networkAccess,
    false,
  );
});

test("a thread that did not start in auto mode gets no turn", async (t) => {
  const { o, spec } = await harness(t, {
    workerFactory: (job) => {
      const worker = new FakeWorker(job);
      const request = worker.request.bind(worker);
      worker.request = async (method, params) =>
        method === "thread/start"
          ? {
              ...(await request(method, params)),
              sandbox: { type: "readOnly" },
            }
          : request(method, params);
      return worker;
    },
  });
  const job = await o.create(spec("Refused"), "lead");
  await until(() => job.status === "failed");
  assert.match(job.error, /did not start in auto mode/);
});

test("questions and approvals wait for the agent's owner", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Ask"));
  const agent = o.get(job.id);
  await running(agent);
  const worker = workers[0];
  worker.call("pelican_ask", { question: "Which database?" }, "ask-1");
  assert.equal(agent.status, "waiting");
  const [question] = await lead.questions();
  assert.equal(question.owner, "lead");
  assert.equal(question.kind, "question");
  assert.equal(question.question, "Which database?");
  // Another orchestrator sees it but cannot answer without taking over.
  await assert.rejects(
    as("reviewer").answer(job.id, question.requestId, "Postgres"),
    /belongs to lead/,
  );
  await lead.answer(job.id, question.requestId.slice(0, 8), "SQLite");
  assert.deepEqual(
    JSON.parse(worker.answer("ask-1").result.contentItems[0].text),
    { answer: "SQLite", from: "lead" },
  );
  assert.equal(agent.status, "running");
  // The rare approval that Codex's auto-reviewer passes on.
  worker.emit("request", {
    id: "approve-1",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "curl https://example.com",
      availableDecisions: ["accept", "decline"],
    },
  });
  const [approval] = await lead.questions();
  assert.equal(approval.kind, "approval");
  assert.deepEqual(approval.decisions, ["accept", "decline"]);
  assert.match(approval.question, /Permission to run a command/);
  await assert.rejects(
    lead.answer(job.id, approval.requestId, "acceptForSession"),
    /not offered/,
  );
  await lead.answer(job.id, approval.requestId, "accept");
  assert.deepEqual(worker.answer("approve-1").result, { decision: "accept" });
  // Nobody fills in an MCP server's form.
  worker.emit("request", {
    id: "form-1",
    method: "mcpServer/elicitation/request",
    params: {},
  });
  await until(() => worker.answer("form-1"));
  assert.deepEqual(worker.answer("form-1").result, { action: "decline" });
  // Tools from earlier Pelicans are gone.
  for (const tool of ["pelican_board", "pelican_artifact", "pelican_cafe"]) {
    const id = worker.call(tool, {});
    await until(() => worker.answer(id));
    assert.equal(worker.answer(id).result.success, false);
  }
});

test("agents send notes, read their inbox and hand over a report", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Notes"));
  const agent = o.get(job.id);
  await running(agent);
  const worker = workers[0];
  worker.call("pelican_message", { message: "Halfway there" }, "n");
  assert.deepEqual(JSON.parse(worker.answer("n").result.contentItems[0].text), {
    delivered: true,
    to: "lead",
  });
  assert.equal(agent.notes[0].text, "Halfway there");
  await lead.message(job.id, "Use port 4000");
  assert.match(
    worker.last("turn/steer").params.input[0].text,
    /from lead:\nUse port 4000/,
  );
  worker.call("pelican_inbox", {}, "i");
  await until(() => worker.answer("i"));
  assert.match(worker.answer("i").result.contentItems[0].text, /port 4000/);
  worker.call("pelican_report", { report: "" }, "empty");
  assert.equal(worker.answer("empty").result.success, false);
  worker.call(
    "pelican_report",
    { report: "Changed two files; npm test passed." },
    "r",
  );
  assert.equal(
    JSON.parse(worker.answer("r").result.contentItems[0].text).accepted,
    true,
  );
  worker.say("Done.");
  worker.complete();
  const { reason, agents } = await lead.wait([job.id], { timeoutMs: 5000 });
  assert.equal(reason, "done");
  assert.equal(agents[0].status, "completed");
  assert.equal(agents[0].report, "Changed two files; npm test passed.");
  assert.equal(agents[0].summary, "Done.");
  assert.equal(agents[0].result, null);
});

test("reserved paths, dependencies and blocked dependents", async (t) => {
  const { o, spec, workers, dir } = await harness(t);
  const [first, second, overlap] = await o.createBatch(
    [
      spec("First", { key: "first", resources: [dir] }),
      spec("Second", { dependsOn: ["first"] }),
      spec("Overlap", { resources: [dir] }),
    ],
    "lead",
  );
  await running(first);
  assert.equal(second.status, "queued");
  assert.equal(overlap.status, "queued");
  workers[0].complete();
  await until(
    () => second.status === "running" && overlap.status === "running",
  );
  const failing = await o.create(spec("Fails"), "lead");
  const dependent = await o.create(
    spec("Needs it", { dependsOn: [failing.id] }),
    "lead",
  );
  await running(failing);
  workers.at(-1).complete("failed");
  await until(() => dependent.status === "blocked");
});

test("a restart interrupts agents; an old conversation starts fresh", async (t) => {
  const { o, store, config, spec } = await harness(t);
  const job = await o.create(spec("Interrupted"), "lead");
  await running(job);
  job.goalState = { state: "running" };
  job.threadId = "old-thread";
  job.toolsVersion = 2;
  store.save(job);
  const workers = [];
  const again = new Fleet({
    store,
    config,
    workerFactory: (j) => {
      const worker = new FakeWorker(j);
      workers.push(worker);
      return worker;
    },
  });
  const recovered = again.get(job.id);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.goalState, undefined);
  assert.ok(
    store.events({ jobId: job.id }).some((e) => e.type === "job.recovered"),
  );
  again.resume(job.id, { prompt: "Pick it back up" }, "lead");
  await until(() => recovered.status === "running");
  assert.ok(workers[0].requests.some((r) => r.method === "thread/start"));
  assert.notEqual(recovered.threadId, "old-thread");
  assert.match(
    workers[0].last("turn/start").params.input[0].text,
    /starts fresh[\s\S]*Assignment from lead:\nPick it back up/,
  );
  await again.shutdown();
});

// A worker whose start fails as a Codex start-up crash does.
const crashing = (job) => {
  const worker = new FakeWorker(job);
  worker.start = async () => {
    throw new Error(
      "Codex exited (1): Error: failed to initialize sqlite state runtime under C:/home",
    );
  };
  return worker;
};

test("Codex processes of a workspace start one at a time, each until its thread is open", async (t) => {
  const made = [];
  const { o, spec } = await harness(t, {
    workerFactory: (job) => {
      const worker = new FakeWorker(job);
      let open;
      const opened = new Promise((resolve) => (open = resolve));
      Object.assign(worker, { open, started: false });
      worker.start = async () => {
        worker.started = true;
        return worker;
      };
      const request = worker.request.bind(worker);
      worker.request = async (method, params) => {
        if (method === "thread/start") await opened;
        return request(method, params);
      };
      made.push(worker);
      return worker;
    },
  });
  const first = await o.create(spec("First"), "lead");
  const second = await o.create(spec("Second"), "lead");
  await until(() => made.length === 2 && made[0].started);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(made[1].started, false);
  made[0].open();
  await running(first);
  await until(() => made[1].started);
  made[1].open();
  await running(second);
});

test("an agent whose Codex crashes while starting starts once more", async (t) => {
  const made = [];
  const { o, spec, store } = await harness(t, {
    workerFactory: (job) => {
      const worker = made.length === 0 ? crashing(job) : new FakeWorker(job);
      made.push(worker);
      return worker;
    },
  });
  const job = await o.create(spec("Crash once"), "lead");
  await running(job);
  assert.equal(made.length, 2);
  assert.equal(job.attempts, 2);
  const restarts = store.events({ types: ["job.restarting"] });
  assert.equal(restarts.length, 1);
  assert.match(
    restarts[0].data.reason,
    /failed to initialize sqlite state runtime/,
  );
  made[1].complete();
  await until(() => job.status === "completed");
  assert.equal(store.events({ types: ["job.finished"] }).length, 1);
});

test("a second start-up crash in a row fails the agent with Codex's cause", async (t) => {
  const { o, spec, store } = await harness(t, { workerFactory: crashing });
  const job = await o.create(spec("Crash twice"), "lead");
  await until(() => job.status === "failed");
  assert.equal(job.attempts, 2);
  assert.match(
    job.error,
    /^Codex exited \(1\): Error: failed to initialize sqlite state runtime/,
  );
  assert.equal(store.events({ types: ["job.restarting"] }).length, 1);
});

// The model service failing a turn for capacity, as Codex reports it.
const overloaded = (worker) =>
  worker.emit("notification", {
    method: "turn/completed",
    params: {
      turn: {
        id: worker.turnId,
        status: "failed",
        error: {
          message:
            "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: "serverOverloaded",
        },
      },
    },
  });

test("a turn the model service fails for capacity continues the same conversation after a pause", async (t) => {
  const { o, spec, store, config, workers } = await harness(t);
  config.overloadRetryBaseMs = 20;
  const job = await o.create(spec("Busy model"), "lead");
  await running(job);
  const thread = job.threadId;
  overloaded(workers[0]);
  await until(() => job.status === "queued");
  const [event] = store.events({ types: ["job.overloaded"] });
  assert.equal(event.data.attempt, 1);
  assert.equal(event.data.of, 6);
  assert.match(event.data.reason, /at capacity/);
  await until(() => workers.length === 2 && job.status === "running");
  assert.equal(workers[1].last("thread/resume").params.threadId, thread);
  assert.match(
    workers[1].last("turn/start").params.input[0].text,
    /^Pelican:\nThe model service refused your turn \(serverOverloaded/,
  );
  workers[1].complete();
  await until(() => job.status === "completed");
  assert.equal(job.overloadRetries, 0);
  assert.equal(store.events({ types: ["job.finished"] }).length, 1);
});

test("capacity failures stop after six tries and fail the agent with the cause", async (t) => {
  const { o, spec, store, config, workers } = await harness(t);
  config.overloadRetryBaseMs = 1;
  const job = await o.create(spec("Always busy"), "lead");
  for (let n = 1; n <= 7; n += 1) {
    await until(() => workers.length === n && job.status === "running");
    overloaded(workers[n - 1]);
  }
  await until(() => job.status === "failed");
  assert.match(job.error, /at capacity/);
  assert.equal(store.events({ types: ["job.overloaded"] }).length, 6);
});

// The model stream refused with 429 Too Many Requests, as Codex reports it.
const rateLimit = (worker, willRetry) =>
  worker.emit("notification", {
    method: willRetry ? "error" : "turn/completed",
    params: willRetry
      ? {
          error: {
            message: "Reconnecting... 2/5",
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 429 },
            },
          },
          willRetry: true,
        }
      : {
          turn: {
            id: worker.turnId,
            status: "failed",
            error: {
              message:
                "exceeded retry limit, last status: 429 Too Many Requests",
              codexErrorInfo: {
                responseStreamDisconnected: { httpStatusCode: 429 },
              },
            },
          },
        },
  });

test("a model stream refused with 429 is journaled while Codex retries, and a turn it ends continues after a pause", async (t) => {
  const { o, spec, store, config, workers } = await harness(t);
  config.overloadRetryBaseMs = 20;
  const job = await o.create(spec("Rate limited"), "lead");
  await running(job);
  rateLimit(workers[0], true);
  await until(() => store.events({ types: ["job.throttled"] }).length === 1);
  const [throttled] = store.events({ types: ["job.throttled"] });
  assert.equal(throttled.data.httpStatus, 429);
  assert.equal(throttled.data.owner, "lead");
  assert.equal(job.status, "running");
  rateLimit(workers[0], false);
  await until(() => job.status === "queued");
  const [paused] = store.events({ types: ["job.overloaded"] });
  assert.match(paused.data.reason, /429/);
  await until(() => workers.length === 2 && job.status === "running");
  assert.match(
    workers[1].last("turn/start").params.input[0].text,
    /^Pelican:\nThe model service refused your turn \(HTTP 429/,
  );
  workers[1].complete();
  await until(() => job.status === "completed");
});
