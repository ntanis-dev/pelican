import { z } from "zod";
import { briefSchema, effortSchema, settingsSchema } from "./schema.js";

// Every operation Pelican offers, once. The gateway implements them; the HTTP
// RPC, the MCP server, the CLI and the client proxy expose them with these
// names, parameters and JSON results.
export const maxWaitMs = 120000;
const ref = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Agent id, a unique id prefix (4+ characters) or the agent's name.",
  );
const workspace = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    "Workspace id or name. Optional when the agent's or the caller's folder is inside one, or only one exists.",
  );
const owner = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Only agents this orchestrator owns.");
const takeover = z
  .boolean()
  .optional()
  .describe(
    "Direct an agent another orchestrator owns. You become its owner and get its questions.",
  );
const timeoutMs = (fallback) =>
  z
    .number()
    .int()
    .min(0)
    .max(maxWaitMs)
    .default(fallback)
    .describe(
      `How long to wait for news, in milliseconds (at most ${maxWaitMs}). Call again to keep waiting.`,
    );
const object = (shape) => z.object(shape).strict();
const runRef = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Run id, a unique id prefix (4+ characters) or its name (the newest run of that name).",
  );
export const statusGroups = {
  active: ["starting", "running", "waiting", "stopping"],
  live: ["queued", "starting", "running", "waiting", "stopping"],
  done: ["completed", "failed", "cancelled", "interrupted", "blocked"],
};
export const allStatuses = [
  "queued",
  "starting",
  "running",
  "waiting",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
];
const jobBrief = briefSchema.extend({
  key: z
    .string()
    .min(1)
    .optional()
    .describe("A name other jobs in this batch use in dependsOn."),
});

