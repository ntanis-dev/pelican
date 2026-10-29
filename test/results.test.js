import test from "node:test";
import assert from "node:assert/strict";
import { checkResult, compileResultSchema } from "../src/result-schema.js";
import { harness, until } from "./helpers.js";

const schema = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    files: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["passed", "files"],
  additionalProperties: false,
};
const report = (worker, result, id = `r-${Math.random()}`) => {
  worker.call(
    "pelican_report",
    { report: "Ran the tests.", ...(result === undefined ? {} : { result }) },
    id,
  );
  return worker.answer(id);
};

test("result schemas compile once and explain what to fix", () => {
  assert.equal(compileResultSchema(undefined), null);
  assert.throws(() => compileResultSchema([]), /JSON Schema object/);
  assert.throws(
    () => compileResultSchema({ type: "wat" }),
    /not a usable JSON Schema/,
  );
  assert.equal(compileResultSchema(schema), compileResultSchema(schema));
  const good = checkResult(
    schema,
    JSON.stringify({ passed: true, files: ["a.js"] }),
  );
  assert.deepEqual(good, {
    ok: true,
    value: { passed: true, files: ["a.js"] },
    error: null,
  });
  assert.deepEqual(checkResult(schema, { passed: false, files: ["b"] }).value, {
    passed: false,
    files: ["b"],
  });
  const wrong = checkResult(schema, '{"passed":"yes","files":[],"extra":1}');
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /does not match/);
  assert.match(wrong.error, /passed/);
  assert.match(wrong.error, /files/);
  assert.match(wrong.error, /extra/);
  assert.match(checkResult(schema, "{not json").error, /not valid JSON/);
  assert.match(checkResult(schema, undefined).error, /No result was given/);
  // Without a schema JSON text is parsed and anything else kept as given.
  assert.deepEqual(checkResult(null, '{"n":1}').value, { n: 1 });
  assert.equal(checkResult(null, "plain words").value, "plain words");
  assert.equal(checkResult(null, undefined).value, null);
});

test("an invalid result is refused in the tool call; a valid one ends the job", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  await assert.rejects(
    lead.spawn(spec("Bad schema", { resultSchema: { type: "wat" } })),
    /resultSchema is not a usable JSON Schema/,
  );
  const job = await lead.spawn(spec("Checked", { resultSchema: schema }));
  const agent = o.get(job.id);
  await until(() => agent.status === "running");
  const worker = workers[0];
  assert.match(
    worker.last("thread/start").params.developerInstructions,
    /result: JSON text that validates against this JSON Schema:\n\{"type":"object"/,
  );
  const refused = report(worker, '{"passed":true,"files":[]}');
  assert.equal(refused.result.success, false);
  assert.match(refused.result.contentItems[0].text, /files/);
  assert.equal(agent.resultValid, false);
  const accepted = report(worker, '{"passed":true,"files":["src/a.js"]}');
  assert.deepEqual(JSON.parse(accepted.result.contentItems[0].text), {
    accepted: true,
    result: "valid",
  });
  worker.say("All green.");
  worker.complete();
  const { reason, agents } = await lead.wait([job.id], { timeoutMs: 5000 });
  assert.equal(reason, "done");
  assert.deepEqual(agents[0], {
    id: job.id,
    agentName: job.agentName,
    name: "Checked",
    owner: "lead",
    workspace: "test-ws",
    status: "completed",
    done: true,
    result: { passed: true, files: ["src/a.js"] },
    report: "Ran the tests.",
    summary: "All green.",
    error: null,
    questions: [],
  });
  assert.equal(workers.length, 1);
});

test("a turn that ends without a valid result is resumed once with the reason", async (t) => {
  const { o, spec, workers, as, store } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Forgets", { resultSchema: schema }));
  const agent = o.get(job.id);
  await until(() => agent.status === "running");
  // The wait spans the automatic retry: it does not return in between.
  const waiting = lead.wait([job.id], { timeoutMs: 10000 });
  workers[0].say("Done, I think.");
  workers[0].complete();
  await until(() => workers.length === 2 && agent.status === "running");
  const retry = workers[1].last("turn/start").params.input[0].text;
  assert.match(
    retry,
    /^Pelican:\nYour turn ended without a valid structured result/,
  );
  assert.match(retry, /pelican_report was not called with a result/);
  assert.ok(
    workers[1].last("thread/resume"),
    "the same conversation continues",
  );
  assert.ok(
    store.events({ jobId: job.id }).some((e) => e.type === "job.retrying"),
  );
  assert.ok(
    !store.events({ jobId: job.id }).some((e) => e.type === "job.finished"),
  );
  report(workers[1], { passed: false, files: ["test/x.test.js"] });
  workers[1].complete();
  const { reason, agents } = await waiting;
  assert.equal(reason, "done");
  assert.equal(agents[0].status, "completed");
  assert.deepEqual(agents[0].result, {
    passed: false,
    files: ["test/x.test.js"],
  });
});

test("still no valid result after the retry: the agent fails with the validation error", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Stubborn", { resultSchema: schema }));
  const agent = o.get(job.id);
  await until(() => agent.status === "running");
  report(workers[0], '{"passed":1}');
  workers[0].complete();
  await until(() => workers.length === 2 && agent.status === "running");
  assert.match(workers[1].last("turn/start").params.input[0].text, /passed/);
  report(workers[1], '{"passed":2}');
  workers[1].complete();
  const { agents } = await lead.wait([job.id], { timeoutMs: 5000 });
  assert.equal(agents[0].status, "failed");
  assert.match(agents[0].error, /after one automatic retry/);
  assert.match(agents[0].error, /does not match/);
  assert.equal(agents[0].result, null);
  assert.equal(workers.length, 2);
  // A new assignment gets its own retry.
  await lead.resume(job.id, { prompt: "Try once more" });
  await until(() => workers.length === 3 && agent.status === "running");
  assert.equal(agent.resultRetried, false);
  workers[2].complete();
  await until(() => workers.length === 4);
});

test("without a schema the result is optional and taken as given", async (t) => {
  const { o, spec, workers, as } = await harness(t);
  const lead = as("lead");
  const job = await lead.spawn(spec("Loose"));
  const agent = o.get(job.id);
  await until(() => agent.status === "running");
  report(workers[0], '{"count": 3}');
  assert.deepEqual(agent.result, { count: 3 });
  workers[0].complete();
  const { agents } = await lead.wait([job.id], { timeoutMs: 5000 });
  assert.equal(agents[0].status, "completed");
  assert.deepEqual(agents[0].result, { count: 3 });
  const plain = await lead.spawn(spec("No report at all"));
  await until(() => o.get(plain.id).status === "running");
  workers[1].say("Finished without reporting.");
  workers[1].complete();
  const done = await lead.wait([plain.id], { timeoutMs: 5000 });
  assert.equal(done.agents[0].status, "completed");
  assert.equal(done.agents[0].result, null);
  assert.equal(done.agents[0].summary, "Finished without reporting.");
});
