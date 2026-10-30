import { width } from "./menu/text.js";
import { plain } from "./paint.js";

// Readable text for the gateway's JSON results. --json prints the JSON
// instead; the terminal menu can reuse these.
//
// Every formatter takes an optional paint (paint.js) last. The plain paint,
// the default, returns the text as it always was; the paint of a terminal
// adds colour, glyphs and a calmer layout, and cleans agent-written text of
// control sequences.
export const short = (id) => String(id ?? "").slice(0, 8);
const one = (text, limit = 100, p = plain) => {
  const line = p.safe(text).replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const indent = (text, pad = "    ", p = plain) =>
  p
    .safe(text)
    .split(/\r?\n/)
    .map((line) => pad + line)
    .join("\n");
export function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const duration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.round(s / 60)}m`
      : `${(s / 3600).toFixed(1)}h`;
};
const tokens = (n) =>
  !n
    ? "0"
    : n < 1000
      ? String(n)
      : n < 1e6
        ? `${(n / 1000).toFixed(1)}k`
        : `${(n / 1e6).toFixed(2)}M`;
const time = (iso) => String(iso ?? "").slice(11, 19);
const dot = (p) => p.muted(" · ");
// Columns are { title, value(row), paint?(cell, row) }: values are measured
// and padded as plain text, and painted after, so colour never skews them.
function table(rows, columns, p = plain) {
  if (!rows.length) return "";
  const len = p.pretty ? width : (text) => text.length;
  const cells = rows.map((r) => columns.map((c) => p.safe(c.value(r))));
  const widths = columns.map((c, i) =>
    Math.max(len(c.title), ...cells.map((row) => len(row[i]))),
  );
  const line = (texts, paint) =>
    texts
      .map((text, i) => {
        const body = paint(text, i);
        return i === texts.length - 1
          ? body
          : body + " ".repeat(Math.max(0, widths[i] - len(text)));
      })
      .join("  ")
      .trimEnd();
  return [
    line(
      columns.map((c) => c.title),
      (text) => p("muted bold", text),
    ),
    ...cells.map((row, r) =>
      line(row, (text, i) => columns[i].paint?.(text, rows[r]) ?? text),
    ),
  ].join("\n");
}
const json = (value) => JSON.stringify(value, null, 2);
const settingsLine = (s, p = plain) =>
  p.pretty
    ? [
        ["concurrency", s.concurrency, ""],
        ["paused", s.paused, s.paused ? "warn" : ""],
        ["model", s.model, ""],
        ["effort", s.effort, ""],
        ["network", s.network, s.network ? "ok" : ""],
      ]
        .map(([key, value, role]) => `${p.muted(key)} ${p(role, value)}`)
        .join(dot(p))
    : `concurrency ${s.concurrency}, paused ${s.paused}, model ${s.model}, effort ${s.effort}, network ${s.network}`;
// "2 working · 1 queued · 1 question · 14 agents", the numbers lit when not 0.
const counts = (p, c) =>
  [
    `${p.num(c.working)} working`,
    `${p.num(c.queued, "info")} queued`,
    `${p.num(c.questions, "warn")} ${c.questions === 1 ? "question" : "questions"}`,
    `${p.muted(c.agents)} agents`,
  ].join(dot(p));
// A labelled row: "  task      Fix it" on a terminal, "  task: Fix it" otherwise.
const row = (p, label, value, shorter = label) =>
  p.pretty
    ? `  ${p.muted(shorter.padEnd(10))} ${value}`
    : `  ${label}: ${value}`;
const asking = (a) =>
  Array.isArray(a.questions) ? a.questions.length : Number(a.questions) || 0;

export function status(s, p = plain) {
  const lines = p.pretty
    ? [
        `${p.ok(p.g.dot)} ${p.bold("Pelican is running")}  ${p.muted(`process ${s.service.pid}${s.service.url ? ` · ${s.service.url}` : ""} · up ${duration(s.service.uptimeMs)}${s.service.idleMinutes ? ` · exits after ${s.service.idleMinutes} min idle` : ""}`)}`,
        `  ${counts(p, s.totals)}`,
      ]
    : [
        `Pelican is running: process ${s.service.pid}${s.service.url ? ` at ${s.service.url}` : ""}, up ${duration(s.service.uptimeMs)}${s.service.idleMinutes ? `; it exits after ${s.service.idleMinutes} min with nothing running or asked for` : ""}.`,
        `${s.totals.working} working, ${s.totals.queued} queued, ${s.totals.questions} open question${s.totals.questions === 1 ? "" : "s"}, ${s.totals.agents} agents in all.`,
      ];
  if (!s.workspaces.length)
    lines.push(
      p.pretty
        ? p.muted("No workspaces yet: pelican workspace add <folder>")
        : "No workspaces yet: pelican workspace add <folder>",
    );
  for (const w of s.workspaces)
    lines.push(
      "",
      p.pretty
        ? `${p.bold(w.id)}  ${p.muted(w.folder)}`
        : `${w.id}  ${w.folder}`,
      `  ${settingsLine(w.settings, p)}`,
      p.pretty
        ? `  ${counts(p, w)}`
        : `  ${w.working} working, ${w.queued} queued, ${w.questions} questions, ${w.agents} agents`,
    );
  return lines.join("\n");
}
export function workspaces(list, p = plain) {
  if (!list.length)
    return p.muted("No workspaces yet: pelican workspace add <folder>");
  return list
    .map((w) =>
      p.pretty
        ? `${p.bold(w.id)} ${p.muted(`(${w.name})`)}  ${p.muted(w.folder)}\n  ${settingsLine(w.settings, p)}\n  ${counts(p, w)}`
        : `${w.id} (${w.name})  ${w.folder}\n  ${settingsLine(w.settings)}\n  ${w.working} working, ${w.queued} queued, ${w.questions} questions, ${w.agents} agents`,
    )
    .join(p.pretty ? "\n\n" : "\n");
}
export const added = (w, p = plain) =>
  `${p.check(`Added workspace ${p.bold(w.id)} for ${p.muted(w.folder)}.`)}\n  ${settingsLine(w.settings, p)}${w.overlaps?.length ? `\n  ${p.warn(`Its folder overlaps ${w.overlaps.join(", ")}; agents in different workspaces do not share path reservations.`)}` : ""}`;
export const removed = (r, p = plain) =>
  p.check(
    `Removed workspace ${p.bold(r.removed)} (${r.folder}). ${r.data.removed ? `Its data was deleted (${r.data.removed}).` : `Its data stays in ${r.data.kept}.`}`,
  );
export const settings = (s, p = plain) =>
  p.pretty
    ? `${p.bold(s.workspace)} ${p.muted(`(${s.folder})`)}\n  ${settingsLine(s.settings, p)}`
    : `${s.workspace} (${s.folder})\n  ${settingsLine(s.settings)}`;
const agentLine = (a, p = plain) =>
  p.pretty
    ? `${p.bold(a.agentName)} ${p.muted(`(${short(a.id)})`)} ${p.status(a.status, asking(a))}  ${p.muted("owner")} ${p.who(a.owner)} ${p.muted(`in ${a.workspace}`)}`
    : `${a.agentName} (${short(a.id)}) in ${a.workspace}: ${a.status}, owner ${a.owner}`;
export function spawned(rows, p = plain) {
  const list = [rows].flat();
  const follow = `pelican wait ${list.map((a) => short(a.id)).join(" ")}`;
  return `${list.map((a) => p.check(`Spawned ${agentLine(a, p)}`)).join("\n")}\n${p.muted(`Wait for ${list.length === 1 ? "it" : "them"}:`)} ${p.accent(follow)}`;
}
export function list(rows, p = plain) {
  if (!rows.length) return p.muted("No agents.");
  return table(
    rows,
    [
      { title: "ID", value: (r) => short(r.id), paint: (c) => p.muted(c) },
      {
        title: "STATUS",
        value: (r) => p.statusText(r.status, r.questions),
        paint: (c, r) => p(p.statusStyle(r.status, r.questions), c),
      },
      {
        title: "AGENT",
        value: (r) => r.agentName,
        paint: (c) => p.bold(c),
      },
      { title: "OWNER", value: (r) => r.owner, paint: (c) => p.who(c) },
      {
        title: "WORKSPACE",
        value: (r) => r.workspace,
        paint: (c) => p.muted(c),
      },
      {
        title: "TOKENS",
        value: (r) => tokens(r.tokens),
        paint: (c) => p.muted(c),
      },
      {
        title: "UPDATED",
        value: (r) => ago(r.updatedAt),
        paint: (c) => p.muted(c),
      },
      { title: "TASK", value: (r) => one(r.name, 60, p) },
    ],
    p,
  );
}
const decisionText = (d) => (typeof d === "string" ? d : JSON.stringify(d));
function questionsBlock(questions, p = plain) {
  return questions
    .map((q) => {
      const answer = `pelican answer ${short(q.jobId)} ${short(q.requestId)} <answer>`;
      return p.pretty
        ? `  ${p.warn(p.g.diamond)} ${p("warn bold", q.kind)} ${p.muted(q.requestId)}${q.decisions ? p.muted(` (decisions: ${q.decisions.map(decisionText).join(", ")})`) : ""}\n${indent(q.question, "    ", p)}\n    ${p.muted("answer:")} ${p.accent(answer)}`
        : `  ${q.kind} ${q.requestId}${q.decisions ? ` (decisions: ${q.decisions.map(decisionText).join(", ")})` : ""}\n${indent(q.question, "    ")}\n    answer: ${answer}`;
    })
    .join("\n");
}
// A block of text under a heading: "  report:" then the text indented.
const section = (p, title, body, role = "accent") =>
  p.pretty
    ? `  ${p(`${role} bold`, title)}\n${indent(body, "    ", p)}`
    : `  ${title}:\n${indent(body)}`;
function handedBack(a, p = plain) {
  const parts = [];
  if (a.error)
    parts.push(
      p.pretty ? section(p, "error", a.error, "err") : `  error: ${a.error}`,
    );
  if (a.result !== null && a.result !== undefined)
    parts.push(section(p, "result", json(a.result)));
  if (a.report) parts.push(section(p, "report", a.report));
  if (a.summary && a.summary !== a.report)
    parts.push(section(p, "summary", a.summary));
  return parts.join("\n");
}
export function get(d, p = plain) {
  const network = d.network === null ? "not started" : d.network ? "on" : "off";
  const lines = [
    p.pretty
      ? `${p.bold(d.agentName)} ${p.muted(d.id)}`
      : `${d.agentName} (${d.id})`,
    row(p, "task", p.safe(d.name)),
    row(
      p,
      "status",
      p.pretty
        ? `${p.status(d.status, d.questions.length)}${dot(p)}owner ${p.who(d.owner)}${dot(p)}workspace ${d.workspace}`
        : `${d.status}${d.done ? " (done)" : ""}, owner ${d.owner}, workspace ${d.workspace}`,
    ),
    row(
      p,
      "model",
      p.pretty
        ? `${d.model} (${d.effort})${dot(p)}network ${network}${dot(p)}${tokens(d.tokens)} tokens${dot(p)}attempt ${d.attempts}`
        : `${d.model} (${d.effort}), network ${network}, ${tokens(d.tokens)} tokens, attempt ${d.attempts}`,
    ),
    row(p, "cwd", p.safe(d.cwd)),
    row(
      p,
      "reserves",
      d.resources.length
        ? p.safe(d.resources.join(", "))
        : "nothing (read-only)",
    ),
  ];
  if (d.dependsOn.length)
    lines.push(row(p, "depends on", d.dependsOn.map(short).join(", ")));
  if (d.setup?.status && d.setup.status !== "ready")
    lines.push(
      row(p, "sandbox setup", p.warn(p.safe(d.setup.message)), "sandbox"),
    );
  if (d.activity.current)
    lines.push(row(p, "now", one(d.activity.current, 200, p)));
  else if (d.activity.progress)
    lines.push(row(p, "latest", one(d.activity.progress, 200, p)));
  lines.push(row(p, "updated", ago(d.updatedAt)));
  if (d.questions.length)
    lines.push(
      p.pretty
        ? p("warn bold", "  waiting for an answer")
        : "  waiting for an answer:",
      questionsBlock(d.questions, p),
    );
  if (d.notes.length)
    lines.push(
      p.pretty ? p("note bold", "  notes") : "  notes:",
      ...d.notes
        .slice(-5)
        .map((n) => `    ${p.muted(time(n.at))} ${one(n.text, 200, p)}`),
    );
  if (d.hasResultSchema)
    lines.push(
      row(
        p,
        "result",
        d.resultValid
          ? p.ok("valid")
          : d.resultError
            ? p.err(`rejected: ${one(d.resultError, 300, p)}`)
            : p.muted("not given yet"),
      ),
    );
  const back = handedBack(d, p);
  if (back) lines.push(back);
  return lines.join("\n");
}
export function wait(outcome, p = plain) {
  const head =
    outcome.reason === "done"
      ? p.pretty
        ? p.check("Done.")
        : "Done."
      : outcome.reason === "question"
        ? p.pretty
          ? p.warn(`${p.g.diamond} An agent is waiting for an answer.`)
          : "An agent is waiting for an answer."
        : p.pretty
          ? p.muted(`${p.g.ring} Still working (timed out).`)
          : "Still working (timed out).";
  return [
    head,
    ...outcome.agents.map((a) =>
      [
        `${agentLine(a, p)}${a.done ? "" : p.muted(" (not done)")}`,
        handedBack(a, p),
        a.questions.length ? questionsBlock(a.questions, p) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}
export const message = (m, p = plain) =>
  p.check(
    `Message ${short(m.messageId)} to ${p.bold(m.agent.agentName)}: ${
      {
        steered: "steered into its running turn.",
        followup: "queued as its next assignment after this turn.",
        pending: "delivered when its turn starts.",
        queued: "added to its queued brief.",
        resumed: "it was finished, so this is its new assignment.",
      }[m.delivery] ?? m.delivery
    }`,
  );
export const resumed = (a, p = plain) => p.check(`Resumed ${agentLine(a, p)}`);
export const answered = (a, p = plain) =>
  p.check(
    `Answered ${short(a.answered)}; ${p.bold(a.agent.agentName)} is ${p.status(a.agent.status)}.`,
  );
export function questions(list, p = plain) {
  if (!list.length) return p.muted("No open questions.");
  const owners = [...new Set(list.map((q) => q.owner))];
  return owners
    .map(
      (owner) =>
        `${p.pretty ? `${p.muted("For")} ${p.who(owner)}` : `For ${owner}`}:\n${list
          .filter((q) => q.owner === owner)
          .map((q) => {
            const decisions = q.decisions
              ? ` [${q.decisions.map(decisionText).join(" | ")}]`
              : "";
            return p.pretty
              ? `  ${p.warn(p.g.diamond)} ${p.bold(q.agentName)} ${p.muted(`(${short(q.jobId)}) in ${q.workspace}, ${ago(q.createdAt)}:`)} ${q.kind} ${p.muted(q.requestId)}${p.muted(decisions)}\n${indent(q.question, "    ", p)}\n    ${p.muted("answer:")} ${p.accent(`pelican answer ${short(q.jobId)} ${short(q.requestId)} <answer>`)}`
              : `  ${q.agentName} (${short(q.jobId)}) in ${q.workspace}, ${ago(q.createdAt)}: ${q.kind} ${q.requestId}${decisions}\n${indent(q.question, "    ")}`;
          })
          .join("\n")}`,
    )
    .join("\n");
}
export function stopped(s, p = plain) {
  const lines = [
    ...(s.runs ?? []).map(
      (r) =>
        `${p.pretty ? `${p.muted(p.g.square)} ` : ""}Stopped run ${p.bold(r.name)} (${short(r.id)}) in ${r.workspace}`,
    ),
    ...s.stopped.map(
      (a) =>
        `${p.pretty ? `${p.muted(p.g.square)} ` : ""}Stopped ${agentLine(a, p)}`,
    ),
  ];
  return lines.length ? lines.join("\n") : p.muted("Nothing to stop.");
}
// How an event looks on a terminal: a mark and the style it is drawn in.
function eventMark(e, p) {
  const g = p.g,
    d = e.data ?? {};
  switch (e.type) {
    case "agent.question":
      return [g.diamond, "warn bold"];
    case "agent.answered":
      return [g.check, "ok"];
    case "agent.message":
      return [g.bullet, "note"];
    case "agent.report":
      return [g.bullet, "info"];
    case "message.sent":
      return [g.arrow, "hot"];
    case "job.finished":
    case "run.finished":
      return p.mark(d.status);
    case "job.created":
      return [g.ring, "muted"];
    default:
      return e.type.startsWith("run.") || e.type === "settings.updated"
        ? [g.events, "stop"]
        : [g.bullet, "muted"];
  }
}
const eventText = (e, p = plain) => {
  const d = e.data ?? {};
  const who = d.agentName
    ? `${p.bold(d.agentName)} ${p.muted(`(${short(e.jobId)})`)}`
    : "";
  const run = () => `run ${p.bold(d.name)} ${p.muted(`(${short(d.runId)})`)}`;
  switch (e.type) {
    case "agent.question":
      return `${who} asks ${p.who(d.owner)}: ${one(d.pending?.[0]?.question, 200, p)}`;
    case "agent.answered":
      return `${who} answered by ${p.who(d.by)}`;
    case "agent.message":
      return `${who} to ${p.who(d.owner)}: ${one(d.message, 200, p)}`;
    case "agent.report":
      return `${who} reported${d.resultValid === false && d.resultError ? " (result rejected)" : ""}: ${one(d.report, 200, p)}`;
    case "message.sent":
      return `${p.who(d.from)} to ${who} (${d.mode}, ${d.delivery}): ${one(d.text, 160, p)}`;
    case "settings.updated": {
      // Entries from before per-workspace settings carry the settings flat.
      const changes =
        d.changes ??
        Object.fromEntries(
          Object.entries(d).filter(([k]) =>
            ["concurrency", "paused", "model", "effort", "network"].includes(k),
          ),
        );
      const by =
        d.by ?? (d.actor?.role === "coordinator" ? "human" : d.actor?.role);
      return `settings changed${by ? ` by ${p.who(by)}` : ""}: ${Object.entries(
        changes,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`;
    }
    case "job.created":
      return `${who} spawned by ${p.who(d.by)}: ${one(d.name, 120, p)}`;
    case "job.finished":
      return `${who} ${p(p.statusStyle(d.status), d.status)}${d.error ? `: ${one(d.error, 160, p)}` : ""}`;
    case "run.started":
      return `${run()} started by ${p.who(d.by)}`;
    case "run.resumed":
      return `${run()} resumed by ${p.who(d.by)}, ${d.replayable} result(s) can replay`;
    case "run.stopped":
      return `${run()} stopped by ${p.who(d.by)}${d.reason ? `: ${one(d.reason, 160, p)}` : ""}`;
    case "run.finished":
      return `${run()} ${p(p.statusStyle(d.status), d.status)}${d.error ? `: ${one(d.error, 160, p)}` : ""}`;
    case "run.agent":
      return `${run()} ${d.continued ? "continues" : "starts"} ${p.bold(d.agentName)} ${p.muted(`(${short(d.jobId)})`)} for ${one(d.label, 80, p)}`;
    case "run.note":
      return `${run()}: ${one(d.text, 200, p)}`;
    default:
      return `${who} ${e.type}${d.status ? ` (${d.status})` : ""}${d.message ? `: ${one(d.message, 160, p)}` : ""}`;
  }
};
export const events = (page, p = plain) =>
  page.events.length
    ? page.events
        .map((e) => {
          const [icon, style] = p.pretty ? eventMark(e, p) : [];
          return `${p.muted(time(e.at))} ${p.muted(`#${e.seq}`)} ${p.pretty ? `${p(style, icon)} ` : ""}${eventText(e, p)}`;
        })
        .join("\n")
    : p.muted(`No new events after ${page.cursor}.`);
// What a journal line's label is drawn in, by the entry it came from.
const tailTone = {
  "job.created": "accent bold",
  "job.resumed": "accent bold",
  "job.retrying": "warn",
  "job.throttled": "warn",
  "job.overloaded": "warn",
  "job.restarting": "warn",
  "job.started": "muted",
  "job.cancelled": "muted",
  "job.stopRequested": "warn",
  "job.recovered": "info",
  "job.owner": "muted",
  "agent.question": "warn bold",
  "agent.answered": "ok",
  "agent.message": "note",
  "agent.report": "info bold",
  "message.sent": "hot",
  "questions.expired": "muted",
  warning: "warn",
  "scheduler.error": "err",
};
// The label of "Label: text" in a tone, the rest as it is.
const labelled = (p, tone, text) => {
  const i = text.indexOf(": ");
  return i > 0
    ? `${p(tone, text.slice(0, i + 1))}${text.slice(i + 1)}`
    : p(tone, text);
};
function tailText(l, p) {
  const text = p.safe(l.text);
  if (l.type === "item/started")
    return `${p.muted("$")} ${p.bold(text.replace(/^\$ /, ""))}`;
  if (l.type === "item/completed") {
    const exit = /^\s*exit (\S+?)\b/.exec(text);
    if (exit) return p(exit[1] === "0" ? "ok" : "err", text);
    if (text.startsWith("Edited "))
      return `${p.info("Edited")}${text.slice(6)}`;
    return labelled(p, "muted bold", text);
  }
  if (l.type === "job.finished") {
    const status = /^Finished: (\w+)/.exec(text)?.[1];
    return p(p.statusStyle(status), text);
  }
  const tone = tailTone[l.type];
  return tone ? labelled(p, tone, text) : text;
}
export const tail = (page, p = plain) =>
  page.lines
    .map((l) => `${p.muted(time(l.at))} ${p.pretty ? tailText(l, p) : l.text}`)
    .join("\n");
// The usage limits: a bar per window, what is used and when it resets.
export const windowName = (minutes) =>
  minutes === 10080
    ? "weekly"
    : !minutes
      ? "window"
      : minutes % 1440 === 0
        ? `${minutes / 1440}d`
        : minutes % 60 === 0
          ? `${minutes / 60}h`
          : `${minutes}m`;
export const resetsIn = (iso, now = Date.now()) => {
  const minutes = Math.round((Date.parse(iso) - now) / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes <= 0) return "resetting now";
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60);
  return `resets in ${
    days
      ? `${days}d${hours ? ` ${hours}h` : ""}`
      : hours
        ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
        : `${minutes}m`
  }`;
};
// A credit balance as Codex sends it ("21870.7527170000") to "21,870.75".
export const creditBalance = (balance) => {
  const n = Number(balance);
  return balance === null || balance === undefined || !Number.isFinite(n)
    ? "?"
    : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};
export function usage(u, now = Date.now(), p = plain) {
  if (!u.at && !u.limits.length)
    return p.muted(
      u.error
        ? `Usage limits are not available yet: ${u.error}`
        : "Usage limits have not been read yet.",
    );
  const bar = (percent) => {
    const filled = Math.round((Math.min(100, percent) / 100) * 16);
    return "█".repeat(filled) + "░".repeat(16 - filled);
  };
  const lines = [
    p.pretty
      ? `${p("accent bold", "Codex usage")} ${p.muted(`${u.plan ? `${u.plan} · ` : ""}read ${ago(u.at, now)}`)}`
      : `Codex usage${u.plan ? ` (${u.plan})` : ""}, read ${ago(u.at, now)}:`,
  ];
  for (const limit of u.limits) {
    if (u.limits.length > 1) lines.push(`  ${p.bold(limit.name)}`);
    for (const w of limit.windows) {
      const percent = String(Math.round(w.usedPercent)).padStart(3);
      lines.push(
        p.pretty
          ? `  ${p.muted(windowName(w.windowMinutes).padEnd(7))} ${p.bar(w.usedPercent)} ${p(p.load(w.usedPercent), `${percent}%`)} ${p.muted(`used${w.resetsAt ? ` · ${resetsIn(w.resetsAt, now)}` : ""}`)}`
          : `  ${windowName(w.windowMinutes).padEnd(7)} ${bar(w.usedPercent)} ${percent}% used${w.resetsAt ? `, ${resetsIn(w.resetsAt, now)}` : ""}`,
      );
    }
  }
  if (!u.limits.length) lines.push(p.muted("  no limit windows reported"));
  if (u.credits) {
    const credits = u.credits.unlimited
      ? "unlimited"
      : u.credits.has
        ? `balance ${creditBalance(u.credits.balance)}`
        : "none";
    lines.push(
      p.pretty
        ? `  ${p.muted("credits".padEnd(7))} ${credits}`
        : `  credits ${credits}`,
    );
  }
  if (u.reached)
    lines.push(p.err(`  limit reached: ${u.reached.replace(/_/g, " ")}`));
  else if (u.allowed === false)
    lines.push(p.warn("  ordinary usage is not allowed"));
  if (u.error) lines.push(p.warn(`  the last read failed: ${u.error}`));
  return lines.join("\n");
}
export const models = (list, p = plain) =>
  list
    .map(
      (m) =>
        `${p.bold(m.model)}${m.displayName && m.displayName !== m.model ? ` ${p.muted(`(${m.displayName})`)}` : ""}`,
    )
    .join("\n");
export function doctor(checks, p = plain) {
  if (!p.pretty)
    return checks
      .map(
        (c) =>
          `${c.ok ? "ok  " : c.ok === null ? "--  " : "FAIL"} ${c.name}: ${c.detail}`,
      )
      .join("\n");
  const pad = Math.max(...checks.map((c) => width(c.name)));
  const failed = checks.filter((c) => c.ok === false).length;
  return [
    ...checks.map((c) => {
      const mark =
        c.ok === false
          ? p.err(p.g.cross)
          : c.ok === null
            ? p.muted(p.g.bullet)
            : p.ok(p.g.check);
      const name = c.name + " ".repeat(pad - width(c.name));
      return `${mark} ${p.bold(name)}  ${c.ok === false ? p.safe(c.detail) : p.muted(c.detail)}`;
    }),
    "",
    failed
      ? p.err(`${failed} check${failed === 1 ? "" : "s"} failed.`)
      : p.ok("Everything Pelican needs is in place."),
  ].join("\n");
}

// Workflow runs.
const agentCounts = (a) =>
  `${a.total} agent call${a.total === 1 ? "" : "s"}: ${a.live} live, ${a.done} done, ${a.failed} failed`;
export const runStarted = (r, { resumed = false } = {}, p = plain) =>
  `${p.check(`${resumed ? "Resumed" : "Started"} run ${p.bold(r.name)} (${r.id}) in ${r.workspace}${r.cwd ? ` at ${r.cwd}` : ""}, owner ${p.who(r.owner)}.`)}\n${p.muted("Follow it:")} ${p.accent(`pelican run-status ${short(r.id)} --follow`)}\n${p.muted("Wait for it:")} ${p.accent(`pelican run-wait ${short(r.id)}`)}`;
export function runs(list, p = plain) {
  if (!list.length) return p.muted("No runs.");
  return table(
    list,
    [
      { title: "ID", value: (r) => short(r.id), paint: (c) => p.muted(c) },
      {
        title: "STATUS",
        value: (r) => p.statusText(r.status),
        paint: (c, r) => p(p.statusStyle(r.status), c),
      },
      {
        title: "NAME",
        value: (r) => one(r.name, 40, p),
        paint: (c) => p.bold(c),
      },
      { title: "OWNER", value: (r) => r.owner, paint: (c) => p.who(c) },
      {
        title: "WORKSPACE",
        value: (r) => r.workspace,
        paint: (c) => p.muted(c),
      },
      {
        title: "AGENTS",
        value: (r) =>
          `${r.agents.done}/${r.agents.total} done${r.agents.live ? `, ${r.agents.live} live` : ""}${r.agents.failed ? `, ${r.agents.failed} failed` : ""}`,
      },
      {
        title: "STARTED",
        value: (r) => ago(r.startedAt),
        paint: (c) => p.muted(c),
      },
    ],
    p,
  );
}
const runAgent = (a, width, p = plain) =>
  p.pretty
    ? `    ${p(p.mark(a.status)[1], p.mark(a.status)[0])} ${p.safe(a.label).padEnd(width)}  ${p(p.statusStyle(a.status), a.status.padEnd(11))}${a.jobId ? p.muted(short(a.jobId)) : ""}`.trimEnd()
    : `    ${a.label.padEnd(width)}  ${a.status}${a.jobId ? `  ${short(a.jobId)}` : ""}`;
export function run(d, { logLines = 15 } = {}, p = plain) {
  const labelWidth = Math.min(
    48,
    Math.max(
      0,
      ...d.phases.flatMap((phase) => phase.agents.map((a) => a.label.length)),
    ),
  );
  const lines = [
    p.pretty ? `${p.bold(d.name)} ${p.muted(d.id)}` : `${d.name} (${d.id})`,
    row(
      p,
      "status",
      p.pretty
        ? `${p.status(d.status)}${dot(p)}owner ${p.who(d.owner)}${dot(p)}workspace ${d.workspace}`
        : `${d.status}, owner ${d.owner}, workspace ${d.workspace}`,
    ),
    p.pretty
      ? `  ${p.muted(`started ${ago(d.startedAt)}${d.endedAt ? `, ended ${ago(d.endedAt)}` : ""}; ${agentCounts(d.agents)}`)}`
      : `  started ${ago(d.startedAt)}${d.endedAt ? `, ended ${ago(d.endedAt)}` : ""}; ${agentCounts(d.agents)}`,
  ];
  for (const phase of d.phases) {
    lines.push(
      `  ${p.pretty ? p("accent bold", phase.title) : phase.title}${phase.agents.length ? "" : p.muted(d.status === "running" ? " (no agents yet)" : " (no agents)")}`,
    );
    for (const a of phase.agents) lines.push(runAgent(a, labelWidth, p));
  }
  if (d.questions.length)
    lines.push(
      p.pretty
        ? p("warn bold", "  waiting for an answer")
        : "  waiting for an answer:",
      questionsBlock(d.questions, p),
    );
  if (d.log.length)
    lines.push(
      p.pretty ? p("note bold", "  log") : "  log:",
      ...d.log
        .slice(-logLines)
        .map((l) => `    ${p.muted(time(l.at))} ${one(l.text, 300, p)}`),
    );
  if (d.error)
    lines.push(
      p.pretty
        ? row(p, "error", p.err(p.safe(d.error)))
        : `  error: ${d.error}`,
    );
  if (d.result !== null && d.result !== undefined)
    lines.push(section(p, "result", json(d.result)));
  return lines.join("\n");
}
export function runWait(o, p = plain) {
  const head =
    o.reason === "question"
      ? p.warn(
          `${p.pretty ? `${p.g.diamond} ` : ""}An agent of the run is waiting for an answer.`,
        )
      : o.reason === "timeout"
        ? p.muted(`${p.pretty ? `${p.g.ring} ` : ""}Still running (timed out).`)
        : p(
            p.statusStyle(o.run.status),
            `${p.pretty ? `${p.mark(o.run.status)[0]} ` : ""}Run ${o.run.status}.`,
          );
  return `${head}\n${run(o.run, undefined, p)}`;
}
export const runStopped = (d, p = plain) =>
  d.status === "stopped"
    ? `${p.pretty ? `${p.muted(p.g.square)} ` : ""}Stopped run ${p.bold(d.name)} (${short(d.id)}): ${p.safe(d.error)}\n${p.muted("Resume it:")} ${p.accent(`pelican run --resume ${short(d.id)}`)}`
    : p.muted(`Run ${d.name} (${short(d.id)}) is not running (${d.status}).`);
// What changed between two looks at a run, for run-status --follow.
export function runChanges(before, after, p = plain) {
  const lines = [];
  const seen = new Set(before.log.map((l) => `${l.at}|${l.text}`));
  for (const l of after.log)
    if (!seen.has(`${l.at}|${l.text}`))
      lines.push(`${p.muted(time(l.at))} ${one(l.text, 300, p)}`);
  const was = new Map(
    before.phases.flatMap((phase) =>
      phase.agents.map((a, i) => [`${phase.title}#${i}`, a.status]),
    ),
  );
  for (const phase of after.phases)
    phase.agents.forEach((a, i) => {
      if (was.get(`${phase.title}#${i}`) !== a.status)
        lines.push(
          `         ${p.safe(a.label)}: ${p(p.statusStyle(a.status), a.status)}${a.jobId ? p.muted(` (${short(a.jobId)})`) : ""}`,
        );
    });
  const asked = new Set(before.questions.map((q) => q.requestId));
  const fresh = after.questions.filter((q) => !asked.has(q.requestId));
  if (fresh.length)
    lines.push(
      p.pretty
        ? p("warn bold", "waiting for an answer")
        : "waiting for an answer:",
      questionsBlock(fresh, p),
    );
  if (after.status !== before.status) {
    lines.push(
      p(
        p.statusStyle(after.status),
        `Run ${after.status}; ${agentCounts(after.agents)}.`,
      ),
    );
    if (after.error) lines.push(p.err(`error: ${p.safe(after.error)}`));
    if (after.result !== null && after.result !== undefined)
      lines.push(
        `${p.pretty ? p("accent bold", "result") : "result:"}\n${indent(json(after.result), "    ", p)}`,
      );
  }
  return lines.join("\n");
}

