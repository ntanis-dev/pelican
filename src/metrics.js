// Activity over time (the metrics method), computed from the workspaces'
// stores and journals: per time bucket, the agents live (the most at once),
// started, finished (any end: completed, failed, cancelled, interrupted,
// blocked) and failed (failed or blocked) agents, tokens used, journal
// entries of the readable feed, and questions asked. Buckets are aligned to
// the clock, so calls a moment apart share them; the last one is the current,
// partial bucket. Events are the journal entries of the readable feed and
// the orchestrators' notes.
const activeStates = new Set(["starting", "running", "waiting", "stopping"]);
const tokenType = "thread/tokenUsage/updated";
const startType = "job.started";
// What ends an attempt (job.resumed and job.retrying end it when a followup
// or the result retry starts right after the turn).
const endTypes = [
  "job.finished",
  "job.recovered",
  "job.cancelled",
  "job.resumed",
  "job.retrying",
  "job.restarting",
  "job.overloaded",
];
const lifecycle = [startType, ...endTypes];
// An agent reached a done status.
const doneTypes = new Set(["job.finished", "job.recovered", "job.cancelled"]);
const failedStatuses = new Set(["failed", "blocked"]);
// Orchestrators' notes count as events too.
const noteTypes = ["orchestrator.note"];
export const seriesKeys = [
  "live",
  "started",
  "finished",
  "failed",
  "tokens",
  "events",
  "questions",
];
export const maxBuckets = 1000;

const failure = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode });
const emptySeries = (count) =>
  Object.fromEntries(seriesKeys.map((k) => [k, new Array(count).fill(0)]));
const sum = (values) => values.reduce((a, b) => a + b, 0);
function totalsOf(series) {
  const { live, ...rest } = series;
  return {
    peak: Math.max(0, ...live),
    ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, sum(v)])),
  };
}

// The most agents live at once in each bucket, from their live intervals.
export function liveSeries(intervals, { from, to, bucketMs, count }) {
  const points = [];
  for (const [start, end] of intervals) {
    const a = Math.max(start, from),
      z = Math.min(end, to);
    if (z < a) continue;
    points.push([a, 1], [z, -1]);
  }
  // At the same moment a start counts before an end, so an agent that lived
  // for an instant still shows.
  points.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const out = new Array(count).fill(0);
  let current = 0,
    i = 0;
  for (let b = 0; b < count; b++) {
    const end = from + (b + 1) * bucketMs;
    let peak = current;
    while (i < points.length && points[i][0] < end) {
      current += points[i][1];
      peak = Math.max(peak, current);
      i++;
    }
    out[b] = peak;
  }
  return out;
}

// The window: { from, to, bucketMs, count } for minutes and bucketSeconds.
export function metricWindow({
  minutes = 60,
  bucketSeconds,
  now = Date.now(),
}) {
  const seconds = bucketSeconds ?? Math.max(5, Math.ceil((minutes * 60) / 60));
  const bucketMs = seconds * 1000;
  const count = Math.ceil((minutes * 60) / seconds);
  if (count > maxBuckets)
    throw failure(
      400,
      `metrics: ${count} buckets of ${seconds}s is too many (at most ${maxBuckets}); use a longer bucketSeconds.`,
    );
  const last = Math.floor(now / bucketMs) * bucketMs;
  const from = last - (count - 1) * bucketMs;
  return { from, to: now, bucketMs, count, bucketSeconds: seconds };
}

