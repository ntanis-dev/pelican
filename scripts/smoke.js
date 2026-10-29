// An explicit live integration test: it spawns one real Codex agent through
// the running service, the way any orchestrator does, and waits for its
// structured result. It uses the signed-in Codex allowance.
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { connect } from "../src/client.js";

const cwd = resolve(".cache", "smoke-workspace");
const target = resolve(cwd, "smoke.txt");
await mkdir(cwd, { recursive: true });
await rm(target, { force: true });
const pelican = connect({ as: "smoke", cwd });
// A workspace of its own, so no other workspace's queue or settings matter.
const workspace = await pelican.addWorkspace(cwd, {
  name: `pelican-smoke-${randomBytes(2).toString("hex")}`,
});
try {
  const agent = await pelican.spawn({
    workspace: workspace.id,
    name: "Pelican smoke test",
    prompt:
      "Create smoke.txt in your working folder containing exactly PELICAN_OK (no newline), read it back, then report with result {file, content}.",
    effort: "low",
    resources: ["."],
    resultSchema: {
      type: "object",
      properties: { file: { type: "string" }, content: { type: "string" } },
      required: ["file", "content"],
    },
  });
  const outcome = await pelican.wait([agent.id], { timeoutMs: 8 * 60000 });
  assert.equal(outcome.reason, "done", JSON.stringify(outcome, null, 2));
  const [done] = outcome.agents;
  assert.equal(done.status, "completed", done.error ?? "");
  assert.equal(done.result.content, "PELICAN_OK");
  assert.equal((await readFile(target, "utf8")).trim(), "PELICAN_OK");
  console.log(
    `Live smoke test passed: ${done.agentName} ran end to end and returned ${JSON.stringify(done.result)}.`,
  );
} finally {
  await pelican.stop({ all: true, workspace: workspace.id }).catch(() => {});
  await pelican.removeWorkspace(workspace.id).catch((error) => {
    console.error(`Could not remove the smoke workspace: ${error.message}`);
  });
}
