import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { api } from "./api.js";
import { connect } from "./client.js";

// Pelican for an MCP client such as Claude Code, which becomes the
// orchestrator of the agents it spawns. Every tool is a gateway call over the
// running service's HTTP RPC, under this session's name:
//   claude mcp add pelican -e PELICAN_AS=lead -- node <pelican>/src/mcp.js
// (or --as lead after mcp.js). Without a name it is "mcp:<folder>".
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { as: { type: "string" }, workspace: { type: "string" } },
  strict: false,
});
const as =
  values.as || process.env.PELICAN_AS || `mcp:${basename(process.cwd())}`;
const pelican = connect({
  as,
  workspace: values.workspace || process.env.PELICAN_WORKSPACE,
  cwd: process.cwd(),
});
const server = new McpServer({ name: "pelican", version: "2.0.0" });
const skip = new Set(["shutdown", "models"]);
// One MCP call may wait longer than one RPC call; wait loops underneath.
const overrides = {
  wait: {
    params: api.wait.params.extend({
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(600000)
        .default(120000)
        .describe(
          "How long to wait, in milliseconds (at most 600000). It returns early when an agent asks a question; call again to keep waiting.",
        ),
    }),
    run: ({ ids, any, timeoutMs }) => pelican.wait(ids, { any, timeoutMs }),
  },
  // A workflow run waits the same way.
  "runs.wait": {
    params: api["runs.wait"].params.extend({
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(600000)
        .default(120000)
        .describe(
          "How long to wait, in milliseconds (at most 600000). It returns early when an agent of the run asks a question; call again to keep waiting.",
        ),
    }),
    run: ({ id, timeoutMs, after }) =>
      pelican.waitRun(id, { timeoutMs, after }),
  },
};
for (const [method, entry] of Object.entries(api)) {
  if (skip.has(method)) continue;
  const name = `pelican_${method.replace(".", "_")}`;
  const params = overrides[method]?.params ?? entry.params;
  const run =
    overrides[method]?.run ?? ((input) => pelican.call(method, input));
  server.registerTool(
    name,
    {
      description: `${entry.description}${entry.caller ? ` You act as ${as}.` : ""}`,
      inputSchema: params.shape,
    },
    async (input) => {
      try {
        const result = await run(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
