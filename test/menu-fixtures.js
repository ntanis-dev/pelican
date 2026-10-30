// Fixture data for the menu tests, in the gateway's JSON shapes, on a fixed
// clock. load() feeds them through the reducer as refresh answers would.
import { reduce } from "../src/menu/reducer.js";
import { initialState } from "../src/menu/state.js";
import { timelineEntry } from "../src/timeline.js";

export const now = Date.parse("2026-10-24T20:00:00.000Z");
export const at = (secondsAgo) =>
  new Date(now - secondsAgo * 1000).toISOString();

const settings = (extra = {}) => ({
  concurrency: 4,
  paused: false,
  model: "gpt-6.1-sol",
  effort: "high",
  network: false,
  ...extra,
});
export const status = {
  service: {
    pid: 4242,
    startedAt: at(3720),
    url: "http://127.0.0.1:4319",
    uptimeMs: 3720000,
  },
  totals: { agents: 4, working: 2, queued: 1, questions: 2 },
  workspaces: [
    {
      id: "demo-2694",
      name: "demo",
      folder: "E:\\GitHub\\demo",
      createdAt: at(86400 * 3),
      settings: settings({ concurrency: 10, network: true }),
      agents: 3,
      working: 2,
      queued: 1,
      questions: 2,
      finished: 0,
    },
    {
      id: "docs-1a2b",
      name: "docs",
      folder: "E:\\GitHub\\docs",
      createdAt: at(86400),
      settings: settings({ paused: true }),
      agents: 1,
      working: 0,
      queued: 0,
      questions: 0,
      finished: 1,
    },
  ],
};
export const account = {
  connected: true,
  account: { type: "chatgpt", plan: "pro" },
  login: null,
  error: null,
};

const row = (id, agentName, extra) => ({
  id,
  agentName,
  name: `Task of ${agentName}`,
  owner: "lead",
  workspace: "demo-2694",
  status: "running",
  model: "gpt-6.1-sol",
  effort: "high",
  tokens: 0,
  questions: 0,
  createdAt: at(600),
  updatedAt: at(5),
  finishedAt: null,
  latest: "",
  ...extra,
});
export const agents = [
  row("aaaa1111-0000-4000-8000-000000000001", "Amber Heron", {
    name: "Fix the flaky login test",
    tokens: 12345,
    questions: 1,
    status: "waiting",
    latest: "Which build should I test?",
  }),
  row("bbbb2222-0000-4000-8000-000000000002", "Cedar Wren", {
    name: "Review the parser",
    owner: "reviewer",
    effort: "medium",
    tokens: 2100000,
    latest: "$ npm test",
    createdAt: at(120),
  }),
  row("cccc3333-0000-4000-8000-000000000003", "Jade Finch", {
    name: "Write the changelog",
    status: "queued",
    createdAt: at(30),
    updatedAt: at(30),
  }),
  row("dddd4444-0000-4000-8000-000000000004", "Opal Lark", {
    name: "Index the docs",
    workspace: "docs-1a2b",
    owner: "menu",
    status: "completed",
    tokens: 800,
    createdAt: at(7200),
    updatedAt: at(3600),
    finishedAt: at(3600),
    latest: "All pages indexed.",
  }),
];

export const questions = [
  {
    jobId: agents[0].id,
    requestId: "q1111111-aaaa",
    agentName: "Amber Heron",
    name: agents[0].name,
    owner: "lead",
    workspace: "demo-2694",
    kind: "question",
    question:
      "Which build should I test, the release build or the debug build?",
    createdAt: at(90),
    sequence: 1,
  },
  {
    jobId: agents[1].id,
    requestId: "q2222222-bbbb",
    agentName: "Cedar Wren",
    name: agents[1].name,
    owner: "reviewer",
    workspace: "demo-2694",
    kind: "approval",
    question: "Permission to run a command\nCommand: curl https://example.com",
    decisions: ["accept", "decline"],
    createdAt: at(45),
    sequence: 2,
  },
];

