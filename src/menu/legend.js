import { lineWidth, s } from "./lines.js";
import { glyphsOf } from "./tree.js";
import { statusIcon, statusWord } from "./theme.js";

export function legendLine(state, kind, width) {
  const g = glyphsOf(state);
  const agentId = state.selected.startsWith("agent:")
    ? state.selected.slice(6)
    : null;
  const agent = agentId
    ? (state.cache["agent:" + agentId]?.detail ??
      state.data.fleet?.find((row) => row.id === agentId))
    : null;
  const asking = agent
    ? Array.isArray(agent.questions)
      ? agent.questions.length
      : Number(agent.questions) || 0
    : 0;
  const signs = state.form
    ? [
        [g.dot, "On"],
        [g.ring, "Off"],
      ]
    : kind === "agent" && agent
      ? [
          [
            statusIcon(agent.status, g, asking)[0],
            statusWord(agent.status, asking),
          ],
        ]
      : [
            "overview",
            "orchestrator",
            "group",
            "agent",
            "run",
            "runs",
            "workspace",
          ].includes(kind)
        ? [
            [g.spinner[0], "Working"],
            [g.diamond, "Asking"],
            [g.ring, "Queued"],
            [g.check, "Done"],
            [g.cross, "Failed"],
            [g.square, "Stopped"],
          ]
        : kind === "question"
          ? [[g.diamond, "Needs an answer"]]
          : kind === "events"
            ? [
                [g.bullet, "Note"],
                [g.check, "Done"],
                [g.cross, "Failed"],
                [g.diamond, "Question"],
              ]
            : [];
  const out = [];
  for (const [sign, label] of signs) {
    const entry = [
      ...(out.length ? [s(" ")] : []),
      s(" " + sign + " " + label + " ", "label"),
    ];
    if (lineWidth([...out, ...entry]) <= width) out.push(...entry);
  }
  return out;
}