export const api = {
  status: {
    description:
      "Pelican's service and every workspace at a glance: settings, working and queued agents, open questions.",
    params: object({}),
  },
  workspaces: {
    description: "List the workspaces with their folders and settings.",
    params: object({}),
  },
  "workspace.add": {
    description:
      "Add a workspace for an existing folder. Agents of a workspace work only inside its folder.",
    params: object({
      folder: z.string().trim().min(1).describe("The folder (absolute path)."),
      name: z.string().trim().min(1).max(60).optional(),
    }),
  },
  "workspace.remove": {
    description:
      "Remove a workspace that has no running or queued agents. Its own Pelican data goes with it; the folder is untouched.",
    params: object({ workspace: z.string().trim().min(1) }),
  },
  settings: {
    description:
      "Read or change a workspace's settings: concurrency (agents at once), paused (the queue starts nothing), model and effort (defaults for new agents), network (agents' sandbox network access).",
    params: settingsSchema.extend({ workspace }).strict(),
  },
  spawn: {
    caller: true,
    description:
      "Start an agent with a brief: name, prompt (the goal, the files it owns, how to check the result, what to report) and optionally resources (paths it reserves; default the whole cwd, [] for read-only work), model, effort, resultSchema (JSON Schema for its structured result), dependsOn, priority, cwd. Returns at once; wait for the result.",
    params: briefSchema.extend({ workspace }).strict(),
  },
  batch: {
    caller: true,
    description:
      "Start several agents at once. dependsOn may name another job's key in the batch.",
    params: object({ workspace, jobs: z.array(jobBrief).min(1).max(100) }),
  },
  get: {
    description:
      "One agent in full: status, model, tokens, resources, result, report, summary, last activity, notes, messages and pending questions.",
    params: object({ id: ref }),
  },
  list: {
    description:
      "List agents, newest first. status takes statuses or the groups active, live and done.",
    params: object({
      workspace,
      status: z.array(z.string().min(1)).optional(),
      owner,
      limit: z.number().int().min(1).max(500).default(100),
    }),
  },
  wait: {
    description:
      "Wait until the agents are done (or any of them with any), or until one of them asks a question. Returns each agent's status, result, report and summary, and the reason: done, question or timeout.",
    params: object({
      ids: z.array(ref).min(1).max(100),
      any: z.boolean().default(false),
      timeoutMs: timeoutMs(maxWaitMs),
    }),
  },
  message: {
    caller: true,
    description:
      "Message an agent. steer reaches its running turn now; followup becomes its next assignment when the turn ends. A finished agent takes the message as a new assignment.",
    params: object({
      id: ref,
      text: z.string().trim().min(1).max(150000),
      mode: z.enum(["steer", "followup"]).default("steer"),
      takeover,
    }),
  },
  resume: {
    caller: true,
    description:
      "Give a finished agent its next assignment in the same conversation: corrections, review findings or a follow-up.",
    params: object({
      id: ref,
      prompt: z.string().trim().min(1).max(150000).optional(),
      model: z.string().trim().min(1).max(100).optional(),
      effort: effortSchema.optional(),
      takeover,
    }),
  },
  answer: {
    caller: true,
    description:
      "Answer an agent's pending question (plain text) or approval (a decision it offers, such as accept or decline).",
    params: object({
      id: ref,
      requestId: z
        .string()
        .trim()
        .min(1)
        .describe("The question's requestId, or a unique prefix of it."),
      answer: z.union([
        z.string().trim().min(1),
        z.record(z.string(), z.unknown()),
      ]),
      takeover,
    }),
  },
  questions: {
    description:
      "Every pending question and approval, oldest first, with the orchestrator it waits for.",
    params: object({ workspace, owner }),
  },
  stop: {
    caller: true,
    description:
      "Stop one agent (its changes stay in the workspace), or with all every running and queued agent (owner narrows it to one orchestrator's, workspace to one workspace).",
    params: object({
      id: ref.optional(),
      all: z.boolean().default(false),
      owner,
      workspace,
      reason: z.string().trim().min(1).max(2000).optional(),
      force: z
        .boolean()
        .default(false)
        .describe(
          "End the agent's process at once instead of interrupting its turn.",
        ),
    }),
  },
  events: {
    description:
      "A workspace's journal after a cursor: assignments, starts, finishes, questions, answers, messages, reports and settings (raw adds every Codex event). With timeoutMs, waits for the next one. Page with the returned cursor.",
    params: object({
      workspace,
      after: z.number().int().min(0).default(0),
      jobId: ref.optional(),
      owner,
      raw: z.boolean().default(false),
      limit: z.number().int().min(1).max(1000).default(200),
      last: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(0)
        .describe(
          "The newest this many entries instead of those after the cursor.",
        ),
      timeoutMs: timeoutMs(0),
    }),
  },
  tail: {
    description:
      "One agent's journal as readable lines: its assignment, commands, edits, messages, questions, reports and finish. With timeoutMs, waits for more.",
    params: object({
      id: ref,
      after: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(200),
      last: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(0)
        .describe(
          "The newest this many lines' entries instead of those after the cursor.",
        ),
      timeoutMs: timeoutMs(0),
      full: z
        .boolean()
        .default(false)
        .describe(
          "Its whole conversation: each line also gets its kind (brief, message, agent, reasoning, command, edit, question, answer, note, report, status), who it is from or to, and the full text, command output or diff as detail; reasoning summaries become lines too.",
        ),
    }),
  },
  // Orchestrator timelines: what each orchestrator says and does, for the
  // people watching (the menu's Orchestrators view) and for each other.
  note: {
    caller: true,
    description:
      "Journal a note from you, the orchestrator: what you are doing and why. It goes into your timeline (feed), which people watch in the menu; agents do not see it.",
    params: object({
      text: z.string().trim().min(1).max(20000),
      workspace,
    }),
  },
  feed: {
    description:
      "An orchestrator's timeline, oldest first: its notes, what it did (spawned, messaged, resumed, answered, stopped, took over, changed settings, started or stopped a workflow run) and what its agents sent it (questions, notes, reports, finishes). as names the orchestrator (default: you); all gives everyone's. Spans every workspace unless one is named. Page with the returned cursor; with timeoutMs, waits for the next entry.",
    params: object({
      as: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("The orchestrator whose timeline to read (default: you)."),
      all: z
        .boolean()
        .default(false)
        .describe("Every orchestrator's timeline."),
      workspace,
      after: z
        .string()
        .optional()
        .describe("The cursor of an earlier answer: entries after it."),
      limit: z.number().int().min(1).max(1000).default(200),
      last: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(0)
        .describe(
          "The newest this many entries instead of those after the cursor.",
        ),
      timeoutMs: timeoutMs(0),
    }),
  },
  metrics: {
    description:
      "Activity over time, from the journal: per time bucket the agents live (the most at once), started, finished (any end) and failed (failed or blocked), tokens used, journal entries of the feed (events) and questions asked; with totals, the current numbers (working, queued, questions, concurrency), and the same series per workspace and per orchestrator. workspace and owner narrow it; minutes is the window, bucketSeconds the bucket (buckets are aligned to the clock; the last one is the current, partial bucket).",
    params: object({
      workspace,
      owner: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Only this orchestrator's agents and journal entries."),
      minutes: z
        .number()
        .int()
        .min(1)
        .max(10080)
        .default(60)
        .describe("The window, in minutes back from now (at most 7 days)."),
      bucketSeconds: z
        .number()
        .int()
        .min(5)
        .max(86400)
        .optional()
        .describe(
          "The bucket length in seconds (default: the window in 60 buckets, at least 5 s; at most 1000 buckets).",
        ),
    }),
  },
  models: {
    description: "The models the signed-in Codex account offers.",
    params: object({}),
  },
  account: {
    description: "Whether Codex is signed in to ChatGPT, and the plan.",
    params: object({}),
  },
  usage: {
    description:
      "The Codex account's usage limits as last read: each limit's rolling windows (the short one and the weekly one) with the percent used and when it resets, the plan and credits. Pelican reads them when it starts and every 30 minutes while it runs; refresh reads them again now (at most once a minute). Use it to judge how many agents to run.",
    params: object({
      refresh: z
        .boolean()
        .default(false)
        .describe("Read the limits again now instead of the last reading."),
    }),
  },
  shutdown: {
    description:
      "Stop the Pelican service. Running agents are interrupted; their changes stay.",
    params: object({}),
  },
  // Workflow runs (src/runner.js).
  "runs.start": {
    caller: true,
    description:
      "Run a workflow script inside the service, as you: export const meta = { name, description, phases } and a body that drives agents with agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title) and log(text), reading args. Its agents' questions come to you. Returns the run at once; follow it with runs.get or runs.wait.",
    params: object({
      file: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("The workflow file (absolute, or relative to your folder)."),
      source: z
        .string()
        .min(1)
        .max(1000000)
        .optional()
        .describe("The workflow's text, instead of a file."),
      args: z
        .unknown()
        .optional()
        .describe("Any JSON value; the script reads it as args."),
      workspace,
      name: z
        .string()
        .trim()
        .min(1)
        .max(140)
        .optional()
        .describe("The run's name, instead of meta.name."),
      cwd: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "The folder its agents work in (absolute, or relative to your folder), inside the workspace. Default: the workspace's folder, wherever you are.",
        ),
    }),
  },
  "runs.list": {
    description:
      "Workflow runs, newest first, with their agents' counts. status: running, completed, failed, stopped or interrupted.",
    params: object({
      workspace,
      status: z
        .union([z.string().min(1), z.array(z.string().min(1))])
        .optional(),
    }),
  },
  "runs.get": {
    description:
      "One run: status, its phases with each agent call (label, agent id, status), the last 200 log lines, its result or error, and its agents' open questions.",
    params: object({ id: runRef }),
  },
  "runs.stop": {
    caller: true,
    description:
      "Stop a run: the script ends, its live agents stop (their changes stay), and it is marked stopped. runs.resume continues it.",
    params: object({
      id: runRef,
      reason: z.string().trim().min(1).max(2000).optional(),
    }),
  },
  "runs.resume": {
    caller: true,
    description:
      "Run a stopped, interrupted, failed or finished run again against its journal: an agent() call whose prompt and options are unchanged gets its earlier result at once, an agent that was cut off continues, the rest run live. Reads the workflow file again (or the file or source given), so an edited script resumes too.",
    params: object({
      id: runRef,
      file: z.string().trim().min(1).optional(),
      source: z.string().min(1).max(1000000).optional(),
      args: z
        .unknown()
        .optional()
        .describe("New args; the run's own when left out."),
      takeover: z
        .boolean()
        .optional()
        .describe(
          "Resume a run another orchestrator owns; you become its owner.",
        ),
    }),
  },
  "runs.wait": {
    description:
      "Wait until a run ends or one of its agents asks a question (answer it with answer). Returns the reason (done, question or timeout), the run as runs.get gives it, and a version; with after (a version), it returns at the next change instead (reason change).",
    params: object({
      id: runRef,
      timeoutMs: timeoutMs(maxWaitMs),
      after: z.number().int().min(0).optional(),
    }),
  },
};

// Calls that may be repeated after a broken connection.
export const reads = new Set([
  "status",
  "workspaces",
  "get",
  "list",
  "wait",
  "questions",
  "events",
  "tail",
  "models",
  "account",
  "usage",
  "runs.list",
  "runs.get",
  "runs.wait",
  "feed",
  "metrics",
]);