export const detail = {
  ...agents[0],
  done: false,
  cwd: "E:\\GitHub\\demo",
  resources: ["test/login.test.js", "src/session.js"],
  dependsOn: [],
  priority: 0,
  network: true,
  attempts: 1,
  queuedAt: at(600),
  startedAt: at(590),
  prompt:
    "Find why test/login.test.js fails one run in ten and fix it.\nRun npm test three times; report the cause, the change and the runs.",
  setup: null,
  activity: {
    current: "",
    progress: "Reading src/session.js",
    plan: null,
    updatedAt: at(5),
  },
  questions: [{ ...questions[0] }],
  notes: [{ at: at(200), text: "The flake comes from a shared port." }],
  messages: [
    {
      id: "m1",
      from: "lead",
      mode: "steer",
      text: "Use port 4319 for the test server",
      createdAt: at(300),
      delivered: true,
      read: true,
    },
  ],
  usage: null,
  hasResultSchema: true,
  resultValid: null,
  resultError: null,
  result: null,
  report: null,
  summary: null,
  error: null,
};
// A long command and a long message: the command is one line when collapsed
// and whole when opened; the message wraps in the chat, never cut.
export const longCommand =
  "pnpm sweep example --minutes 10 --proxy http://127.0.0.1:8899 --out apps/example/.data/sweep-2026-10-24T19-55.json --verbose --keep-going";
export const longMessage =
  "Use port 4319 for the test server, and when you rerun the suite keep the three runs apart: report each run's exit code and its slowest test, then stop before you touch src/parser.js, because Cedar Wren owns it.";
// Amber Heron's journal as tail --full gives it: kinds, senders, details.
const line = (seq, secondsAgo, type, text, extra = {}) => ({
  seq,
  at: at(secondsAgo),
  type,
  text,
  ...extra,
});
export const fullTail = {
  id: agents[0].id,
  agentName: "Amber Heron",
  workspace: "demo-2694",
  status: "waiting",
  done: false,
  cursor: 11,
  lines: [
    line(
      1,
      600,
      "job.created",
      "Assignment from lead: Find why test/login.test.js fails",
      {
        kind: "brief",
        from: "lead",
        detail: detail.prompt,
      },
    ),
    line(2, 590, "job.started", "Started (gpt-6.1-sol, high, network on)", {
      kind: "status",
    }),
    line(3, 580, "item/completed", "Thinking: Look at the shared port first.", {
      kind: "reasoning",
      detail: "Look at the shared port first.",
    }),
    line(4, 500, "item/started", "$ npm test", { kind: "command", item: "c1" }),
    line(5, 480, "item/completed", "  exit 1, 20.0s", {
      kind: "command",
      item: "c1",
      command: "npm test",
      exitCode: 1,
      durationMs: 20000,
      status: "failed",
      detail: "not ok 1 login\n# fail 1\n",
    }),
    line(6, 300, "message.sent", `Message from lead (steer): ${longMessage}`, {
      kind: "message",
      from: "lead",
      mode: "steer",
      detail: longMessage,
    }),
    line(7, 240, "item/completed", "Edited src/session.js", {
      kind: "edit",
      item: "f1",
      detail: "update src/session.js\n-const port = 4319;\n+const port = 0;",
    }),
    line(8, 200, "item/started", `$ ${longCommand}`, {
      kind: "command",
      item: "c2",
    }),
    line(9, 140, "item/completed", "  exit 0, 58.2s", {
      kind: "command",
      item: "c2",
      command: longCommand,
      exitCode: 0,
      durationMs: 58200,
      status: "completed",
      detail: "example: 312 markets, 0 failures\nPASS\n",
    }),
    line(10, 100, "item/completed", "The flake comes from a shared port.", {
      kind: "agent",
      phase: "commentary",
      detail: "The flake comes from a shared port: two suites bind 4319.",
    }),
    line(
      11,
      90,
      "agent.question",
      "Asks lead (q1111111-aaaa): Which build should I test?",
      {
        kind: "question",
        to: "lead",
        detail:
          "Which build should I test, the release build or the debug build?",
      },
    ),
  ],
};
// The other agents: their brief, and what they did so far.
export function detailOf(id) {
  if (id === detail.id) return detail;
  // An agent the fixtures do not list looks like a finished one.
  const a = agents.find((x) => x.id === id) ?? {
    ...agents[3],
    id,
    agentName: `Agent ${id.slice(0, 4)}`,
  };
  const done = !["queued", "running", "waiting"].includes(a.status);
  return {
    ...a,
    done,
    cwd: "E:\\GitHub\\demo",
    resources: [],
    dependsOn: [],
    priority: 0,
    network: a.status === "queued" ? null : false,
    attempts: a.status === "queued" ? 0 : 1,
    queuedAt: a.createdAt,
    startedAt: a.status === "queued" ? null : a.createdAt,
    prompt: `${a.name}.`,
    setup: null,
    activity: {
      current: a.status === "running" ? a.latest : "",
      progress: "",
      plan: null,
    },
    questions: (a.questions ? questions : []).filter((q) => q.jobId === id),
    notes: [],
    messages: [],
    usage: null,
    hasResultSchema: false,
    resultValid: null,
    resultError: null,
    result: null,
    report: done ? a.latest : null,
    summary: done ? a.latest : null,
    error: null,
  };
}
export function tailOf(id) {
  if (id === fullTail.id) return fullTail;
  const a = agents.find((x) => x.id === id) ?? { ...agents[3], id };
  const lines = [
    line(1, 600, "job.created", `Assignment from ${a.owner}: ${a.name}`, {
      kind: "brief",
      from: a.owner,
      detail: `${a.name}.`,
    }),
  ];
  if (a.status !== "queued")
    lines.push(
      line(2, 590, "job.started", "Started (gpt-6.1-sol, high, network off)", {
        kind: "status",
      }),
    );
  if (a.status === "running")
    lines.push(
      line(3, 30, "item/started", "$ npm test", {
        kind: "command",
        item: "c1",
      }),
    );
  if (a.status === "completed")
    lines.push(
      line(3, 3600, "agent.report", `Report to ${a.owner}: ${a.latest}`, {
        kind: "report",
        to: a.owner,
        detail: a.latest,
      }),
      line(4, 3600, "job.finished", "Finished: completed", { kind: "status" }),
    );
  return {
    id,
    agentName: a.agentName,
    workspace: a.workspace,
    status: a.status,
    done: a.status === "completed",
    cursor: lines.at(-1).seq,
    lines,
  };
}

