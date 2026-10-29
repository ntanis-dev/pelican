#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect } from "./client.js";
import { loadConfig } from "./config.js";
import { codexLaunch } from "./cli-path.js";
import { CodexAccount } from "./account.js";
import * as format from "./format.js";
import { detectPaint, plain } from "./paint.js";
import { logo, motto, slogan, wordmarkWidth } from "./menu/art.js";
import { wrap } from "./menu/text.js";
import { startService, stopService } from "./service.js";

// pelican: the one command for people and orchestrators. Every agent command
// is a gateway call over the service's HTTP RPC; --json prints its JSON
// result unchanged, otherwise readable text.
//
// Commands live in one table. A command is { group, usage, summary, example,
// options (node:util parseArgs options), run(ctx) }; run returns
// { data, text?, code? } (or nothing when it printed itself). Later phases add
// "menu" (pelican with no arguments) and "run" (workflows) here.
export const commands = new Map();
export function command(name, definition) {
  commands.set(name, { options: {}, ...definition });
}
export const globalOptions = {
  as: { type: "string" },
  workspace: { type: "string", short: "w" },
  json: { type: "boolean" },
  plain: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
export class UsageError extends Error {}

// Argument helpers. "@path" reads a file (relative to the current folder).
const fromFile = (value) =>
  typeof value === "string" && value.startsWith("@")
    ? readFileSync(resolve(value.slice(1)), "utf8")
    : value;
// JSON text, @file, or (handy in PowerShell, where @ splats) a file path.
function jsonValue(value, what) {
  let text = fromFile(value);
  if (
    text === value &&
    !/^\s*[[{"]/.test(text) &&
    existsSync(resolve(String(text).trim()))
  )
    text = readFileSync(resolve(String(text).trim()), "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${what} is not valid JSON: ${error.message}`);
  }
}
function bool(value, flag) {
  if (value === undefined) return undefined;
  const word = String(value).toLowerCase();
  if (["true", "on", "yes", "1"].includes(word)) return true;
  if (["false", "off", "no", "0"].includes(word)) return false;
  throw new UsageError(`--${flag} takes true or false.`);
}
function integer(value, flag) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n))
    throw new UsageError(`--${flag} takes a whole number.`);
  return n;
}
const seconds = (value, flag) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new UsageError(`--${flag} takes seconds.`);
  return n * 1000;
};
const words = (values) =>
  [values ?? []]
    .flat()
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
const owner = (ctx) =>
  ctx.values.mine ? ctx.client.context.as : ctx.values.owner;
const prompt = (values) =>
  values["prompt-file"] !== undefined
    ? readFileSync(resolve(values["prompt-file"]), "utf8")
    : fromFile(values.prompt);
// Wait exit codes: 0 done, 2 timed out, 3 an agent asks a question.
const waitCode = (outcome) =>
  outcome.reason === "done" ? 0 : outcome.reason === "question" ? 3 : 2;
async function waitFor(ctx, ids, { any = false, timeoutMs } = {}) {
  const outcome = await ctx.client.wait(ids, {
    any,
    timeoutMs: timeoutMs ?? Infinity,
  });
  return {
    data: outcome,
    text: format.wait(outcome, ctx.paint),
    code: waitCode(outcome),
  };
}
// Follows a journal until interrupted (or, for one agent, until it is done).
async function follow(ctx, read, print, stop = () => false) {
  for (;;) {
    const page = await read();
    print(page);
    if (stop(page)) return;
  }
}
const briefOptions = {
  name: { type: "string" },
  prompt: { type: "string" },
  "prompt-file": { type: "string" },
  resource: { type: "string", multiple: true },
  resources: { type: "string" },
  "read-only": { type: "boolean" },
  model: { type: "string" },
  effort: { type: "string" },
  "result-schema": { type: "string" },
  "depends-on": { type: "string", multiple: true },
  priority: { type: "string" },
  cwd: { type: "string" },
};
function brief(values, base = {}) {
  const spec = { ...base };
  const text = prompt(values);
  if (text !== undefined) spec.prompt = text;
  if (values.name !== undefined) spec.name = values.name;
  if (!spec.name && spec.prompt)
    spec.name = spec.prompt.trim().split(/\r?\n/)[0].slice(0, 80);
  if (values["read-only"]) spec.resources = [];
  else if (values.resources !== undefined || values.resource)
    spec.resources = [...words(values.resources), ...words(values.resource)];
  if (values.model) spec.model = values.model;
  if (values.effort) spec.effort = values.effort;
  if (values["result-schema"] !== undefined)
    spec.resultSchema = jsonValue(values["result-schema"], "--result-schema");
  if (values["depends-on"]) spec.dependsOn = words(values["depends-on"]);
  if (values.priority !== undefined)
    spec.priority = integer(values.priority, "priority");
  if (values.cwd !== undefined) spec.cwd = resolve(values.cwd);
  else if (spec.cwd) spec.cwd = resolve(spec.cwd);
  if (!spec.prompt)
    throw new UsageError(
      "Give the agent a prompt: --prompt, --prompt-file or @brief.json.",
    );
  return spec;
}