// Orchestrator timelines: note and feed.
export const noted = (n, p = plain) =>
  p.check(`Noted in ${n.workspace} as ${p.who(n.by)} (#${n.noted}).`);
const timelineTag = { note: "note", action: "did", run: "run", agent: "agent" };
const timelineTone = {
  note: "note bold",
  action: "info",
  run: "stop",
  agent: "accent",
};
export const feed = (page, p = plain) =>
  page.entries
    .map(
      (e) =>
        `${p.muted(time(e.at))} ${p.muted(e.workspace)} ${p.who(e.by ?? "?")} ${p(timelineTone[e.kind], timelineTag[e.kind] ?? e.kind)}: ${e.kind === "note" ? p.safe(e.text) : one(e.text, 400, p)}`,
    )
    .join("\n");

// What needs an orchestrator (pelican watch), one line each. On a terminal the
// time, workspace and agent are dimmed or lit and a mark leads the line; to a
// pipe it is plain text a line monitor can read.
export const watchTypes = new Set([
  "agent.question",
  "job.finished",
  "job.cancelled",
  "job.restarting",
  "job.overloaded",
  "job.throttled",
  "job.recovered",
  "run.finished",
  "run.stopped",
  "run.note",
]);
export const flat = (text, limit = 600, p = plain) => {
  const line = p.safe(text).replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};