// Timelines (feed), made by the gateway's own entry builder.
const journal = (seq, secondsAgo, type, data, jobId = null) => ({
  seq,
  at: at(secondsAgo),
  jobId,
  type,
  data,
});
export const timeline = [
  journal(1, 700, "orchestrator.note", {
    by: "lead",
    owner: "lead",
    text: "Two fixers on the login flake, then a reviewer.",
  }),
  journal(
    3,
    600,
    "job.created",
    {
      agentName: "Amber Heron",
      by: "lead",
      owner: "lead",
      name: "Fix the flaky login test",
      prompt: detail.prompt,
    },
    agents[0].id,
  ),
  journal(
    6,
    300,
    "message.sent",
    {
      agentName: "Amber Heron",
      from: "lead",
      owner: "lead",
      mode: "steer",
      delivery: "steered",
      text: "Use port 4319 for the test server",
    },
    agents[0].id,
  ),
  journal(
    8,
    120,
    "job.created",
    {
      agentName: "Cedar Wren",
      by: "reviewer",
      owner: "reviewer",
      name: "Review the parser",
      prompt: "Review src/parser.js.",
    },
    agents[1].id,
  ),
  journal(10, 100, "orchestrator.note", {
    by: "reviewer",
    owner: "reviewer",
    text: "Reviewing the parser before the release.",
  }),
  journal(
    12,
    90,
    "agent.question",
    {
      agentName: "Amber Heron",
      owner: "lead",
      pending: [{ question: "Which build should I test?" }],
    },
    agents[0].id,
  ),
].map((e) => timelineEntry(e, "demo-2694"));

