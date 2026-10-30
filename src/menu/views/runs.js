import { s } from "../lines.js";
import { runRows } from "../state.js";
import { glyphsOf } from "../tree.js";
import { note } from "./common.js";
import { listModel } from "./run.js";

// Every workflow run (the sidebar shows the running ones and the latest
// finished; this is all of them), newest first.
export function model(state, item, box) {
  const rows = runRows(state);
  return {
    title: [s("Workflow runs", "bold"), s(`  ${rows.length}`, "muted")],
    body: rows.length
      ? listModel(state, rows, box.room.width, glyphsOf(state))
      : [note("No workflow runs yet: pelican run <workflow.js>")],
  };
}
