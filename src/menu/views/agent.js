import { s, wrapFacts, wrapLine } from "../lines.js";
import { ago, clock, oneLine, short, span, tokens, wrap } from "../text.js";
import { statusIcon, statusStyle, statusWord } from "../theme.js";
import { glyphsOf } from "../tree.js";
import { diffStats, promptOf, summarize, took, unwrap } from "../command.js";
import {
  codeLine,
  codeLines,
  outputLines as outputSpans,
  pathLine,
} from "../syntax.js";
import { block, entryBody, note } from "./common.js";

// One agent: a status strip (its status, owner, workspace, model, tokens,
// age), what it is doing now, and a sub-view. Chat is its whole
// conversation, live: the brief it got, every message it got and from whom,
// its replies and reasoning, its commands and edits (one line each; Enter
// opens the marked one), its questions and the answers, its report and
// result. Brief, Result and Resources are the rest; [ and ] switch them.
export const tabs = ["chat", "brief", "result", "resources"];
export const tabTitles = {
  chat: "Chat",
  brief: "Brief",
  result: "Result",
  resources: "Resources",
};
export const tabOf = (state, item) => state.tabs[item.agentId] ?? "chat";
export const nextTab = (state, item, step) => {
  const at = tabs.indexOf(tabOf(state, item));
  return {
    ...state,
    tabs: {
      ...state.tabs,
      [item.agentId]: tabs[(at + step + tabs.length) % tabs.length],
    },
  };
};

// The strip above the sub-view: what the agent is and does, wrapped.
function headLines(state, d, width, g) {
  if (!d) return [];
  const questions = Array.isArray(d.questions)
    ? d.questions.length
    : Number(d.questions) || 0;
  const [icon, iconStyle] = statusIcon(d.status, g, questions);
  const started = d.startedAt ?? d.createdAt;
  const facts = [
    `owner ${d.owner}`,
    d.workspace,
    `${d.model} ${d.effort}`,
    `${tokens(d.tokens)} tokens`,
    started ? span(state.now - Date.parse(started)) : null,
  ].filter(Boolean);
  const lines = wrapFacts(
    [
      [
        s(icon, iconStyle),
        s(" "),
        s(
          statusWord(d.status, questions),
          statusStyle(questions ? "waiting" : d.status),
        ),
      ],
      ...facts.map((f) => [s(f, "muted")]),
    ],
    width,
    { sep: [` ${g.sep} `, "muted"], indent: 2 },
  );
  if (d.name) lines.push(...wrapLine([s(oneLine(d.name), "bold")], width));
  const now = d.activity?.current || d.activity?.progress;
  if (now)
    lines.push(
      ...wrapLine(
        [
          s(d.activity.current ? "now " : "latest ", "muted"),
          s(oneLine(now), d.activity.current ? "accent" : ""),
        ],
        width,
        2,
      ),
    );
  return lines;
}

const tone = (text) =>
  /^Finished: (failed|blocked)|^Warning/.test(text)
    ? "err"
    : /^(Stop requested|Cancelled)/.test(text)
      ? "muted"
      : /^Finished: completed/.test(text)
        ? "ok"
        : "muted";
// What a command printed, its files and how it went in colour.
const outputLines = (text, width, empty = "(no output)") => {
  const value = String(text ?? "").replace(/\n$/, "");
  return value
    ? outputSpans(value).flatMap((line) => wrapLine(line, width))
    : [[s(empty, "muted italic")]];
};
// An opened command: the script at its shell's prompt, a rule, its output.
function commandLines(shell, script, done, width, g) {
  const prompt = promptOf(shell);
  const lead = prompt.length + 1;
  const shown = codeLines(script || "(empty command)")
    .flatMap((line) => wrapLine(line, Math.max(1, width - lead)))
    .map((line, i) => [
      s(i === 0 ? `${prompt} ` : " ".repeat(lead), "accent bold"),
      ...line,
    ]);
  return [
    ...shown,
    [s(g.corners.h.repeat(Math.min(width, 24)), "divider")],
    ...outputLines(
      done?.detail,
      width,
      done ? "(no output)" : "(running, no output yet)",
    ),
  ];
}
// An edit's diff: what each file is, and its added and removed lines.
const fileHeader =
  /^(update|add|create|delete|move|rename|modify|change)\s+(\S.*)$/i;
const diffLines = (text, width) =>
  String(text ?? "")
    .split("\n")
    .flatMap((l) => {
      const header = fileHeader.exec(l);
      const line = header
        ? [
            [`${header[1]} `, "muted bold"],
            [header[2], "beak"],
          ]
        : [
            [
              l,
              l.startsWith("+")
                ? "ok"
                : l.startsWith("-")
                  ? "err"
                  : l.startsWith("@@")
                    ? "accent"
                    : "muted",
            ],
          ];
      return wrapLine(line, width);
    });

