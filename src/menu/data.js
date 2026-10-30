import * as format from "../format.js";
import {
  feedLimit,
  metricsEveryMs,
  metricsParams,
  usageEveryMs,
  put,
  tailLimit,
  timelineLimit,
  toast,
  workspaceRows,
} from "./state.js";
import { runMethods } from "./actions.js";
import { currentItem } from "./pane.js";

// What the menu reads from the service, and how the answers land in state.
// A refresh asks for status first (it says whether the service is up and
// which workspaces exist), then for what the sidebar lists (questions,
// every agent, the runs, who orchestrates, the graphs every few seconds)
// and for what the right pane shows (an agent's conversation, a timeline,
// a run, the event feed). Every request is { key, method, params }: a
// gateway call, the same the CLI makes.
export const statusRequest = { key: "status", method: "status", params: {} };
export { runMethods };

// A feed read from a cursor: the last few at first, then what came after.
const from = (cursor, first, more) =>
  cursor === null || cursor === undefined ? first : more(cursor);

export function needs(state) {
  const out = [];
  const item = currentItem(state);
  if (state.data.account === null && state.data.accountError === null)
    out.push({ key: "account", method: "account", params: {} });
  out.push({ key: "questions", method: "questions", params: {} });
  out.push({ key: "fleet", method: "list", params: { limit: 500 } });
  out.push({ key: "runs", method: runMethods.list, params: {} });
  out.push({
    key: "timeline",
    method: "feed",
    params: from(state.timeline.cursor, { all: true, last: 300 }, (after) => ({
      all: true,
      after,
      limit: 500,
    })),
  });
  // The graphs: every few seconds, the last hour by the minute.
  const m = state.metrics;
  if (m.at === null || state.now - m.at >= metricsEveryMs)
    out.push({ key: "metrics", method: "metrics", params: metricsParams });
  // The Codex usage limits: the service's last reading, every minute.
  const u = state.usage;
  if (u.at === null || state.now - u.at >= usageEveryMs)
    out.push({ key: "usage", method: "usage", params: {} });
  const cached = state.cache[item.key];
  switch (item.kind) {
    case "agent": {
      const id = item.agentId;
      out.push({ key: "agent", method: "get", params: { id } });
      out.push({
        key: "tail",
        method: "tail",
        params: from(
          cached?.cursor,
          { id, last: 300, full: true },
          (after) => ({ id, after, full: true }),
        ),
      });
      break;
    }
    case "orchestrator":
      out.push({
        key: "orch",
        method: "feed",
        params: from(cached?.cursor, { as: item.name, last: 300 }, (after) => ({
          as: item.name,
          after,
          limit: 500,
        })),
      });
      break;
    case "run":
      out.push({
        key: "run",
        method: runMethods.get,
        params: { id: item.runId },
      });
      break;
    case "events":
      for (const w of workspaceRows(state)) {
        const cursor = state.feed.cursors[w.id];
        out.push({
          key: "events",
          method: "events",
          params:
            cursor === undefined
              ? { workspace: w.id, last: 100 }
              : { workspace: w.id, after: cursor, limit: 200 },
        });
      }
      break;
    default:
      break;
  }
  return out;
}

export const serviceDown = (error) => error?.code === "PELICAN_DOWN";

const eventLine = /^\S* #\d+ /;
export function feedEntry(event, workspace) {
  return {
    ...event,
    workspace,
    id: `${workspace}#${event.seq}`,
    text: format
      .events({ events: [event], cursor: event.seq })
      .replace(eventLine, ""),
  };
}
const byTime = (a, b) =>
  String(a.at).localeCompare(String(b.at)) ||
  a.workspace.localeCompare(b.workspace) ||
  a.seq - b.seq;

const failed = (state, error) => toast(state, error.message, "error");
// An answer to the request made at the current cursor (not a stale one).
const fresh = (request, cursor) =>
  request.params.last !== undefined
    ? cursor === null || cursor === undefined
    : request.params.after === cursor;

