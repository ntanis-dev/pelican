import { fitLine, restyle, s, wrapFacts, wrapLine } from "../lines.js";
import { ago, oneLine, plural, tokens } from "../text.js";
import { statusIcon, statusStyle, statusWord } from "../theme.js";
import { groupAgents, orchestratorByName, pickedAgent } from "../state.js";
import { glyphsOf } from "../tree.js";
import { note } from "./common.js";

// One group of an orchestrator's agents (what the sidebar counts: 3 working,
// 5 done): a line per agent, one of them highlighted. ↑↓ move the highlight,
// Enter (or a click) opens the agent, and Backspace in the agent comes back
// here with it highlighted.
const tone = { asking: "warn bold", working: "accent", failed: "err" };

export function model(state, item, box) {
  const g = glyphsOf(state);
  const width = box.room.width;
  const list = groupAgents(orchestratorByName(state, item.owner), item.group);
  const picked = pickedAgent(state, item.key, list);
  const focused = state.focus === "pane";
  const title = [
    s(item.owner, item.owner === state.as ? "accent bold" : "bold"),
    s(`  ${item.group}`, tone[item.group] ?? "muted"),
  ];
  if (!list.length)
    return { title, body: [note("No agents here now.")], pickLine: null };
  const used = list.reduce((n, a) => n + (a.tokens ?? 0), 0);
  const head = wrapFacts(
    [
      [s(plural(list.length, "agent"), "muted")],
      [s(`${tokens(used)} tokens`, "muted")],
    ],
    width,
    { sep: [` ${g.sep} `, "muted"], indent: 2 },
  );
  head.push([]);
  const body = [];
  let pickLine = null;
  for (const a of list) {
    const here = a === picked;
    const [icon, style] = statusIcon(a.status, g, a.questions);
    const detail = [
      oneLine(a.name),
      `${tokens(a.tokens)} tokens`,
      ago(a.finishedAt ?? a.updatedAt, state.now),
    ].filter(Boolean);
    const lines = wrapLine(
      [
        s(here ? `${g.arrow} ` : "  ", here && !focused ? "accent bold" : ""),
        s(`${icon} `, style),
        s(a.agentName ?? a.id.slice(0, 8), "bold"),
        s(
          `  ${statusWord(a.status, a.questions)}`,
          a.questions ? "warn bold" : statusStyle(a.status),
        ),
        s(` ${g.sep} ${detail.join(` ${g.sep} `)}`, "muted"),
      ],
      width,
      4,
    );
    if (here) pickLine = { line: body.length, size: lines.length };
    for (const line of lines) {
      const out =
        here && focused
          ? fitLine(restyle(line, "selected bold"), width, "selected bold")
          : line;
      body.push(
        Object.assign(out, { targets: [{ x: 0, width, openAgent: a.id }] }),
      );
    }
  }
  return { title, head, body, pickLine };
}
