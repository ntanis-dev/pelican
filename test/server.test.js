import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/server.js";
import { root } from "../src/config.js";
import { api } from "../src/api.js";
import { harness, until } from "./helpers.js";

async function serve(t, fixture) {
  const service = await createServer({
    config: fixture.config,
    gateway: fixture.gateway,
  });
  t.after(() => service.close());
  const rpc = async (method, params = {}, headers = {}) => {
    const response = await fetch(service.origin + "/api/rpc", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.config.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { service, rpc };
}

test("the RPC needs the token, a loopback host and no browser origin", async (t) => {
  const fixture = await harness(t);
  const { service, rpc } = await serve(t, fixture);
  const plain = (path, init = {}) => fetch(service.origin + path, init);
  assert.equal((await plain("/api/health")).status, 401);
  assert.equal(
    (
      await plain("/api/rpc", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token-000000000000000" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (await rpc("status", {}, { origin: "https://attacker.invalid" })).status,
    403,
  );
  // A rebinding page's name for loopback is refused (fetch cannot set Host).
  const rebound = await new Promise((resolve, reject) => {
    const url = new URL(service.origin);
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: "/api/health",
        headers: {
          host: `pelican.attacker.invalid:${url.port}`,
          authorization: `Bearer ${fixture.config.token}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.once("error", reject);
    req.end();
  });
  assert.equal(rebound, 403);
  const health = await plain("/api/health", {
    headers: { authorization: `Bearer ${fixture.config.token}` },
  });
  assert.equal((await health.json()).service, "pelican");
  assert.equal((await rpc("status")).body.result.workspaces[0].id, "test-ws");
  // Removed dashboard routes and methods are gone.
  for (const path of ["/", "/app.js", "/api/session", "/api/status"])
    assert.equal(
      (
        await plain(path, {
          headers: { authorization: `Bearer ${fixture.config.token}` },
        })
      ).status,
      404,
    );
  for (const method of [
    "controller.send",
    "board.manage",
    "cafe.get",
    "jobs.spawn",
  ]) {
    const response = await rpc(method);
    assert.equal(response.status, 404, method);
    assert.match(response.body.error, /Unknown method/);
  }
});

test("callers name themselves in headers; bad input is a 400 with the reason", async (t) => {
  const fixture = await harness(t);
  const { rpc } = await serve(t, fixture);
  const brief = fixture.spec("Over HTTP");
  const anonymous = await rpc("spawn", brief);
  assert.equal(anonymous.status, 400);
  assert.match(anonymous.body.error, /Name yourself/);
  assert.equal(
    (await rpc("spawn", brief, { "x-pelican-as": "pelican" })).status,
    400,
  );
  const spawned = await rpc("spawn", brief, {
    "x-pelican-as": encodeURIComponent("Ελένη lead"),
  });
  assert.equal(spawned.status, 200, JSON.stringify(spawned.body));
  assert.equal(spawned.body.result.owner, "Ελένη lead");
  const bad = await rpc(
    "spawn",
    { name: "No prompt" },
    { "x-pelican-as": "lead" },
  );
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /prompt/);
  // The folder a caller works in picks the workspace and resolves paths.
  const relative = await rpc(
    "spawn",
    { name: "Relative", prompt: "Work here", cwd: ".", resources: [] },
    {
      "x-pelican-as": "lead",
      "x-pelican-cwd": encodeURIComponent(fixture.dir),
    },
  );
  assert.equal(relative.status, 200, JSON.stringify(relative.body));
  assert.equal(relative.body.result.workspace, "test-ws");
  const missing = await rpc("get", { id: "nobody" });
  assert.equal(missing.status, 404);
  await until(() => fixture.workers.length === 2);
  const stopped = await rpc(
    "stop",
    { all: true, reason: "Done testing" },
    { "x-pelican-as": "lead" },
  );
  assert.equal(stopped.body.result.stopped.length, 2);
});

test("the MCP server offers every orchestrator call over the running service", async (t) => {
  const fixture = await harness(t);
  const { service } = await serve(t, fixture);
  const client = new Client({ name: "pelican-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "src/mcp.js"), "--as", "claude-lead"],
    cwd: fixture.dir,
    env: {
      ...process.env,
      PELICAN_URL: service.origin,
      PELICAN_TOKEN: fixture.config.token,
    },
  });
  await client.connect(transport);
  try {
    await mcpSession(client, fixture);
  } finally {
    // Before the harness removes the folder the server runs in.
    await client.close();
  }
});

async function mcpSession(client, fixture) {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    Object.keys(api)
      .filter((m) => !["shutdown", "models"].includes(m))
      .map((m) => `pelican_${m.replace(".", "_")}`)
      .sort(),
  );
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  // Its folder is inside the workspace, so nothing needs naming.
  const agent = await call("pelican_spawn", {
    name: "From Claude Code",
    prompt: "Report the folder name",
    resources: [],
    resultSchema: {
      type: "object",
      properties: { folder: { type: "string" } },
      required: ["folder"],
    },
  });
  assert.equal(agent.owner, "claude-lead");
  await until(() => fixture.o.get(agent.id).status === "running");
  const worker = fixture.workers[0];
  worker.call("pelican_ask", { question: "Which folder?" }, "q");
  const waited = await call("pelican_wait", {
    ids: [agent.id],
    timeoutMs: 5000,
  });
  assert.equal(waited.reason, "question");
  const [question] = await call("pelican_questions");
  assert.equal(question.owner, "claude-lead");
  await call("pelican_answer", {
    id: agent.id,
    requestId: question.requestId,
    answer: "The test folder",
  });
  worker.call("pelican_report", {
    report: "Read the folder name.",
    result: JSON.stringify({ folder: "pelican-test" }),
  });
  worker.complete();
  const done = await call("pelican_wait", { ids: [agent.id] });
  assert.equal(done.reason, "done");
  assert.deepEqual(done.agents[0].result, { folder: "pelican-test" });
  const settings = await call("pelican_settings", { network: true });
  assert.equal(settings.settings.network, true);
  // Activity over time, the same JSON as the gateway's.
  const activity = await call("pelican_metrics", { minutes: 5 });
  assert.equal(activity.buckets.length, 60);
  assert.equal(activity.totals.started, 1);
  assert.equal(activity.totals.finished, 1);
  assert.deepEqual(
    activity.owners.map((o) => o.name),
    ["claude-lead"],
  );
  const failed = await client.callTool({
    name: "pelican_get",
    arguments: { id: "nobody" },
  });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /No agent/);
}