// The conversation as entries, from the journal lines of tail --full.
export function chatEntries(data, me, g) {
  const to = (name) => s(name ?? "?", "note bold");
  const self = s(me, "ok bold");
  const arrow = s(` ${g.right} `, "muted");
  const kind = (word, style = "muted") => s(` ${g.sep} ${word}`, style);
  const out = [];
  const commands = new Map();
  for (const line of data?.lines ?? []) {
    const base = {
      key: line.seq,
      at: line.at,
      sig: String(line.seq),
      rich: true,
    };
    const body = line.detail ?? line.text;
    switch (line.kind) {
      case "brief":
        out.push({
          ...base,
          title: [to(line.from), arrow, self, kind("assignment")],
          body,
        });
        break;
      case "message":
        out.push({
          ...base,
          title: [
            to(line.from),
            arrow,
            self,
            kind(`message (${line.mode ?? "steer"})`),
          ],
          body,
        });
        break;
      case "agent":
        out.push({
          ...base,
          title: [
            self,
            ...(line.phase && line.phase !== "final_answer"
              ? [kind("progress")]
              : []),
          ],
          body,
        });
        break;
      case "reasoning":
        out.push({
          ...base,
          title: [s(me, "ok"), kind("thinking", "muted italic")],
          body: line.detail,
          bodyStyle: "muted italic",
        });
        break;
      case "question":
        out.push({
          ...base,
          icon: s(g.diamond, "warn bold"),
          title: [self, arrow, to(line.to), kind("question", "warn bold")],
          body,
        });
        break;
      case "answer":
        out.push({
          ...base,
          title: [to(line.from), arrow, self, kind("answer")],
          body,
        });
        break;
      case "note":
        out.push({
          ...base,
          title: [self, arrow, to(line.to), kind("note")],
          body,
        });
        break;
      case "report":
        out.push({
          ...base,
          icon: s(g.check, "ok bold"),
          title: [self, arrow, to(line.to), kind("report", "ok bold")],
          body,
        });
        break;
      case "command": {
        // Started and completed are one entry.
        const open = line.item ? commands.get(line.item) : null;
        if (open) {
          open.done = line;
          open.sig = `${open.key}|${line.seq}`;
          break;
        }
        const entry = {
          ...base,
          command: true,
          fold: true,
          started: line.type === "item/started" ? line : null,
          done: line.type === "item/completed" ? line : null,
        };
        if (line.item) commands.set(line.item, entry);
        out.push(entry);
        break;
      }
      case "edit": {
        const { added, removed } = diffStats(line.detail);
        out.push({
          ...base,
          fold: true,
          title: [s("Edited", "info bold")],
          summary: {
            spans: pathLine(
              oneLine(line.text.replace(/^Edited\s*/, "")).split(/,\s*/),
            ),
          },
          right: [
            ...(added ? [s(`+${added}`, "ok")] : []),
            ...(added && removed ? [s(" ")] : []),
            ...(removed ? [s(`${g.less}${removed}`, "err")] : []),
          ],
          detail: (width) => diffLines(line.detail, width),
        });
        break;
      }
      default:
        out.push({
          ...base,
          icon: s(g.sep, "muted"),
          title: [s(oneLine(line.text), tone(line.text))],
        });
    }
  }
  for (const entry of out) {
    if (!entry.command) continue;
    const { done } = entry;
    const { shell, script } = unwrap(
      done?.command ??
        entry.started?.command ??
        entry.started?.text.replace(/^\$ /, "") ??
        "",
    );
    const code = done?.exitCode ?? null;
    const failed = Boolean(done) && code !== 0;
    const length = took(done?.durationMs);
    entry.title = [
      s(done ? "Ran" : "Running", done ? "accent bold" : "warn bold"),
    ];
    entry.summary = { spans: codeLine(summarize(script)) };
    entry.right = !done
      ? [s(`${g.dot} running`, "warn")]
      : failed
        ? [
            s(
              `${g.cross} ${code === null ? (done.status ?? "failed") : `exit ${code}`}`,
              "err bold",
            ),
            ...(length ? [s(` ${g.sep} ${length}`, "muted")] : []),
          ]
        : [s(g.pass, "ok"), ...(length ? [s(` ${length}`, "muted")] : [])];
    entry.rail = failed ? "err" : "muted";
    entry.detail = (width) => commandLines(shell, script, done, width, g);
  }
  const d = data?.detail;
  if (d?.result !== null && d?.result !== undefined) {
    const text = JSON.stringify(d.result, null, 2);
    out.push({
      key: "result",
      at: d.finishedAt ?? d.updatedAt,
      sig: `${text.length}|${d.resultValid}`,
      icon: s(g.check, d.resultValid === false ? "err" : "ok"),
      title: [
        self,
        kind("structured result", d.resultValid === false ? "err" : "ok"),
      ],
      body: text,
      rich: "code",
    });
  }
  return out;
}

