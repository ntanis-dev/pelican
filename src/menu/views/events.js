import { s } from "../lines.js";
import { glyphsOf } from "../tree.js";
import { entryBody, eventIcon, eventTone, note } from "./common.js";

// The live feed of every workspace (pelican events --follow): spawns,
// finishes, questions, answers, messages, reports and settings, newest at
// the bottom.
export function model(state, item, box) {
  const g = glyphsOf(state);
  const multi = (state.data.status?.workspaces?.length ?? 1) > 1;
  const events = state.feed.events;
  const title = [s("Events", "bold"), s("  every workspace", "muted")];
  if (!events.length)
    return {
      title,
      live: true,
      body: [
        note(
          Object.keys(state.feed.cursors).length
            ? "Nothing has happened yet."
            : "Reading the feed.",
        ),
      ],
    };
  const entries = events.map((e) => {
    const [icon, style] = eventIcon(e, g);
    return {
      key: e.id,
      sig: e.id,
      at: e.at,
      icon: s(icon, style),
      title: [
        ...(multi ? [s(e.workspace, "muted"), s(" ")] : []),
        s(e.text, eventTone(e.type)),
      ],
    };
  });
  return {
    title,
    live: true,
    ...entryBody(entries, box.room.width, { g, scope: "events" }),
  };
}