export function applyData(state, { request, result, error }) {
  const data = state.data;
  switch (request.key) {
    case "status":
      if (error) {
        if (serviceDown(error))
          return {
            ...state,
            service: {
              state: state.service.state === "starting" ? "starting" : "down",
              message: error.message,
            },
          };
        if (state.service.state === "up") return failed(state, error);
        return {
          ...state,
          service: { state: "error", message: error.message },
        };
      }
      return {
        ...state,
        service: { state: "up", message: null },
        data: { ...data, status: result },
      };
    case "account":
      return error
        ? { ...state, data: { ...data, accountError: error.message } }
        : { ...state, data: { ...data, account: result } };
    case "questions":
      if (error) return failed(state, error);
      return { ...state, data: { ...data, questions: result } };
    case "fleet":
      if (error) return failed(state, error);
      return { ...state, data: { ...data, fleet: result } };
    case "runs":
      if (error)
        return {
          ...state,
          data: { ...data, runs: { ...data.runs, error: error.message } },
        };
      return {
        ...state,
        data: {
          ...data,
          runs: { list: Array.isArray(result) ? result : [], error: null },
        },
      };
    case "timeline": {
      const timeline = state.timeline;
      if (!fresh(request, timeline.cursor)) return state;
      if (error) return failed(state, error);
      return {
        ...state,
        timeline: {
          cursor: result.cursor,
          entries: [...timeline.entries, ...result.entries].slice(
            -timelineLimit,
          ),
        },
      };
    }
    case "usage":
      if (error)
        return {
          ...state,
          usage: { ...state.usage, at: state.now, error: error.message },
        };
      return {
        ...state,
        usage: { data: result, at: state.now, error: null },
      };
    case "metrics":
      if (error)
        return {
          ...state,
          metrics: { ...state.metrics, at: state.now, error: error.message },
        };
      return {
        ...state,
        metrics: { data: result, at: state.now, error: null },
      };
    case "agent": {
      const key = `agent:${request.params.id}`;
      const pane = state.cache[key];
      if (!pane) return state;
      return put(
        state,
        key,
        error
          ? { ...pane, error: error.message }
          : { ...pane, detail: result, error: null },
      );
    }
    case "tail": {
      const key = `agent:${request.params.id}`;
      const pane = state.cache[key];
      if (!pane || !fresh(request, pane.cursor)) return state;
      if (error) return put(state, key, { ...pane, error: error.message });
      return put(state, key, {
        ...pane,
        cursor: result.cursor,
        lines: [
          ...pane.lines,
          ...result.lines.filter(
            (l) => pane.cursor === null || l.seq > pane.cursor,
          ),
        ].slice(-tailLimit),
      });
    }
    case "orch": {
      const key = `orch:${request.params.as}`;
      const pane = state.cache[key];
      if (!pane || !fresh(request, pane.cursor)) return state;
      if (error) return put(state, key, { ...pane, error: error.message });
      return put(state, key, {
        ...pane,
        error: null,
        cursor: result.cursor,
        entries: [...pane.entries, ...result.entries].slice(-timelineLimit),
      });
    }
    case "run": {
      const key = `run:${request.params.id}`;
      const pane = state.cache[key];
      if (!pane) return state;
      if (error) return put(state, key, { ...pane, error: error.message });
      return put(state, key, { ...pane, detail: result, error: null });
    }
    case "events": {
      const ws = request.params.workspace;
      const cursor = state.feed.cursors[ws];
      const initial = request.params.last !== undefined;
      // An answer to a request made before the cursor moved is stale.
      if (initial ? cursor !== undefined : request.params.after !== cursor)
        return state;
      if (error) return failed(state, error);
      const added = result.events
        .filter((e) => cursor === undefined || e.seq > cursor)
        .map((e) => feedEntry(e, ws));
      return {
        ...state,
        feed: {
          cursors: { ...state.feed.cursors, [ws]: result.cursor },
          events: [...state.feed.events, ...added]
            .sort(byTime)
            .slice(-feedLimit),
        },
      };
    }
    default:
      return state;
  }
}

// What a pane keeps while it is among the most recent ones.
export const paneInit = {
  agent: () => ({ detail: null, error: null, cursor: null, lines: [] }),
  orchestrator: () => ({ entries: [], error: null, cursor: null }),
  run: () => ({ detail: null, error: null }),
};