// The other sub-views, wrapped to the width.
function tabLines(tab, d, width, now) {
  if (!d) return [note("Reading the agent.")];
  switch (tab) {
    case "brief":
      return [
        ...block("Task", d.name, width),
        ...block("Prompt", d.prompt, width, "", true),
        ...(d.hasResultSchema
          ? [[s("A result schema checks its structured result.", "muted")]]
          : []),
      ];
    case "result": {
      const out = [];
      if (!d.done) out.push([s(`Not finished yet: ${d.status}.`, "muted")], []);
      if (d.error) out.push(...block("Error", d.error, width, "err"));
      const given = d.result !== null && d.result !== undefined;
      if (d.hasResultSchema || given) {
        const verdict = d.resultValid
          ? ["valid", "ok bold"]
          : d.resultError
            ? ["rejected", "err bold"]
            : ["not given yet", "muted"];
        out.push(
          d.hasResultSchema
            ? [s("Result  ", "bold"), s(...verdict)]
            : [s("Result", "bold")],
        );
        if (d.resultError)
          out.push(
            ...wrap(d.resultError, width - 2).map((l) => [s(`  ${l}`, "err")]),
          );
        if (given)
          out.push(
            ...codeLines(JSON.stringify(d.result, null, 2)).flatMap((line) =>
              wrapLine(line, Math.max(1, width - 2)).map((l) => [
                s("  "),
                ...l,
              ]),
            ),
          );
        out.push([]);
      }
      if (d.report) out.push(...block("Report", d.report, width, "", true));
      if (d.summary && d.summary !== d.report)
        out.push(...block("Final reply", d.summary, width, "", true));
      if (out.length <= (d.done ? 0 : 2))
        out.push(note("Nothing handed back yet."));
      return out;
    }
    case "resources": {
      const when = (iso) =>
        iso ? `${clock(iso)} UTC (${ago(iso, now)})` : "not yet";
      const row = (label, value, style = "") =>
        wrapLine([s(label.padEnd(10), "bold"), s(value, style)], width, 10);
      return [
        ...row("Folder", d.cwd),
        [s("Reserves", "bold")],
        ...(d.resources?.length
          ? d.resources.flatMap((r) => wrapLine([s(`  ${r}`)], width, 2))
          : [[s("  nothing (read-only work)", "muted")]]),
        ...(d.dependsOn?.length
          ? row("Depends", d.dependsOn.map(short).join(", "))
          : []),
        ...row("Priority", String(d.priority ?? 0)),
        ...row("Queued", when(d.queuedAt)),
        ...row("Started", when(d.startedAt)),
        ...row("Finished", when(d.finishedAt)),
        ...(d.setup?.status && d.setup.status !== "ready"
          ? row("Sandbox", oneLine(d.setup.message))
          : []),
        ...row("Id", d.id, "muted"),
      ];
    }
    default:
      return [];
  }
}

export function model(state, item, box) {
  const g = glyphsOf(state);
  const data = state.cache[item.key];
  const d = data?.detail ?? null;
  const name = d?.agentName ?? item.row?.agentName ?? short(item.agentId);
  const tab = tabOf(state, item);
  const width = box.room.width;
  const viewKey = `${item.key}#${tab}`;
  const head = headLines(state, d ?? item.row, width, g);
  if (data?.error) head.push(...wrapLine([s(data.error, "err")], width));
  if (head.length && box.room.height >= 14) head.push([]);
  const base = {
    title: [s(name, "bold")],
    tabs: { list: tabs.map((t) => tabTitles[t]), index: tabs.indexOf(tab) },
    head,
    viewKey,
  };
  if (tab !== "chat")
    return { ...base, body: tabLines(tab, d, width, state.now) };
  const entries = chatEntries(data, name, g);
  if (!entries.length)
    return {
      ...base,
      live: true,
      body: [
        note(
          !data || data.cursor === null
            ? "Reading its conversation."
            : "Nothing in its conversation yet.",
        ),
      ],
    };
  return {
    ...base,
    live: true,
    ...entryBody(entries, width, {
      expanded: state.expanded[viewKey] ?? [],
      g,
      scope: viewKey,
    }),
  };
}
