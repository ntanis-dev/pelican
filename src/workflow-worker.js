import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { prelude } from "./workflow.js";

// One workflow run: its own thread (a busy or broken script cannot stall the
// service, and stopping the run ends the thread) and its own JavaScript
// context, which holds only the injected globals and the built-ins. This is
// isolation, not a security sandbox: scripts are the orchestrator's own.
// agent() calls go to the service, which spawns the agents, waits for them
// and answers with their results.
const { code, filename, args } = workerData;
const send = (message) => parentPort.postMessage(message);
const replies = new Map();
let calls = 0;
const host = {
  agent(payload, phase) {
    const call = calls++;
    return new Promise((resolve, reject) => {
      replies.set(call, { resolve, reject });
      send({ type: "agent", call, payload, phase });
    });
  },
  phase: (title) => send({ type: "phase", title }),
  log: (text) => send({ type: "log", text }),
};
parentPort.on("message", (message) => {
  const waiting = message?.type === "reply" && replies.get(message.call);
  if (!waiting) return;
  replies.delete(message.call);
  if (message.error !== undefined) waiting.reject(message.error);
  else waiting.resolve(message.value);
});
// A forgotten promise that fails is reported, not fatal.
process.on("unhandledRejection", (reason) =>
  host.log(`Unhandled rejection: ${reason?.message ?? reason}`),
);
const where = (stack) =>
  String(stack ?? "")
    .split("\n")
    .filter((line) => line.includes(filename))
    .slice(0, 3)
    .map((line) => line.trim().replace(/^at /, ""))
    .join("; ");

const context = vm.createContext({}, { name: filename });
vm.runInContext(`(${prelude})`, context, { filename: "pelican-prelude.js" })(
  host,
  args,
);
try {
  const value = await vm.runInContext(code, context, { filename });
  let result;
  try {
    result = JSON.stringify(value === undefined ? null : value) ?? "null";
  } catch (error) {
    throw new Error(`The workflow's result is not JSON: ${error.message}`);
  }
  send({ type: "done", result });
} catch (error) {
  send({
    type: "error",
    message: error?.message ?? String(error),
    at: where(error?.stack),
  });
}