// Service
command("start", {
  group: "Service",
  usage: "pelican start [--foreground]",
  summary:
    "Start the service now, in the background (no window on Windows). It also starts by itself when a command needs it, and exits after a few minutes with nothing to do.",
  example: "pelican start",
  options: { foreground: { type: "boolean" } },
  autostart: false,
  async run(ctx) {
    if (ctx.values.foreground) {
      await import("./main.js");
      return null;
    }
    const state = await startService();
    return {
      data: state,
      text: ctx.paint.check(
        state.already
          ? `Pelican is already running at ${state.url} (process ${state.pid}).`
          : `Pelican started at ${state.url} (process ${state.pid}).`,
      ),
    };
  },
});
command("stop-service", {
  group: "Service",
  usage: "pelican stop-service",
  summary:
    "Stop the service. Running agents are interrupted; their changes stay.",
  example: "pelican stop-service",
  async run(ctx) {
    const result = await stopService({ log: ctx.log });
    return {
      data: result,
      text: result.stopped
        ? ctx.paint.check("Pelican stopped.")
        : ctx.paint.muted("Pelican is not running."),
    };
  },
});
command("restart", {
  group: "Service",
  usage: "pelican restart",
  summary: "Stop the service and start it again in the background.",
  example: "pelican restart",
  async run(ctx) {
    await stopService({ log: ctx.log });
    const state = await startService();
    return {
      data: state,
      text: ctx.paint.check(
        `Pelican restarted at ${state.url} (process ${state.pid}).`,
      ),
    };
  },
});
command("status", {
  group: "Service",
  usage: "pelican status",
  summary:
    "The service and every workspace at a glance (it does not start the service).",
  example: "pelican status",
  autostart: false,
  async run(ctx) {
    let data;
    try {
      data = await ctx.client.status();
    } catch (error) {
      if (error.code !== "PELICAN_DOWN") throw error;
      return {
        data: { running: false },
        text: ctx.paint.muted(
          `${ctx.paint.pretty ? `${ctx.paint.g.ring} ` : ""}Pelican is not running. It starts when a command needs it (pelican start starts it now).`,
        ),
      };
    }
    return { data, text: format.status(data, ctx.paint) };
  },
});
command("login", {
  group: "Service",
  usage: "pelican login",
  summary:
    "Sign in to ChatGPT through the Codex CLI (agents use this sign-in).",
  example: "pelican login",
  async run(ctx) {
    const config = await loadConfig();
    const account = new CodexAccount({ config });
    let before;
    try {
      before = await account.status();
    } finally {
      await account.close();
    }
    if (before.connected)
      return {
        data: before,
        text: ctx.paint.check(
          `Already signed in${before.account?.plan ? ` (${before.account.plan})` : ""}.`,
        ),
      };
    const { command: bin, prefix } = codexLaunch(config.codexBin);
    const { signIn } = await import("./menu/login.js");
    const code = await signIn({
      launcher: { command: bin, prefix },
      env: process.env,
      name: "Your ChatGPT account",
    });
    const after = new CodexAccount({ config });
    try {
      const state = await after.status();
      return {
        data: state,
        text: state.connected
          ? ctx.paint.check("Signed in.")
          : ctx.paint.err("Not signed in."),
        code: state.connected ? 0 : code || 1,
      };
    } finally {
      await after.close();
    }
  },
});
command("doctor", {
  group: "Service",
  usage: "pelican doctor",
  summary:
    "Check the Codex CLI, the ChatGPT sign-in, the service and the Windows sandbox.",
  example: "pelican doctor",
  async run() {
    const { doctor } = await import("./doctor.js");
    const checks = await doctor(await loadConfig());
    return {
      data: checks,
      text: format.doctor(checks, ctx.paint),
      code: checks.some((c) => c.ok === false) ? 1 : 0,
    };
  },
});
command("mcp", {
  group: "Service",
  usage: "pelican mcp [--as <name>]",
  summary: "Run the MCP server on stdio (what `claude mcp add` launches).",
  example: "claude mcp add pelican -e PELICAN_AS=lead -- pelican mcp",
  async run(ctx) {
    if (ctx.values.as) process.env.PELICAN_AS = ctx.values.as;
    if (ctx.values.workspace)
      process.env.PELICAN_WORKSPACE = ctx.values.workspace;
    await import("./mcp.js");
    return null;
  },
});

// Workspaces
command("workspaces", {
  group: "Workspaces",
  usage: "pelican workspaces",
  summary: "List the workspaces with their folders and settings.",
  example: "pelican workspaces",
  async run(ctx) {
    const data = await ctx.client.workspaces();
    return { data, text: format.workspaces(data, ctx.paint) };
  },
});
command("workspace", {
  group: "Workspaces",
  usage:
    "pelican workspace add <folder> [--name <name>] | pelican workspace remove <workspace>",
  summary:
    "Add a workspace for a folder, or remove one that has no running agents.",
  example: "pelican workspace add E:\\GitHub\\project --name project",
  options: { name: { type: "string" } },
  async run(ctx) {
    const [action, target] = ctx.positionals;
    if (action === "add" && target) {
      const data = await ctx.client.addWorkspace(resolve(target), {
        ...(ctx.values.name ? { name: ctx.values.name } : {}),
      });
      return { data, text: format.added(data, ctx.paint) };
    }
    if (action === "remove" && target) {
      const data = await ctx.client.removeWorkspace(target);
      return { data, text: format.removed(data, ctx.paint) };
    }
    throw new UsageError(
      "Usage: pelican workspace add <folder> [--name <name>] | pelican workspace remove <workspace>",
    );
  },
});
command("settings", {
  group: "Workspaces",
  usage:
    "pelican settings [<workspace>] [--concurrency N] [--paused true|false] [--model m] [--effort e] [--network true|false]",
  summary: "Read or change a workspace's settings.",
  example: "pelican settings my-project-2694 --network true --concurrency 10",
  options: {
    concurrency: { type: "string" },
    paused: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    network: { type: "string" },
  },
  async run(ctx) {
    const v = ctx.values;
    const params = Object.fromEntries(
      Object.entries({
        workspace: ctx.positionals[0] ?? v.workspace,
        concurrency: integer(v.concurrency, "concurrency"),
        paused: bool(v.paused, "paused"),
        model: v.model,
        effort: v.effort,
        network: bool(v.network, "network"),
      }).filter(([, value]) => value !== undefined),
    );
    const data = await ctx.client.settings(params);
    return { data, text: format.settings(data, ctx.paint) };
  },
});

