import { CodexProcess } from "../../src/codex.js";
import { fileURLToPath } from "node:url";
const p = new CodexProcess({
  bin: process.execPath,
  args: [fileURLToPath(new URL("./fake-codex.js", import.meta.url))],
});
await p.start();
const result = await p.request("pid");
console.log(JSON.stringify({ host: p.child.pid, cli: result.pid }));
// Simulate the controller exiting without stopping its workers.
process.exit(0);