function watchMark(entry, p) {
  const g = p.g,
    d = entry.data ?? {};
  switch (entry.type) {
    case "agent.question":
      return [g.diamond, "warn bold"];
    case "job.finished":
    case "run.finished":
      return p.mark(d.status);
    case "job.cancelled":
    case "run.stopped":
      return [g.square, "muted"];
    case "job.restarting":
    case "job.overloaded":
    case "job.throttled":
      return [g.diamond, "warn"];
    case "job.recovered":
      return [g.dot, "info"];
    default:
      return [g.bullet, "note"];
  }
}
export function watchLine(entry, p = plain) {
  const d = entry.data ?? {};
  const title = flat(entry.title, 200, p);
  // An agent by its id and task, which say more than its given name.
  const ref = entry.jobId
    ? ` (${short(entry.jobId)}${d.name ? `, ${flat(d.name, 80, p)}` : ""})`
    : entry.runId
      ? ` (run ${short(entry.runId)})`
      : "";
  const body =
    entry.type === "job.finished" && !entry.body ? d.summary : entry.body;
  // The line is cut to one line's worth before the answer command is added,
  // so a long body never takes the command with it.
  const said = flat(body, Math.max(80, 600 - title.length - ref.length), p);
  const question = entry.type === "agent.question" ? d.pending?.[0] : null;
  const answer = question?.id
    ? ` ${p.muted("|")} ${p.accent(`pelican answer ${short(entry.jobId)} ${short(question.id)} <answer>`)}`
    : "";
  let head = title,
    mark = "";
  if (p.pretty) {
    // The agent's name is lit, the rest of the title takes the entry's tone.
    const [icon, style] = watchMark(entry, p);
    mark = `${p(style, icon)} `;
    head =
      entry.agentName && title.startsWith(entry.agentName)
        ? `${p.bold(entry.agentName)}${p(style, title.slice(entry.agentName.length))}`
        : p(style, title);
  }
  return `${p.muted(`[${entry.workspace}]`)} ${mark}${head}${p.muted(ref)}${said ? `: ${said}` : ""}${answer}`;
}
export function watchQuiet(a, idle, p = plain) {
  const name = flat(a.name, 80, p);
  return `${p.muted(`[${a.workspace}]`)} ${p.pretty ? `${p.warn(p.g.diamond)} ` : ""}${p.bold(a.agentName)} ${p.muted(`(${short(a.id)}${a.name ? `, ${name}` : ""})`)} has been quiet for ${Math.round(idle / 60000)} min${a.latest ? `; last: ${flat(a.latest, 300, p)}` : ""}`;
}