const event = (seq, secondsAgo, type, data, jobId = agents[0].id) => ({
  seq,
  at: at(secondsAgo),
  jobId,
  type,
  data,
});
export const events = {
  "demo-2694": {
    workspace: "demo-2694",
    cursor: 12,
    events: [
      event(3, 600, "job.created", {
        agentName: "Amber Heron",
        by: "lead",
        name: "Fix the flaky login test",
        owner: "lead",
      }),
      event(
        8,
        120,
        "job.created",
        {
          agentName: "Cedar Wren",
          by: "reviewer",
          name: "Review the parser",
          owner: "reviewer",
        },
        agents[1].id,
      ),
      event(12, 90, "agent.question", {
        agentName: "Amber Heron",
        owner: "lead",
        pending: [{ question: "Which build should I test?" }],
      }),
    ],
  },
  "docs-1a2b": {
    workspace: "docs-1a2b",
    cursor: 4,
    events: [
      event(
        4,
        3600,
        "job.finished",
        { agentName: "Opal Lark", status: "completed", owner: "menu" },
        agents[3].id,
      ),
    ],
  },
};

export const runs = [
  {
    id: "run11111-0000",
    name: "Fleet sweep",
    workspace: "demo-2694",
    owner: "lead",
    status: "running",
    startedAt: at(900),
    endedAt: null,
    agents: { total: 3, live: 2, done: 1, failed: 0 },
  },
  {
    id: "run22222-0000",
    name: "Nightly docs",
    workspace: "docs-1a2b",
    owner: "menu",
    status: "completed",
    startedAt: at(7200),
    endedAt: at(3600),
    agents: { total: 1, live: 0, done: 1, failed: 0 },
  },
];
export const run = {
  ...runs[0],
  phases: [
    {
      title: "Survey",
      agents: [
        { label: "Survey repo", jobId: agents[3].id, status: "completed" },
      ],
    },
    {
      title: "Fix",
      agents: [
        { label: "Fix login", jobId: agents[0].id, status: "waiting" },
        { label: "Review parser", jobId: agents[1].id, status: "running" },
      ],
    },
  ],
  log: [
    { at: at(900), text: "Phase Survey: 1 agent" },
    { at: at(600), text: "Phase Fix: 2 agents" },
  ],
  result: null,
  error: null,
  questions: [{ ...questions[0], label: "Fix login" }],
};

// The finished run in full.
export const finishedRunDetail = {
  ...runs[1],
  phases: [
    {
      title: "Index",
      agents: [
        { label: "Index the docs", jobId: agents[3].id, status: "completed" },
      ],
    },
  ],
  log: [{ at: at(7200), text: "Phase Index: 1 agent" }],
  result: "42 pages indexed",
  error: null,
  questions: [],
};

// Activity over the last hour (metrics), 60 buckets of a minute, made of
// fixed patterns.
const wave = (n, f) => Array.from({ length: 60 }, (_, i) => f(i));
const seriesOf = (shift, scale) => ({
  live: wave(60, (i) =>
    i < 20 ? 0 : Math.min(3, Math.floor(((i + shift) % 24) / 6)),
  ),
  started: wave(60, (i) => (i % (11 + shift) === 0 && i > 15 ? 1 : 0)),
  finished: wave(60, (i) => (i % (13 + shift) === 5 && i > 20 ? 1 : 0)),
  failed: wave(60, (i) => (i === 47 + shift ? 1 : 0)),
  tokens: wave(60, (i) =>
    i < 20 ? 0 : ((i * 37 + shift * 11) % 50) * 120 * scale,
  ),
  events: wave(60, (i) => (i < 18 ? 0 : (i * 7 + shift) % 9)),
  questions: wave(60, (i) => (i === 51 || i === 58 - shift ? 1 : 0)),
});
const sum = (list) => list.reduce((a, b) => a + b, 0);
const totalsOf = (series) => ({
  peak: Math.max(...series.live),
  started: sum(series.started),
  finished: sum(series.finished),
  failed: sum(series.failed),
  tokens: sum(series.tokens),
  events: sum(series.events),
  questions: sum(series.questions),
});
const bucketsFrom = now - 59 * 60000 - (now % 60000);
const demoSeries = seriesOf(0, 2);
const docsSeries = seriesOf(3, 0);
docsSeries.live = docsSeries.live.map((v, i) => (i > 40 && i < 50 ? 1 : 0));
// The service's last reading of the Codex usage limits.
export const usage = {
  at: at(12 * 60),
  error: null,
  plan: "pro",
  allowed: true,
  reached: null,
  credits: { unlimited: false, has: false, balance: null },
  limits: [
    {
      id: "codex",
      name: "codex",
      windows: [
        {
          usedPercent: 34.5,
          windowMinutes: 300,
          resetsAt: new Date(now + 130 * 60000).toISOString(),
        },
        {
          usedPercent: 91,
          windowMinutes: 10080,
          resetsAt: new Date(now + (3 * 24 + 4) * 3600000).toISOString(),
        },
      ],
    },
  ],
};
export const metrics = {
  from: new Date(bucketsFrom).toISOString(),
  to: new Date(now).toISOString(),
  bucketSeconds: 60,
  buckets: Array.from({ length: 60 }, (_, i) =>
    new Date(bucketsFrom + i * 60000).toISOString(),
  ),
  workspace: null,
  owner: null,
  series: demoSeries,
  totals: totalsOf(demoSeries),
  now: { working: 2, queued: 1, questions: 2, concurrency: 14 },
  workspaces: [
    {
      id: "demo-2694",
      name: "demo",
      series: demoSeries,
      totals: totalsOf(demoSeries),
      now: { working: 2, queued: 1, questions: 2, concurrency: 10 },
    },
    {
      id: "docs-1a2b",
      name: "docs",
      series: docsSeries,
      totals: totalsOf(docsSeries),
      now: { working: 0, queued: 0, questions: 0, concurrency: 4 },
    },
  ],
  owners: [
    { name: "lead", series: seriesOf(1, 1) },
    { name: "reviewer", series: seriesOf(5, 1) },
    { name: "menu", series: docsSeries },
  ].map((o) => ({
    ...o,
    totals: totalsOf(o.series),
    now: { working: 0, queued: 0, questions: 0, concurrency: 0 },
  })),
};