// Agents
command("spawn", {
  group: "Agents",
  usage:
    "pelican spawn [@brief.json] --prompt <text>|--prompt-file <file> [--name n] [--resource path]... [--read-only] [--model m] [--effort e] [--result-schema @schema.json] [--depends-on id]... [--priority n] [--cwd dir] [--wait [--timeout s]]",
  summary: "Start an agent. It returns at once; --wait waits for its result.",
  example:
    'pelican spawn --as lead --name "Fix login test" --prompt-file brief.md --resource test/login.test.js --result-schema @result.json',
  options: {
    ...briefOptions,
    wait: { type: "boolean" },
    timeout: { type: "string" },
  },
  async run(ctx) {
    const [file] = ctx.positionals;
    const base = file ? jsonValue(file, file) : {};
    const job = await ctx.client.spawn(brief(ctx.values, base));
    if (!ctx.values.wait)
      return { data: job, text: format.spawned(job, ctx.paint) };
    return waitFor(ctx, [job.id], {
      timeoutMs: seconds(ctx.values.timeout, "timeout"),
    });
  },
});
command("batch", {
  group: "Agents",
  usage: "pelican batch @jobs.json [--wait [--any] [--timeout s]]",
  summary:
    "Start several agents from a JSON array of briefs (dependsOn may name another's key).",
  example: "pelican batch @jobs.json --as lead",
  options: {
    wait: { type: "boolean" },
    any: { type: "boolean" },
    timeout: { type: "string" },
  },
  async run(ctx) {
    const [file] = ctx.positionals;
    if (!file) throw new UsageError("Usage: pelican batch @jobs.json");
    const parsed = jsonValue(file, file);
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
    for (const job of jobs ?? []) if (job.cwd) job.cwd = resolve(job.cwd);
    const created = await ctx.client.batch(jobs);
    if (!ctx.values.wait)
      return { data: created, text: format.spawned(created, ctx.paint) };
    return waitFor(
      ctx,
      created.map((j) => j.id),
      {
        any: ctx.values.any,
        timeoutMs: seconds(ctx.values.timeout, "timeout"),
      },
    );
  },
});
command("list", {
  group: "Agents",
  usage: "pelican list [--status s[,s]] [--owner name | --mine] [--limit n]",
  summary:
    "List agents, newest first (status: a status, or active, live, done).",
  example: "pelican list --status live --mine",
  options: {
    status: { type: "string", multiple: true },
    owner: { type: "string" },
    mine: { type: "boolean" },
    limit: { type: "string" },
  },
  async run(ctx) {
    const data = await ctx.client.list({
      ...(ctx.values.workspace ? { workspace: ctx.values.workspace } : {}),
      ...(ctx.values.status ? { status: words(ctx.values.status) } : {}),
      ...(owner(ctx) ? { owner: owner(ctx) } : {}),
      ...(ctx.values.limit
        ? { limit: integer(ctx.values.limit, "limit") }
        : {}),
    });
    return { data, text: format.list(data, ctx.paint) };
  },
});
command("get", {
  group: "Agents",
  usage: "pelican get <id>",
  summary:
    "One agent: status, model, tokens, resources, result, report, last activity, questions.",
  example: "pelican get 3f2a1b9c",
  async run(ctx) {
    const [id] = ctx.positionals;
    if (!id) throw new UsageError("Usage: pelican get <id>");
    const data = await ctx.client.get(id);
    return { data, text: format.get(data, ctx.paint) };
  },
});
command("tail", {
  group: "Agents",
  usage: "pelican tail <id> [--follow] [--after cursor] [--last n] [--full]",
  summary:
    "An agent's journal: its assignment, commands, edits, messages, questions and report (--full: its whole conversation, with reasoning, outputs and diffs in --json).",
  example: "pelican tail 3f2a1b9c --follow",
  options: {
    follow: { type: "boolean", short: "f" },
    after: { type: "string" },
    last: { type: "string" },
    full: { type: "boolean" },
  },
  async run(ctx) {
    const [id] = ctx.positionals;
    if (!id) throw new UsageError("Usage: pelican tail <id> [--follow]");
    let after = integer(ctx.values.after, "after") ?? 0;
    const last = integer(ctx.values.last, "last");
    let first = true;
    await follow(
      ctx,
      async () => {
        const page = await ctx.client.tail(id, {
          after,
          ...(first && last ? { last } : {}),
          ...(!first ? { timeoutMs: 30000 } : {}),
          ...(ctx.values.full ? { full: true } : {}),
        });
        first = false;
        after = page.cursor;
        return page;
      },
      (page) => {
        if (ctx.json) ctx.print(JSON.stringify(page));
        else if (page.lines.length) ctx.print(format.tail(page, ctx.paint));
      },
      (page) => !ctx.values.follow || (page.done && !page.lines.length),
    );
    return null;
  },
});
command("wait", {
  group: "Agents",
  usage: "pelican wait <id>... [--any] [--timeout s]",
  summary:
    "Wait until the agents are done (or one asks a question); print status and result. Exit 0 done, 2 timeout, 3 question.",
  example: "pelican wait 3f2a1b9c --timeout 1800",
  options: { any: { type: "boolean" }, timeout: { type: "string" } },
  async run(ctx) {
    if (!ctx.positionals.length)
      throw new UsageError("Usage: pelican wait <id>... [--any] [--timeout s]");
    return waitFor(ctx, ctx.positionals, {
      any: ctx.values.any,
      timeoutMs: seconds(ctx.values.timeout, "timeout"),
    });
  },
});
command("message", {
  group: "Agents",
  usage:
    "pelican message <id> <text...> [--file f] [--mode steer|followup] [--takeover]",
  summary:
    "Message an agent: steer its running turn now, or a followup after it.",
  example: 'pelican message 3f2a1b9c "Use port 4319 for the test server"',
  options: {
    mode: { type: "string" },
    file: { type: "string" },
    takeover: { type: "boolean" },
  },
  async run(ctx) {
    const [id, ...rest] = ctx.positionals;
    const text =
      ctx.values.file !== undefined
        ? readFileSync(resolve(ctx.values.file), "utf8")
        : rest.join(" ");
    if (!id || !text.trim())
      throw new UsageError("Usage: pelican message <id> <text...>");
    const data = await ctx.client.message(id, text, {
      ...(ctx.values.mode ? { mode: ctx.values.mode } : {}),
      ...(ctx.values.takeover ? { takeover: true } : {}),
    });
    return { data, text: format.message(data, ctx.paint) };
  },
});
command("resume", {
  group: "Agents",
  usage:
    "pelican resume <id> [--prompt text | --prompt-file f] [--model m] [--effort e] [--takeover]",
  summary:
    "Give a finished agent its next assignment in the same conversation.",
  example:
    'pelican resume 3f2a1b9c --prompt "The review found two issues: ..."',
  options: {
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    takeover: { type: "boolean" },
  },
  async run(ctx) {
    const [id] = ctx.positionals;
    if (!id) throw new UsageError("Usage: pelican resume <id> [--prompt text]");
    const text = prompt(ctx.values);
    const data = await ctx.client.resume(id, {
      ...(text !== undefined ? { prompt: text } : {}),
      ...(ctx.values.model ? { model: ctx.values.model } : {}),
      ...(ctx.values.effort ? { effort: ctx.values.effort } : {}),
      ...(ctx.values.takeover ? { takeover: true } : {}),
    });
    return { data, text: format.resumed(data, ctx.paint) };
  },
});
command("answer", {
  group: "Agents",
  usage: "pelican answer <id> <requestId> <answer...> [--takeover]",
  summary:
    "Answer an agent's question (text), or an approval (a decision such as accept or decline).",
  example: "pelican answer 3f2a1b9c 9d0e1f2a Use SQLite",
  options: { takeover: { type: "boolean" } },
  async run(ctx) {
    const [id, requestId, ...rest] = ctx.positionals;
    let answer = fromFile(rest.join(" "));
    if (!id || !requestId || !answer?.trim())
      throw new UsageError(
        "Usage: pelican answer <id> <requestId> <answer...>",
      );
    if (/^\s*\{/.test(answer)) answer = jsonValue(answer, "The answer");
    const data = await ctx.client.answer(
      id,
      requestId,
      answer,
      ctx.values.takeover ? { takeover: true } : {},
    );
    return { data, text: format.answered(data, ctx.paint) };
  },
});
command("questions", {
  group: "Agents",
  usage: "pelican questions [--owner name | --mine]",
  summary:
    "Every pending question and approval, with the orchestrator it waits for.",
  example: "pelican questions --mine",
  options: { owner: { type: "string" }, mine: { type: "boolean" } },
  async run(ctx) {
    const data = await ctx.client.questions({
      ...(ctx.values.workspace ? { workspace: ctx.values.workspace } : {}),
      ...(owner(ctx) ? { owner: owner(ctx) } : {}),
    });
    return { data, text: format.questions(data, ctx.paint) };
  },
});
command("stop", {
  group: "Agents",
  usage:
    "pelican stop <id> [--reason text] [--force] | pelican stop --all [--owner name | --mine]",
  summary:
    "Stop an agent (its changes stay), or every running and queued agent.",
  example: 'pelican stop 3f2a1b9c --reason "Superseded"',
  options: {
    all: { type: "boolean" },
    owner: { type: "string" },
    mine: { type: "boolean" },
    reason: { type: "string" },
    force: { type: "boolean" },
  },
  async run(ctx) {
    const [id] = ctx.positionals;
    if (!id && !ctx.values.all)
      throw new UsageError("Usage: pelican stop <id> | pelican stop --all");
    const data = await ctx.client.stop({
      ...(id ? { id } : { all: true }),
      ...(ctx.values.workspace ? { workspace: ctx.values.workspace } : {}),
      ...(owner(ctx) ? { owner: owner(ctx) } : {}),
      ...(ctx.values.reason ? { reason: ctx.values.reason } : {}),
      ...(ctx.values.force ? { force: true } : {}),
    });
    return { data, text: format.stopped(data, ctx.paint) };
  },
});
command("events", {
  group: "Agents",
  usage:
    "pelican events [--follow] [--after cursor] [--last n] [--job id] [--owner name | --mine] [--raw]",
  summary:
    "A workspace's journal: spawns, finishes, questions, answers, messages, reports, settings.",
  example: "pelican events --follow --mine",
  options: {
    follow: { type: "boolean", short: "f" },
    after: { type: "string" },
    last: { type: "string" },
    job: { type: "string" },
    owner: { type: "string" },
    mine: { type: "boolean" },
    raw: { type: "boolean" },
  },
  async run(ctx) {
    const v = ctx.values;
    let after = integer(v.after, "after");
    const last = after === undefined ? (integer(v.last, "last") ?? 30) : 0;
    let first = true;
    const base = {
      ...(v.job ? { jobId: v.job } : {}),
      ...(owner(ctx) ? { owner: owner(ctx) } : {}),
      ...(v.raw ? { raw: true } : {}),
    };
    await follow(
      ctx,
      async () => {
        const page = await ctx.client.events({
          ...base,
          after: after ?? 0,
          ...(first && last ? { last } : {}),
          ...(!first ? { timeoutMs: 30000 } : {}),
        });
        first = false;
        after = page.cursor;
        return page;
      },
      (page) => {
        if (ctx.json) ctx.print(JSON.stringify(page));
        else if (page.events.length || !v.follow)
          ctx.print(format.events(page, ctx.paint));
      },
      () => !v.follow,
    );
    return null;
  },
});
command("models", {
  group: "Agents",
  usage: "pelican models",
  summary: "The models the signed-in account offers.",
  example: "pelican models",
  async run(ctx) {
    const data = await ctx.client.models();
    return { data, text: format.models(data, ctx.paint) };
  },
});

command("usage", {
  group: "Agents",
  usage: "pelican usage [--refresh]",
  summary:
    "The Codex account's usage limits: what is used of each window and when it resets (read every 30 minutes).",
  example: "pelican usage --refresh",
  options: { refresh: { type: "boolean" } },
  async run(ctx) {
    const data = await ctx.client.usage({
      refresh: Boolean(ctx.values.refresh),
    });
    return { data, text: format.usage(data, Date.now(), ctx.paint) };
  },
});

// Workflows: scripts that drive agents, run inside the service as you.
// Run waits exit 0 when the run completed, 1 when it failed, was stopped or
// interrupted, 2 on a timeout and 3 when one of its agents asks a question.
const runCode = (outcome) =>
  outcome.reason === "question"
    ? 3
    : outcome.reason === "timeout"
      ? 2
      : outcome.run.status === "completed"
        ? 0
        : 1;
async function waitForRun(ctx, id, timeoutMs) {
  const outcome = await ctx.client.waitRun(id, {
    timeoutMs: timeoutMs ?? Infinity,
  });
  return {
    data: outcome,
    text: format.runWait(outcome, ctx.paint),
    code: runCode(outcome),
  };
}
command("run", {
  group: "Workflows",
  usage:
    "pelican run <workflow.js> [--args JSON|@file] [--name n] [--cwd dir] [--wait [--timeout s]] | pelican run --resume <run> [<workflow.js>] [--args JSON|@file] [--takeover] [--wait [--timeout s]]",
  summary:
    "Run a workflow script in the service as you; prints the run id at once (--wait waits for its result).",
  example:
    "pelican run examples/owner-reviewer.js --as lead --args '@items.json'",
  options: {
    args: { type: "string" },
    name: { type: "string" },
    cwd: { type: "string" },
    resume: { type: "string" },
    takeover: { type: "boolean" },
    wait: { type: "boolean" },
    timeout: { type: "string" },
  },
  async run(ctx) {
    const v = ctx.values;
    const [file] = ctx.positionals;
    const args =
      v.args !== undefined ? { args: jsonValue(v.args, "--args") } : {};
    let row;
    if (v.resume) {
      if (v.name)
        throw new UsageError("--name names a new run, not a resumed one.");
      if (v.cwd)
        throw new UsageError(
          "--cwd sets a new run's folder; a resumed run keeps its own.",
        );
      row = await ctx.client.resumeRun(v.resume, {
        ...(file ? { file: resolve(file) } : {}),
        ...args,
        ...(v.takeover ? { takeover: true } : {}),
      });
    } else {
      if (!file)
        throw new UsageError(
          "Usage: pelican run <workflow.js> [--args JSON|@file] (or pelican run --resume <run>)",
        );
      row = await ctx.client.startRun({
        file: resolve(file),
        ...args,
        ...(v.name ? { name: v.name } : {}),
        ...(v.cwd ? { cwd: resolve(v.cwd) } : {}),
        ...(v.workspace ? { workspace: v.workspace } : {}),
      });
    }
    const started = (p) =>
      format.runStarted(row, { resumed: Boolean(v.resume) }, p);
    if (!v.wait) return { data: row, text: started(ctx.paint) };
    // This goes to stderr, whose paint may differ from stdout's.
    ctx.log(started(ctx.errorPaint));
    return waitForRun(ctx, row.id, seconds(v.timeout, "timeout"));
  },
});
command("runs", {
  group: "Workflows",
  usage: "pelican runs [--status s[,s]]",
  summary:
    "Workflow runs, newest first (status: running, completed, failed, stopped, interrupted).",
  example: "pelican runs --status running",
  options: { status: { type: "string", multiple: true } },
  async run(ctx) {
    const data = await ctx.client.runs({
      ...(ctx.values.workspace ? { workspace: ctx.values.workspace } : {}),
      ...(ctx.values.status ? { status: words(ctx.values.status) } : {}),
    });
    return { data, text: format.runs(data, ctx.paint) };
  },
});
command("run-status", {
  group: "Workflows",
  usage: "pelican run-status <run> [--follow]",
  summary:
    "One run: its phases and agent calls, recent log lines, open questions, result. --follow prints changes until it ends.",
  example: "pelican run-status 5e1c2d3f --follow",
  options: { follow: { type: "boolean", short: "f" } },
  async run(ctx) {
    const [id] = ctx.positionals;
    if (!id) throw new UsageError("Usage: pelican run-status <run> [--follow]");
    if (!ctx.values.follow) {
      const data = await ctx.client.getRun(id);
      return { data, text: format.run(data, undefined, ctx.paint) };
    }
    let after = 0,
      before = null;
    for (;;) {
      const outcome = await ctx.client.call("runs.wait", {
        id,
        after,
        timeoutMs: 30000,
      });
      after = outcome.version;
      if (ctx.json) ctx.print(JSON.stringify(outcome.run));
      else {
        const text = before
          ? format.runChanges(before, outcome.run, ctx.paint)
          : format.run(outcome.run, undefined, ctx.paint);
        if (text) ctx.print(text);
      }
      before = outcome.run;
      if (outcome.run.status !== "running") return null;
    }
  },
});
command("run-stop", {
  group: "Workflows",
  usage: "pelican run-stop <run> [--reason text]",
  summary:
    "Stop a run: the script ends and its live agents stop (their changes stay). pelican run --resume continues it.",
  example: 'pelican run-stop 5e1c2d3f --reason "Wrong branch"',
  options: { reason: { type: "string" } },
  async run(ctx) {
    const [id] = ctx.positionals;
    if (!id)
      throw new UsageError("Usage: pelican run-stop <run> [--reason text]");
    const data = await ctx.client.stopRun(
      id,
      ctx.values.reason ? { reason: ctx.values.reason } : {},
    );
    return { data, text: format.runStopped(data, ctx.paint) };
  },
});
command("run-wait", {
  group: "Workflows",
  usage: "pelican run-wait <run> [--timeout s]",
  summary:
    "Wait until a run ends (or one of its agents asks a question) and print its result. Exit 0 completed, 1 failed/stopped/interrupted, 2 timeout, 3 question.",
  example: "pelican run-wait 5e1c2d3f --timeout 3600",
  options: { timeout: { type: "string" } },
  async run(ctx) {
    const [id] = ctx.positionals;
    if (!id)
      throw new UsageError("Usage: pelican run-wait <run> [--timeout s]");
    return waitForRun(ctx, id, seconds(ctx.values.timeout, "timeout"));
  },
});
// Orchestrator timelines: notes an orchestrator journals for the people
// watching, and the timeline of what it said and did (the menu shows both).
command("note", {
  group: "Orchestrators",
  usage: "pelican note <text...> [--file f]",
  summary:
    "Journal a note from you (--as) for your timeline: what you are doing and why. People watch it in the menu; agents do not see it.",
  example:
    'pelican note --as lead "Two fixers on the login flake, then a reviewer"',
  options: { file: { type: "string" } },
  async run(ctx) {
    const text =
      ctx.values.file !== undefined
        ? readFileSync(resolve(ctx.values.file), "utf8")
        : ctx.positionals.join(" ");
    if (!text.trim()) throw new UsageError("Usage: pelican note <text...>");
    const data = await ctx.client.note(text, {
      ...(ctx.values.workspace ? { workspace: ctx.values.workspace } : {}),
    });
    return { data, text: format.noted(data, ctx.paint) };
  },
});
command("feed", {
  group: "Orchestrators",
  usage:
    "pelican feed [<orchestrator> | --all] [--follow] [--last n] [--after cursor]",
  summary:
    "An orchestrator's timeline (default: yours): its notes, what it did, and what its agents sent it.",
  example: "pelican feed lead --follow",
  options: {
    all: { type: "boolean" },
    follow: { type: "boolean", short: "f" },
    last: { type: "string" },
    after: { type: "string" },
  },
  async run(ctx) {
    const v = ctx.values;
    const [who] = ctx.positionals;
    let after = v.after;
    const last = after === undefined ? (integer(v.last, "last") ?? 30) : 0;
    let first = true;
    const base = {
      ...(v.all ? { all: true } : who ? { as: who } : {}),
      ...(v.workspace ? { workspace: v.workspace } : {}),
    };
    await follow(
      ctx,
      async () => {
        const page = await ctx.client.feed({
          ...base,
          ...(after !== undefined ? { after } : {}),
          ...(first && last ? { last } : {}),
          ...(!first ? { timeoutMs: 30000 } : {}),
        });
        first = false;
        after = page.cursor;
        return page;
      },
      (page) => {
        if (ctx.json) ctx.print(JSON.stringify(page));
        else if (page.entries.length) ctx.print(format.feed(page, ctx.paint));
        else if (!v.follow) ctx.print("Nothing in this timeline yet.");
      },
      () => !v.follow,
    );
    return null;
  },
});
// What needs an orchestrator, one line each, for anything that turns lines
// into notifications: a terminal, or a coding agent's line monitor (Claude
// Code's Monitor tool wakes its session on each line).
command("watch", {
  group: "Orchestrators",
  usage:
    "pelican watch [--notes] [--stall minutes] [--state file] [--for seconds]",
  summary:
    "Follow what needs you, one line each: your agents' questions, finishes, start-up crashes, restarts and stalls, your runs' results and log lines, and the service going away. Made for line monitors.",
  example: "pelican watch --as lead --state .pelican-watch",
  options: {
    notes: { type: "boolean" },
    stall: { type: "string" },
    state: { type: "string" },
    for: { type: "string" },
  },
  async run(ctx) {
    const v = ctx.values;
    const who = ctx.client.context?.as;
    if (!who)
      throw new UsageError(
        "Name yourself: pelican watch --as <name> (or PELICAN_AS).",
      );
    const stallMs = (integer(v.stall, "stall") ?? 20) * 60000;
    const stallEveryMs = Math.min(60000, Math.max(1000, stallMs / 4));
    const until =
      v.for === undefined ? Infinity : Date.now() + seconds(v.for, "for");
    // --state keeps the cursor, so a watch started again (a monitor re-armed)
    // first prints what happened while none was watching.
    const state = v.state ? resolve(v.state) : null;
    let after;
    if (state && existsSync(state))
      after = readFileSync(state, "utf8").trim() || undefined;
    const base = v.workspace ? { workspace: v.workspace } : {};
    const p = ctx.paint;
    const say = (text) =>
      ctx.print(`${p.muted(new Date().toISOString().slice(11, 19))} ${text}`);
    const quiet = new Set();
    let down = false,
      nextStallCheck = 0;
    say(
      `${p.pretty ? `${p.ok(p.g.dot)} ` : ""}${p.bold("Watching")} ${p.who(who)}${p.muted(`: questions, finishes, crashes, runs${v.notes ? ", notes" : ""} and agents quiet for ${stallMs / 60000} min`)}`,
    );
    while (Date.now() < until) {
      try {
        const page = await ctx.client.feed({
          ...base,
          ...(after === undefined
            ? { last: 1 }
            : {
                after,
                timeoutMs: Math.max(
                  0,
                  Math.min(
                    30000,
                    until - Date.now(),
                    nextStallCheck - Date.now(),
                  ),
                ),
              }),
        });
        if (down)
          say(
            p.ok(
              `${p.pretty ? `${p.g.dot} ` : ""}The Pelican service is reachable again.`,
            ),
          );
        down = false;
        if (after !== undefined)
          for (const entry of page.entries)
            if (
              format.watchTypes.has(entry.type) ||
              (v.notes && entry.type === "agent.message")
            )
              say(format.watchLine(entry, p));
        after = page.cursor;
        if (state) writeFileSync(state, after);
        if (Date.now() >= nextStallCheck) {
          nextStallCheck = Date.now() + stallEveryMs;
          const agents = await ctx.client.list({
            ...base,
            owner: who,
            status: ["running"],
          });
          for (const a of agents) {
            const idle = Date.now() - Date.parse(a.updatedAt);
            if (idle < stallMs) quiet.delete(a.id);
            else if (!quiet.has(a.id)) {
              quiet.add(a.id);
              say(format.watchQuiet(a, idle, p));
            }
          }
        }
      } catch (problem) {
        if (
          problem instanceof UsageError ||
          (problem.statusCode >= 400 && problem.statusCode < 500)
        )
          throw problem;
        if (!down)
          say(
            p.err(
              `${p.pretty ? `${p.g.cross} ` : ""}The Pelican service is unreachable: ${format.flat(problem.message, 300, p)}`,
            ),
          );
        down = true;
        await new Promise((done) =>
          setTimeout(done, Math.max(0, Math.min(5000, until - Date.now()))),
        );
      }
    }
    return null;
  },
});
command("metrics", {
  group: "Orchestrators",
  usage:
    "pelican metrics [-w workspace] [--owner name | --mine] [--minutes n] [--bucket seconds]",
  summary:
    "Activity over time: agents live, started, finished and failed, tokens, events and questions per time bucket, per workspace and per orchestrator.",
  example: "pelican metrics --minutes 120 --bucket 300",
  options: {
    owner: { type: "string" },
    mine: { type: "boolean" },
    minutes: { type: "string" },
    bucket: { type: "string" },
  },
  async run(ctx) {
    const v = ctx.values;
    const data = await ctx.client.metrics({
      ...(v.workspace ? { workspace: v.workspace } : {}),
      ...(owner(ctx) ? { owner: owner(ctx) } : {}),
      ...(v.minutes !== undefined
        ? { minutes: integer(v.minutes, "minutes") }
        : {}),
      ...(v.bucket !== undefined
        ? { bucketSeconds: integer(v.bucket, "bucket") }
        : {}),
    });
    return { data, text: format.metrics(data, ctx.paint) };
  },
});
// The terminal menu (src/menu/): `pelican` with no command opens it. Without
// a terminal (stdin and stdout), or with --json, it prints pelican status.
command("menu", {
  group: "Menu",
  usage: "pelican menu [--as name]",
  summary:
    "The terminal menu for watching and steering the fleet (also: pelican with no command). Without a terminal it prints pelican status.",
  example: "pelican --as ntanis",
  // The menu starts the service itself, once, when it opens (a visible
  // notice if that fails), and does not start it again if it stops.
  autostart: false,
  async run(ctx) {
    if (ctx.json || !process.stdin.isTTY || !process.stdout.isTTY)
      return commands.get("status").run(ctx);
    // React's production build: faster, and no development warnings. It is
    // picked when React first loads, so nothing the command line imports at
    // the start may load React (import menu/look.js, not menu/theme.js);
    // test/cli-load.test.js keeps it so.
    process.env.NODE_ENV ??= "production";
    const { menu } = await import("./menu/index.js");
    return menu(ctx);
  },
});
command("help", {
  group: "Help",
  usage: "pelican help [command]",
  summary: "This help, or one command's.",
  example: "pelican help spawn",
  async run(ctx) {
    return { data: null, text: help(ctx.positionals[0], ctx.paint) };
  },
});

export function help(name, p = plain) {
  if (name) {
    const entry = commands.get(name);
    if (!entry)
      throw new UsageError(`Unknown command: ${name}. Run pelican help.`);
    if (!p.pretty)
      return `${entry.usage}\n\n${entry.summary}\n\nExample:\n  ${entry.example}`;
    const cells = Math.min(p.columns, 100);
    return [
      wrap(entry.usage, cells, "  ")
        .map((line) => p.accent(line))
        .join("\n"),
      "",
      wrap(entry.summary, cells).join("\n"),
      "",
      p.muted("Example:"),
      `  ${p.accent(entry.example)}`,
    ].join("\n");
  }
  const groups = new Map();
  for (const [key, entry] of commands) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push([key, entry]);
  }
  const width = Math.max(...[...commands.keys()].map((k) => k.length));
  const intro =
    "pelican: run Codex agents for any orchestrator. Whoever calls it orchestrates.";
  const outro = "pelican help <command> shows its options and an example.";
  if (!p.pretty)
    return [
      intro,
      "",
      ...[...groups].flatMap(([group, list]) => [
        `${group}:`,
        ...list.map(
          ([key, entry]) => `  ${key.padEnd(width)}  ${entry.summary}`,
        ),
        "",
      ]),
      "Options for every command:",
      "  --as <name>         who you are; your agents' questions come back to you (or PELICAN_AS)",
      "  -w, --workspace <w> workspace id or name (or PELICAN_WORKSPACE; else the folder you are in)",
      "  --json              print the JSON result",
      "  --plain             print plain text without colour or marks (a pipe or NO_COLOR also does)",
      "",
      outro,
    ].join("\n");
  // On a terminal: the wordmark, then each group under a rule, with the
  // summaries wrapped under their column.
  const cells = Math.min(p.columns, 100);
  const rows = (items, pad) =>
    items.flatMap(([key, text]) => {
      const [first, ...rest] = wrap(text, Math.max(20, cells - pad - 4));
      return [
        `  ${p.accent(key.padEnd(pad))}  ${first}`,
        ...rest.map((line) => " ".repeat(pad + 4) + line),
      ];
    });
  const brand =
    p.columns >= wordmarkWidth + 4
      ? [
          ...logo.map((line) => p("brand bold", line)),
          "",
          p("accent bold", slogan),
          ...motto.map((line) => p.muted(line)),
          "",
        ]
      : [];
  return [
    ...brand,
    intro,
    "",
    ...[...groups].flatMap(([group, list]) => [
      p.rule(group, cells),
      ...rows(
        list.map(([key, entry]) => [key, entry.summary]),
        width,
      ),
      "",
    ]),
    p.rule("Options for every command", cells),
    ...rows(
      [
        [
          "--as <name>",
          "who you are; your agents' questions come back to you (or PELICAN_AS)",
        ],
        [
          "-w, --workspace <w>",
          "workspace id or name (or PELICAN_WORKSPACE; else the folder you are in)",
        ],
        ["--json", "print the JSON result"],
        [
          "--plain",
          "print plain text without colour or marks (a pipe or NO_COLOR also does)",
        ],
      ],
      20,
    ),
    "",
    p.muted(outro),
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const print = io.print ?? ((text) => process.stdout.write(`${text}\n`));
  const error = io.error ?? ((text) => process.stderr.write(`${text}\n`));
  // Colour and marks only where a person reads: an injected printer (tests,
  // embedding), a pipe or --plain gets the plain text.
  const off = argv.includes("--plain");
  const paint = off
    ? plain
    : (io.paint ??
      (io.print ? plain : detectPaint(process.stdout, process.env)));
  const errorPaint = off
    ? plain
    : (io.paint ??
      (io.error ? plain : detectPaint(process.stderr, process.env)));
  const fail = (text) =>
    error(
      errorPaint.pretty
        ? errorPaint.err(`${errorPaint.g.cross} ${text}`)
        : text,
    );
  let [name, ...rest] = argv;
  // No command (or only options, such as pelican --as ntanis) opens the menu,
  // which prints pelican status when there is no terminal.
  if (
    commands.has("menu") &&
    (!name || (name.startsWith("-") && name !== "--help" && name !== "-h"))
  )
    [name, rest] = ["menu", argv];
  else if (!name || name === "--help" || name === "-h") name = "help";
  const entry = commands.get(name);
  if (!entry) {
    fail(`pelican: unknown command ${name}. Run pelican help.`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...globalOptions, ...entry.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (problem) {
    fail(`pelican ${name}: ${problem.message}\nUsage: ${entry.usage}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    print(help(name, paint));
    return 0;
  }
  const ctx = {
    name,
    values,
    positionals,
    json: Boolean(values.json),
    paint: values.json ? plain : paint,
    errorPaint,
    print,
    log: (text) => {
      if (!values.json) error(text);
    },
    client:
      io.client ??
      connect({
        as: values.as ?? process.env.PELICAN_AS,
        workspace: values.workspace ?? process.env.PELICAN_WORKSPACE,
        cwd: process.cwd(),
        autostart: entry.autostart !== false,
      }),
  };
  try {
    const result = await entry.run(ctx);
    if (!result) return 0;
    if (ctx.json) print(JSON.stringify(result.data ?? null, null, 2));
    else if (result.text) print(result.text);
    return result.code ?? 0;
  } catch (problem) {
    if (ctx.json) print(JSON.stringify({ error: problem.message }, null, 2));
    fail(
      problem instanceof UsageError
        ? `pelican ${name}: ${problem.message}`
        : `pelican: ${problem.message}`,
    );
    return 1;
  }
}

// Run as a program (also through npm's bin shims), not when imported.
const self = fileURLToPath(import.meta.url);
let invoked = "";
try {
  invoked = realpathSync(process.argv[1] ?? "");
} catch {
  /* Not started from a file. */
}
// Commands that keep serving (start --foreground, mcp) stay alive afterwards.
if (invoked && realpathSync(self) === invoked) process.exitCode = await main();
