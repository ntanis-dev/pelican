import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProcess, ignoredNotifications } from "../src/codex.js";
import {
  checkContract,
  codexProtocol,
  contract,
  protocolNote,
  recordVerified,
  verifiedVersion,
} from "../src/codex-protocol.js";
import { root } from "../src/config.js";
import { checkModelChoice, findModel } from "../src/model-check.js";
import { Store } from "../src/store.js";

// The smallest schema bundle that meets the contract, shaped like the files
// codex app-server generate-json-schema writes. It copies the contract's
// arrays, so breaking a bundle never changes the contract.
function bundle() {
  const fields = (names, required = []) => ({
    properties: Object.fromEntries(names.map((name) => [name, {}])),
    required: [...required],
  });
  const methods = (entries) => {
    const file = { oneOf: [], definitions: {} };
    for (const [method, read] of entries) {
      const params = `${method.replaceAll("/", "_")}Params`;
      file.oneOf.push({
        properties: {
          method: { enum: [method] },
          ...(read ? { params: { $ref: `#/definitions/${params}` } } : {}),
        },
      });
      if (read) file.definitions[params] = read;
    }
    return file;
  };
  const definitions = {};
  for (const [name, read] of Object.entries(contract.shapes))
    definitions[name] = fields(read);
  for (const [name, values] of Object.entries(contract.enums))
    definitions[name] = { enum: [...values] };
  for (const [name, byType] of Object.entries(contract.variants))
    definitions[name] = {
      oneOf: Object.entries(byType).map(([type, read]) => ({
        properties: { type: { enum: [type] }, ...fields(read).properties },
      })),
    };
  definitions.CodexErrorInfo = {
    anyOf: [
      { enum: [...contract.enums.CodexErrorInfo] },
      ...Object.entries(contract.errorVariants).map(([key, read]) => ({
        properties: { [key]: fields(read) },
      })),
    ],
  };
  return {
    "ClientRequest.json": methods(
      Object.entries(contract.requests).map(([method, { always }]) => [
        method,
        always.length ? fields(always, always) : null,
      ]),
    ),
    "ServerRequest.json": methods(
      Object.entries(contract.serverRequests).map(([method, read]) => [
        method,
        fields(read),
      ]),
    ),
    "ServerNotification.json": methods(
      Object.entries(contract.notifications).map(([method, read]) => [
        method,
        fields(read),
      ]),
    ),
    "v2.json": { definitions },
  };
}

test("the protocol check passes a schema that meets the contract and names each break", () => {
  assert.deepEqual(checkContract(bundle()), []);
  const broken = bundle();
  const client = broken["ClientRequest.json"].definitions;
  delete client.turn_steerParams.properties.expectedTurnId;
  client.turn_interruptParams.required.push("reason");
  const server = broken["ServerRequest.json"];
  server.oneOf = server.oneOf.filter(
    (v) => v.properties.method.enum[0] !== "item/tool/call",
  );
  const types = broken["v2.json"].definitions;
  const [codes, ...objects] = types.CodexErrorInfo.anyOf;
  codes.enum = codes.enum.filter((code) => code !== "serverOverloaded");
  types.CodexErrorInfo.anyOf = [
    codes,
    ...objects.filter((v) => !v.properties.responseStreamDisconnected),
  ];
  delete types.ThreadItem.oneOf.find(
    (v) => v.properties.type.enum[0] === "agentMessage",
  ).properties.phase;
  delete types.InitializeCapabilities.properties.optOutNotificationMethods;
  assert.deepEqual(
    checkContract(broken).sort(),
    [
      'CodexErrorInfo: value "serverOverloaded" was removed',
      "CodexErrorInfo responseStreamDisconnected no longer exists",
      'InitializeCapabilities: field "optOutNotificationMethods" was removed',
      'ThreadItem agentMessage: field "phase" was removed',
      "request item/tool/call no longer exists",
      'turn/interrupt: new required field "reason"',
      'turn/steer: field "expectedTurnId" was removed',
    ].sort(),
  );
  // The contract itself is untouched: a fresh bundle still passes.
  assert.deepEqual(checkContract(bundle()), []);
});