// Activity over time (metrics): a sparkline per series (the oldest bucket on
// the left), then the same per workspace and per orchestrator.
const ticks = "▁▂▃▄▅▆▇█";
export function spark(values) {
  const top = Math.max(0, ...values);
  return values
    .map((v) =>
      v > 0 ? ticks[1 + Math.min(6, Math.floor((v / top) * 6.999))] : ticks[0],
    )
    .join("");
}
const span = (seconds) =>
  seconds % 3600 === 0
    ? `${seconds / 3600}h`
    : seconds % 60 === 0
      ? `${seconds / 60}m`
      : `${seconds}s`;
const sparkTone = {
  live: "accent",
  started: "info",
  finished: "ok",
  tokens: "note",
  events: "stop",
  questions: "warn",
};
export function metrics(m, p = plain) {
  const scope = [
    m.workspace ? `workspace ${m.workspace}` : "every workspace",
    m.owner ? `orchestrator ${m.owner}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const t = m.totals;
  const rows = [
    ["live", m.series.live, `peak ${t.peak}, ${m.now.working} working now`],
    ["started", m.series.started, String(t.started)],
    [
      "finished",
      m.series.finished,
      `${t.finished}${t.failed ? `, ${t.failed} failed` : ""}`,
    ],
    ["tokens", m.series.tokens, tokens(t.tokens)],
    ["events", m.series.events, String(t.events)],
    [
      "questions",
      m.series.questions,
      `${t.questions}${m.now.questions ? `, ${m.now.questions} open now` : ""}`,
    ],
  ];
  const brief = (x) =>
    `${p.muted("live")} ${p.accent(spark(x.series.live))}${p.muted("  peak")} ${x.totals.peak}${dot(p)}${x.now.working} working${dot(p)}${tokens(x.totals.tokens)} tokens${dot(p)}${x.totals.events} events`;
  // Plain keeps the wording it always had.
  const plainBrief = (x) =>
    `live ${spark(x.series.live)}  peak ${x.totals.peak} · ${x.now.working} working · ${tokens(x.totals.tokens)} tokens · ${x.totals.events} events`;
  const width = (list, key) => Math.max(0, ...list.map((x) => x[key].length));
  const span2 = `${time(m.from).slice(0, 5)} to ${time(m.to).slice(0, 5)} (${m.buckets.length} buckets of ${span(m.bucketSeconds)})`;
  const lines = [
    p.pretty
      ? `${p("accent bold", "Activity")} ${p.muted(`of ${scope}, ${span2}`)}`
      : `Activity of ${scope}, ${span2}:`,
    ...rows.map(
      ([label, values, total]) =>
        `  ${p.muted(label.padEnd(9))}  ${p(sparkTone[label], spark(values))}  ${total}`,
    ),
  ];
  if (m.workspaces.length > 1 || (m.workspaces.length && !m.workspace)) {
    const pad = width(m.workspaces, "id");
    lines.push(
      "",
      p.pretty ? p.rule("By workspace") : "By workspace:",
      ...m.workspaces.map(
        (w) =>
          `  ${p.bold(w.id.padEnd(pad))}  ${p.pretty ? brief(w) : plainBrief(w)}`,
      ),
    );
  }
  if (m.owners.length) {
    const pad = width(m.owners, "name");
    lines.push(
      "",
      p.pretty ? p.rule("By orchestrator") : "By orchestrator:",
      ...m.owners.map(
        (o) =>
          `  ${p.who(o.name)}${" ".repeat(pad - o.name.length)}  ${p.pretty ? brief(o) : plainBrief(o)}`,
      ),
    );
  }
  return lines.join("\n");
}