// The answer each refresh request gets, from the fixtures above.
export function answer(request) {
  switch (request.method) {
    case "status":
      return status;
    case "account":
      return account;
    case "questions":
      return questions;
    case "list":
      return agents;
    case "events": {
      const page = events[request.params.workspace];
      const after = request.params.after ?? 0;
      const list = page.events.filter((e) => e.seq > after);
      return { ...page, cursor: list.at(-1)?.seq ?? after, events: list };
    }
    case "runs.list":
      return runs;
    case "get":
      return detailOf(request.params.id);
    case "tail": {
      const page = tailOf(request.params.id);
      const after = request.params.after ?? 0;
      const lines = page.lines.filter((l) => l.seq > after);
      return { ...page, cursor: lines.at(-1)?.seq ?? after, lines };
    }
    case "runs.get":
      return request.params.id === run.id ? run : finishedRunDetail;
    case "metrics":
      return metrics;
    case "usage":
      return usage;
    case "feed": {
      // The cursor is "demo-2694:<seq>", as the gateway makes it.
      const after =
        Number(String(request.params.after ?? "").split(":")[1] ?? 0) || 0;
      const entries = timeline.filter(
        (e) =>
          e.seq > after && (request.params.all || e.by === request.params.as),
      );
      const last = entries.at(-1)?.seq ?? after;
      return {
        as: request.params.all ? null : request.params.as,
        cursor: `demo-2694:${last}`,
        entries,
      };
    }
    default:
      throw new Error(`No fixture for ${request.method}`);
  }
}

export const size = { cols: 100, rows: 30 };
export function fresh(extra = {}) {
  return initialState({
    as: "menu",
    url: "http://127.0.0.1:4319",
    size,
    now,
    ...extra,
  });
}
// Every request a refresh of this state would make, answered from the
// fixtures (status first, as the runtime does).
export function load(state, { needs, statusRequest }, overrides = {}) {
  const feed = (s, request) => {
    const result =
      request.method in overrides
        ? overrides[request.method](request)
        : answer(request);
    return result instanceof Error
      ? reduce(s, {
          type: "data",
          request,
          error: {
            message: result.message,
            statusCode: result.statusCode,
            code: result.code,
          },
        }).state
      : reduce(s, { type: "data", request, result }).state;
  };
  state = feed(state, statusRequest);
  for (const request of needs(state)) state = feed(state, request);
  return state;
}
