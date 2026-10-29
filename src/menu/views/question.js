import { s, wrapFacts, wrapLine } from "../lines.js";
import { ago, oneLine, span, tokens, wrap } from "../text.js";
import { agentById, questionRows } from "../state.js";
import { statusIcon, statusStyle, statusWord } from "../theme.js";
import { decisionLabel, decisionsOf } from "../actions.js";
import { glyphsOf } from "../tree.js";
import { note } from "./common.js";

// An open question or approval in full: who asks whom, about which task,
// the question itself and, for an approval, the decisions it offers. a (or
// Enter) answers it.
export function model(state, item, box) {
  const g = glyphsOf(state);
  const q = item.question;
  const width = box.room.width;
  if (!q)
    return {
      title: [s("Question", "bold")],
      body: [note("This question is answered.")],
    };
  const all = questionRows(state);
  const approval = q.kind !== "question";
  const body = [
    ...wrapFacts(
      [
        [
          s(`${g.diamond} `, "warn bold"),
          s(approval ? q.kind : "question", "warn bold"),
        ],
        [s(q.workspace ?? "", "muted")],
        [s(`asked ${ago(q.createdAt, state.now)}`, "muted")],
      ],
      width,
      { sep: [` ${g.sep} `, "muted"], indent: 2 },
    ),
    ...(q.name ? wrapLine([s(oneLine(q.name), "muted")], width) : []),
    [],
    ...wrap(String(q.question ?? ""), width).map((l) => [s(l)]),
    [],
  ];
  const decisions = decisionsOf(q);
  if (decisions) {
    body.push([s("Decisions", "bold")]);
    decisions.forEach((d, i) =>
      body.push(
        ...wrapLine(
          [s(`  ${i + 1} `, "accent bold"), s(decisionLabel(d))],
          width,
          4,
        ),
      ),
    );
    body.push([]);
  }
  // The agent that asks: what it is and what it did last.
  const a = agentById(state, q.jobId);
  if (a) {
    const [icon, style] = statusIcon(a.status, g, a.questions);
    body.push(
      [s("The agent", "bold")],
      ...wrapFacts(
        [
          [s(icon, style), s(" "), s(a.agentName, "bold")],
          [
            s(
              statusWord(a.status, a.questions),
              statusStyle(a.questions ? "waiting" : a.status),
            ),
          ],
          [s(`${a.model} ${a.effort}`, "muted")],
          [s(`${tokens(a.tokens)} tokens`, "muted")],
          [s(span(state.now - Date.parse(a.createdAt)), "muted")],
        ],
        width,
        { sep: [` ${g.sep} `, "muted"], indent: 2 },
      ),
      // Its latest activity, unless that is this question again.
      ...(a.latest && !String(q.question ?? "").includes(oneLine(a.latest))
        ? wrapLine([s("latest ", "muted"), s(oneLine(a.latest))], width, 2)
        : []),
    );
  }
  return {
    title: [
      s(q.agentName ?? "", "bold"),
      s(" asks ", "muted"),
      s(q.owner, q.owner === state.as ? "accent bold" : "bold"),
    ],
    right:
      all.length > 1
        ? [
            s(
              `${all.findIndex((x) => x.id === q.id) + 1} of ${all.length}`,
              "muted",
            ),
          ]
        : [],
    body,
  };
}
