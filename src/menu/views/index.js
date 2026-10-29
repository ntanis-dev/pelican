import * as overview from "./overview.js";
import * as question from "./question.js";
import * as orchestrator from "./orchestrator.js";
import * as group from "./group.js";
import * as agent from "./agent.js";
import * as run from "./run.js";
import * as runs from "./runs.js";
import * as workspace from "./workspace.js";
import * as events from "./events.js";

// What the right pane can show, by the kind of the sidebar's selection.
// Each has model(state, item, box) -> the pane's title, head and body (see
// pane.js).
export const kinds = {
  overview,
  question,
  orchestrator,
  group,
  agent,
  run,
  runs,
  workspace,
  events,
};
