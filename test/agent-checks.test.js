import test from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../src/gateway.js";
import { harness, until } from "./helpers.js";

const models = [
  {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1-Sol",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map(
      (reasoningEffort) => ({ reasoningEffort }),
    ),
    serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }],
  },
  {
    id: "gpt-6-luna",
    displayName: "GPT-6-Luna",
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    serviceTiers: [],
  },
];
const matching = {
  state: "verified",
  codexVersion: "codex-cli 1.2.3",
  problems: [],
};

// The harness's workspace behind a gateway that checks, as the service's
// does, with the model list and the protocol state given.
async function checked(t, { list = models, protocol = matching } = {}) {
  const h = await harness(t);
  const gateway = new Gateway(h.hub, {
    checks: true,
    protocol: async () => protocol,
  });
  gateway.models = async () => list;
  return { ...h, as: (name) => gateway.as(name), gateway };
}

test("a brief's model, effort and speed are checked before the agent is queued", async (t) => {
  const { as, spec, workers, o } = await checked(t);
  const lead = as("lead");
  const fast = await lead.spawn(spec("Fast", { model: "sol", speed: "fast" }));
  assert.equal(fast.model, "gpt-6.1-sol");
  assert.equal(fast.speed, "fast");
  assert.equal(fast.warning, undefined);
  await until(() => workers[0]?.last("turn/start"));
  assert.equal(workers[0].last("turn/start").params.serviceTier, "priority");
  const standard = await lead.spawn(spec("Standard"));
  await until(() => workers[1]?.last("turn/start"));
  assert.equal(workers[1].last("turn/start").params.serviceTier, "default");
  assert.equal(o.get(standard.id).speed, "standard");
  await assert.rejects(
    lead.spawn(spec("Unknown", { model: "gpt-9" })),
    /Model gpt-9 is not one this Codex account offers\. Available: gpt-6\.1-sol, gpt-6-luna\./,
  );
  await assert.rejects(
    lead.spawn(spec("Too low", { effort: "minimal" })),
    /gpt-6\.1-sol does not support effort minimal/,
  );
  await assert.rejects(
    lead.spawn(spec("No fast", { model: "luna", speed: "fast" })),
    /gpt-6-luna has no fast tier/,
  );
  await assert.rejects(
    lead.batch([
      spec("Fine"),
      { ...spec("Bad"), key: "bad", effort: "low", model: "luna" },
    ]),
    /Job bad: gpt-6-luna does not support effort low/,
  );
  // Nothing was queued for a refused brief or batch.
  assert.equal(o.jobs.size, 2);
});

test("a resume and a settings change are checked the same way", async (t) => {
  const { as, spec, workers, o } = await checked(t);
  const lead = as("lead");
  const agent = await lead.spawn(spec("Agent"));
  await until(() => workers[0]?.last("turn/start"));
  workers[0].complete();
  await until(() => o.get(agent.id).status === "completed");
  await assert.rejects(
    lead.resume(agent.id, { model: "luna", effort: "xhigh" }),
    /gpt-6-luna does not support effort xhigh/,
  );
  assert.equal(o.get(agent.id).status, "completed");
  const resumed = await lead.resume(agent.id, { speed: "fast" });
  assert.equal(resumed.speed, "fast");
  await until(() => workers[1]?.last("turn/start"));
  assert.equal(workers[1].last("turn/start").params.serviceTier, "priority");
  await assert.rejects(
    lead.settings({ effort: "minimal" }),
    /gpt-6\.1-sol does not support effort minimal/,
  );
  const changed = await lead.settings({ model: "GPT-6-Luna" });
  assert.equal(changed.settings.model, "gpt-6-luna");
});

test("without the model list nothing is checked, and only a fast speed is refused", async (t) => {
  const { as, spec } = await checked(t, { list: [] });
  const lead = as("lead");
  const agent = await lead.spawn(spec("Any model", { model: "gpt-9" }));
  assert.equal(agent.model, "gpt-9");
  await assert.rejects(
    lead.spawn(spec("Fast", { speed: "fast" })),
    /could not read it/,
  );
});

test("an unverified Codex comes back as a warning; an incompatible one starts nothing", async (t) => {
  const unverified = await checked(t, {
    protocol: {
      state: "unverified",
      codexVersion: "codex-cli 1.3.0",
      verifiedVersion: "codex-cli 1.2.3",
      problems: [],
    },
  });
  const row = await unverified.as("lead").spawn(unverified.spec("Agent"));
  assert.match(row.warning, /codex-cli 1\.3\.0 .*npm run smoke/);
  assert.equal(
    (await unverified.as("lead").status()).service.codex.state,
    "unverified",
  );
  const incompatible = await checked(t, {
    protocol: {
      state: "incompatible",
      codexVersion: "codex-cli 2.0.0",
      problems: ['turn/steer: field "expectedTurnId" was removed'],
    },
  });
  await assert.rejects(
    incompatible.as("lead").spawn(incompatible.spec("Agent")),
    /codex-cli 2\.0\.0\) changed the protocol Pelican relies on: turn\/steer/,
  );
  assert.equal(incompatible.o.jobs.size, 0);
});

test("a worker refused for an incompatible Codex fails at once, without a start-up retry", async (t) => {
  const refusal = Object.assign(
    new Error("The installed Codex changed the protocol Pelican relies on"),
    { permanent: true },
  );
  const { as, spec, o, store } = await harness(t, {
    workerFactory: () => ({
      on() {},
      start: async () => {
        throw refusal;
      },
      close: async () => {},
    }),
  });
  const agent = await as("lead").spawn(spec("Agent"));
  await until(() => o.get(agent.id).status === "failed");
  assert.match(o.get(agent.id).error, /changed the protocol/);
  assert.equal(o.get(agent.id).attempts, 1);
  assert.equal(store.events({ types: ["job.restarting"] }).length, 0);
});