test("the protocol state: verified only after a smoke run on this version", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pelican-protocol-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir };
  const matches = async () => ({
    codexVersion: "codex-cli 1.2.3",
    problems: [],
    checkedAt: "now",
  });
  const unverified = await codexProtocol(config, { check: matches });
  assert.equal(unverified.state, "unverified");
  assert.equal(unverified.verifiedVersion, null);
  assert.match(protocolNote(unverified), /npm run smoke/);
  await recordVerified(config, "codex-cli 1.2.3");
  assert.equal(await verifiedVersion(config), "codex-cli 1.2.3");
  const verified = await codexProtocol(config, { check: matches });
  assert.equal(verified.state, "verified");
  assert.equal(protocolNote(verified), null);
  const changed = await codexProtocol(config, {
    check: async () => ({
      codexVersion: "codex-cli 1.3.0",
      problems: ['turn/steer: field "expectedTurnId" was removed'],
    }),
  });
  assert.equal(changed.state, "incompatible");
  assert.equal(changed.verifiedVersion, "codex-cli 1.2.3");
  const unknown = await codexProtocol(config, {
    check: async () => {
      throw new Error("codex --version failed");
    },
  });
  assert.equal(unknown.state, "unknown");
  assert.match(protocolNote(unknown), /codex --version failed/);
});

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
    id: "gpt-6-sol",
    displayName: "GPT-6-Sol",
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    serviceTiers: [],
  },
  {
    id: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    hidden: true,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    serviceTiers: [],
  },
];

test("a model is found by id, short name or display name; a hidden one only by id", () => {
  assert.equal(findModel(models, "gpt-6-sol").id, "gpt-6-sol");
  assert.equal(findModel(models, " SOL ").id, "gpt-6.1-sol");
  assert.equal(findModel(models, "GPT-6-Sol").id, "gpt-6-sol");
  assert.equal(findModel(models, "gpt-6-luna").id, "gpt-6-luna");
  assert.equal(findModel(models, "luna"), undefined);
  assert.equal(findModel(models, "GPT-6 Luna"), undefined);
});

test("a model choice resolves the id and the tier, or says what the account offers", () => {
  assert.deepEqual(checkModelChoice(models, { model: "sol", effort: "high" }), {
    model: "gpt-6.1-sol",
    serviceTier: "default",
  });
  assert.deepEqual(
    checkModelChoice(models, { model: "sol", effort: "xhigh", speed: "fast" }),
    { model: "gpt-6.1-sol", serviceTier: "priority" },
  );
  assert.throws(
    () => checkModelChoice(models, { model: "gpt-9" }),
    /^Error: Model gpt-9 is not one this Codex account offers\. Available: gpt-6\.1-sol, gpt-6-sol\.$/,
  );
  assert.throws(
    () =>
      checkModelChoice(models, {
        model: "gpt-9",
        of: "The workspace's model",
      }),
    /^Error: The workspace's model gpt-9 is not one/,
  );
  assert.throws(
    () => checkModelChoice(models, { model: "sol", effort: "minimal" }),
    /gpt-6\.1-sol does not support effort minimal\. It supports low, medium, high, xhigh\./,
  );
  assert.throws(
    () => checkModelChoice(models, { model: "gpt-6-sol", speed: "fast" }),
    /gpt-6-sol has no fast tier\./,
  );
});

test("Codex is asked not to send the notifications Pelican ignores", async () => {
  const proc = new CodexProcess({
    bin: process.execPath,
    args: [join(root, "test/fixtures/fake-codex.js")],
    timeoutMs: 3000,
  });
  try {
    await proc.start();
    const { capabilities } = await proc.request("test/initialize");
    assert.equal(capabilities.experimentalApi, true);
    assert.deepEqual(capabilities.optOutNotificationMethods, [
      "turn/diff/updated",
      "turn/moderationMetadata",
      "account/rateLimits/updated",
    ]);
  } finally {
    await proc.close();
  }
});

test("a failed preflight stops Codex from starting at all", async () => {
  const proc = new CodexProcess({
    bin: process.execPath,
    args: [join(root, "test/fixtures/fake-codex.js")],
    preflight: async () => {
      throw new Error("The installed Codex changed the protocol");
    },
  });
  try {
    await assert.rejects(proc.start(), /changed the protocol/);
    assert.equal(proc.child, undefined);
  } finally {
    await proc.close();
  }
});

test("compacting drops the journaled notifications Pelican no longer receives", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pelican-compact-"));
  const store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const type of [
    "turn/diff/updated",
    "item/completed",
    "turn/moderationMetadata",
    "job.created",
  ])
    store.event("job-1", type, { diff: "x".repeat(1000) });
  store.compact({ drop: ignoredNotifications });
  assert.deepEqual(
    store.db
      .prepare("SELECT type FROM events ORDER BY seq")
      .all()
      .map((row) => row.type),
    ["item/completed", "job.created"],
  );
});
