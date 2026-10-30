import { createInterface } from "node:readline";
import { once } from "node:events";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  if (!request.method || request.id === undefined) return;
  const { id, method } = request;
  if (method === "initialize") send({ id, result: { userAgent: "fake" } });
  else if (method === "thread/start" || method === "thread/resume")
    send({
      id,
      result: {
        thread: { id: request.params.threadId ?? "fake-thread-" + process.pid },
        cwd: request.params.cwd,
        approvalPolicy: request.params.approvalPolicy,
        sandbox: {
          type: {
            "read-only": "readOnly",
            "workspace-write": "workspaceWrite",
            "danger-full-access": "dangerFullAccess",
          }[request.params.sandbox],
        },
      },
    });
  else if (method === "test/home")
    send({ id, result: { home: process.env.CODEX_HOME } });
  else if (method === "turn/start") {
    send({ method: "turn/started", params: { turn: { id: "fake-turn" } } });
    send({ id, result: { turn: { id: "fake-turn" } } });
  } else if (method === "flood") {
    const { count, chunk } = request.params;
    const itemId = "output-" + process.pid;
    send({
      method: "item/started",
      params: {
        item: {
          id: itemId,
          type: "commandExecution",
          command: "test output flood",
        },
      },
    });
    for (let i = 0; i < count; i++) {
      if (
        !send({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "fake-thread-" + process.pid,
            itemId,
            delta: chunk,
          },
        })
      )
        await once(process.stdout, "drain");
    }
    send({
      method: "item/completed",
      params: {
        item: {
          id: itemId,
          type: "commandExecution",
          command: "test output flood",
          aggregatedOutput: chunk.repeat(count),
        },
      },
    });
    send({ id, result: { count } });
  } else if (method === "pid") send({ id, result: { pid: process.pid } });
  else if (method === "ask") {
    send({
      method: "item/tool/call",
      id: 100,
      params: { tool: "pelican_ask", arguments: { question: "Answer?" } },
    });
    send({ id, result: {} });
  } else if (method === "die") {
    // A start-up crash as Codex reports it: a warning, the cause, exit 1.
    process.stderr.write(
      "warning: Under-development features enabled: prefer_mxc.\n" +
        "Error: failed to initialize sqlite state runtime under C:\\home\n",
      () => process.exit(1),
    );
  } else if (method === "fail")
    send({ id, error: { code: -1, message: "Expected failure" } });
  else if (method === "hang") {
    /* Intentionally no response, until the parent cancels. */
  } else {
    send({ method: "test/notification", params: { method } });
    send({ id, result: request.params });
  }
});