// One workspace's rows: its share of the series, by workspace and by owner.
function scan(fleet, span, { owner: only, feedTypes }) {
  const { from, to, bucketMs, count } = span;
  const store = fleet.store;
  const start = store.seqAt(new Date(from).toISOString());
  const feed = new Set([...feedTypes, ...noteTypes]);
  const rows = store.metricRows(start, [
    ...new Set([...lifecycle, ...feed, tokenType]),
  ]);
  const jobOwner = (id) => (id ? (fleet.jobs.get(id)?.owner ?? null) : null);
  const bucket = (ms) =>
    Math.min(count - 1, Math.max(0, Math.floor((ms - from) / bucketMs)));
  // Additions to the series: [key, owner, bucket, amount].
  const adds = [];
  const intervals = []; // [start, end, owner]
  const open = new Map(); // job id -> { start, owner }
  const seen = new Set(); // jobs with a lifecycle entry in the window
  const tokens = new Map(); // job id -> the last total seen
  const wanted = (owner) => !only || owner === only;
  for (const row of rows) {
    const ms = Date.parse(row.at);
    if (!(ms >= from && ms <= to)) continue;
    const owner = row.owner ?? row.by ?? jobOwner(row.jobId);
    const b = bucket(ms);
    if (row.type === tokenType) {
      if (row.total === null || row.total === undefined) continue;
      const total = Number(row.total) || 0;
      let before = tokens.get(row.jobId);
      if (before === undefined) {
        const last = store.lastBefore(row.jobId, row.seq, [tokenType]);
        before = Number(last?.total) || 0;
      }
      tokens.set(row.jobId, total);
      const used = total >= before ? total - before : total;
      const who = jobOwner(row.jobId);
      if (used > 0 && wanted(who)) adds.push(["tokens", who, b, used]);
      continue;
    }
    if (feed.has(row.type) && wanted(owner)) adds.push(["events", owner, b, 1]);
    if (row.type === "agent.question" && wanted(owner))
      adds.push(["questions", owner, b, 1]);
    if (!row.jobId || !lifecycle.includes(row.type)) continue;
    if (row.type === startType) {
      const was = open.get(row.jobId);
      if (was) intervals.push([was.start, ms, was.owner]);
      open.set(row.jobId, { start: ms, owner });
      seen.add(row.jobId);
      if (wanted(owner)) adds.push(["started", owner, b, 1]);
      continue;
    }
    // An end: of an attempt that started in the window, or (the first
    // entry of this agent in the window) of one that started before it.
    const was = open.get(row.jobId);
    if (was) {
      intervals.push([was.start, ms, was.owner]);
      open.delete(row.jobId);
    } else if (!seen.has(row.jobId)) {
      const before = store.lastBefore(row.jobId, start, lifecycle);
      if (before?.type === startType) intervals.push([from, ms, owner]);
    }
    seen.add(row.jobId);
    if (doneTypes.has(row.type) && wanted(owner)) {
      adds.push(["finished", owner, b, 1]);
      if (failedStatuses.has(row.status)) adds.push(["failed", owner, b, 1]);
    }
  }
  // Attempts still open, and agents live through the whole window.
  for (const [id, was] of open) {
    const job = fleet.jobs.get(id);
    const end =
      job && !activeStates.has(job.status) && job.finishedAt
        ? Date.parse(job.finishedAt)
        : to;
    intervals.push([was.start, end, was.owner]);
  }
  for (const job of fleet.jobs.values())
    if (
      !seen.has(job.id) &&
      activeStates.has(job.status) &&
      job.startedAt &&
      Date.parse(job.startedAt) < from
    )
      intervals.push([from, to, job.owner]);
  return {
    adds,
    intervals: intervals.filter(([, , owner]) => wanted(owner)),
  };
}

const nowOf = (jobs, concurrency = 0) => {
  const out = { working: 0, queued: 0, questions: 0, concurrency };
  for (const job of jobs) {
    if (activeStates.has(job.status)) out.working++;
    else if (job.status === "queued") out.queued++;
    out.questions += job.pending?.length ?? 0;
  }
  return out;
};

// records: the workspaces to read; fleets: id -> Fleet; feedTypes: the
// journal entries that count as events.
export function metrics({
  records,
  fleets,
  owner = null,
  minutes = 60,
  bucketSeconds,
  feedTypes,
  workspace = null,
  now = Date.now(),
}) {
  const span = metricWindow({ minutes, bucketSeconds, now });
  const { from, to, bucketMs, count } = span;
  const total = emptySeries(count);
  const workspaces = [];
  const owners = new Map();
  const ownerEntry = (name) => {
    if (!owners.has(name))
      owners.set(name, {
        name,
        series: emptySeries(count),
        intervals: [],
        jobs: [],
      });
    return owners.get(name);
  };
  const allIntervals = [];
  for (const record of records) {
    const fleet = fleets.get(record.id);
    if (!fleet) continue;
    const { adds, intervals } = scan(fleet, span, {
      owner,
      feedTypes,
    });
    const own = emptySeries(count);
    for (const [key, who, b, n] of adds) {
      total[key][b] += n;
      own[key][b] += n;
      if (who) ownerEntry(who).series[key][b] += n;
    }
    own.live = liveSeries(intervals, span);
    allIntervals.push(...intervals);
    for (const interval of intervals)
      if (interval[2]) ownerEntry(interval[2]).intervals.push(interval);
    const jobs = [...fleet.jobs.values()].filter(
      (j) => !owner || j.owner === owner,
    );
    for (const job of jobs)
      if (
        job.owner &&
        (activeStates.has(job.status) || job.status === "queued")
      )
        ownerEntry(job.owner).jobs.push(job);
    workspaces.push({
      id: record.id,
      name: record.name,
      series: own,
      totals: totalsOf(own),
      now: nowOf(jobs, fleet.settings?.concurrency ?? 0),
    });
  }
  total.live = liveSeries(allIntervals, span);
  const ownerRows = [...owners.values()]
    .filter((o) => !owner || o.name === owner)
    .map((o) => {
      o.series.live = liveSeries(o.intervals, span);
      return {
        name: o.name,
        series: o.series,
        totals: totalsOf(o.series),
        now: nowOf(o.jobs),
      };
    })
    .sort(
      (a, b) =>
        b.totals.events - a.totals.events ||
        b.totals.tokens - a.totals.tokens ||
        a.name.localeCompare(b.name),
    );
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketSeconds: span.bucketSeconds,
    buckets: Array.from({ length: count }, (_, i) =>
      new Date(from + i * bucketMs).toISOString(),
    ),
    workspace,
    owner,
    series: total,
    totals: totalsOf(total),
    now: {
      working: sum(workspaces.map((w) => w.now.working)),
      queued: sum(workspaces.map((w) => w.now.queued)),
      questions: sum(workspaces.map((w) => w.now.questions)),
      concurrency: sum(workspaces.map((w) => w.now.concurrency)),
    },
    workspaces,
    owners: ownerRows,
  };
}
