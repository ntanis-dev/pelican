import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { setImmediate as yieldTurn } from "node:timers/promises";

// Indexes and tables of features Pelican no longer has (the evidence and Work
// pipeline, the board, uploads, the dashboard's orchestrator chat).
const legacyIndexes = [
  "producer_commands_assignment",
  "worker_operations_assignment",
  "evidence_by_hash",
  "evidence_by_work",
  "evidence_by_job",
  "evidence_by_producer",
  "evidence_by_source",
  "commands_by_work",
  "events_controller_call",
];
const legacyTables = [
  "board_posts",
  "board_topics",
  "board_subscriptions",
  "board_deliveries",
  "board_evidence",
  "board_threads",
  "board_messages",
  "uploads",
];
// The only durable side records left: agents' questions and approvals.
const keptKinds = ["agent-request"];
const legacySettings = ["controller", "cafe", "preferences"];
const row = (r) => ({
  seq: r.seq,
  jobId: r.job_id,
  type: r.type,
  at: r.at,
  data: JSON.parse(r.data),
});

export class Store {
  constructor(dataDir) {
    this.path = join(dataDir, "pelican.sqlite");
    this.db = new DatabaseSync(this.path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id, seq);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL, source TEXT);
      CREATE TABLE IF NOT EXISTS run_calls (run_id TEXT NOT NULL, execution INTEGER NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id, execution, idx));
      ${legacyIndexes.map((name) => `DROP INDEX IF EXISTS ${name};`).join("\n")}
      ${legacyTables.map((name) => `DROP TABLE IF EXISTS ${name};`).join("\n")}`);
    this.db
      .prepare(
        `DELETE FROM work_records WHERE kind NOT IN (${keptKinds.map(() => "?").join(",")})`,
      )
      .run(...keptKinds);
    this.db
      .prepare(
        `DELETE FROM settings WHERE key IN (${legacySettings.map(() => "?").join(",")})`,
      )
      .run(...legacySettings);
  }
  setting(key, fallback) {
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return r ? JSON.parse(r.value) : fallback;
  }
  setSetting(key, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  deleteSetting(key) {
    this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
  }
  jobs() {
    return this.db
      .prepare("SELECT data FROM jobs")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  saveWork(kind, record) {
    this.db
      .prepare("INSERT OR REPLACE INTO work_records VALUES (?,?,?)")
      .run(kind, record.id, JSON.stringify(record));
  }
  workRecord(kind, id) {
    const r = this.db
      .prepare("SELECT data FROM work_records WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? JSON.parse(r.data) : null;
  }
  save(job) {
    this.db
      .prepare("INSERT OR REPLACE INTO jobs VALUES (?,?)")
      .run(job.id, JSON.stringify(job));
  }
  // Workflow runs and their journal: one entry per agent() call of each
  // execution (the first start, then every resume).
  runs() {
    return this.db
      .prepare("SELECT data FROM runs")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  saveRun(run) {
    this.db
      .prepare(
        "INSERT INTO runs(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(run.id, JSON.stringify(run));
  }
  runSource(id) {
    return (
      this.db.prepare("SELECT source FROM runs WHERE id=?").get(id)?.source ??
      null
    );
  }
  saveRunSource(id, source) {
    this.db.prepare("UPDATE runs SET source=? WHERE id=?").run(source, id);
  }
  runCalls(id, execution) {
    const rows =
      execution === undefined
        ? this.db
            .prepare(
              "SELECT data FROM run_calls WHERE run_id=? ORDER BY execution, idx",
            )
            .all(id)
        : this.db
            .prepare(
              "SELECT data FROM run_calls WHERE run_id=? AND execution=? ORDER BY idx",
            )
            .all(id, execution);
    return rows.map((r) => JSON.parse(r.data));
  }
  saveRunCall(id, call) {
    this.db
      .prepare("INSERT OR REPLACE INTO run_calls VALUES (?,?,?,?)")
      .run(id, call.execution, call.index, JSON.stringify(call));
  }
  deleteRun(id) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM run_calls WHERE run_id=?").run(id);
      this.db.prepare("DELETE FROM runs WHERE id=?").run(id);
    });
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  event(jobId, type, data) {
    const at = new Date().toISOString();
    const r = this.db
      .prepare("INSERT INTO events(job_id,type,at,data) VALUES (?,?,?,?)")
      .run(jobId ?? null, type, at, JSON.stringify(data));
    return { seq: Number(r.lastInsertRowid), jobId, type, at, data };
  }
  // The journal after a cursor. types narrows it to those event types (a
  // trailing "*" matches a prefix); owner to the agents one orchestrator owns
  // and the entries of no agent recorded under it (its workflow runs).
  // actor narrows it to one orchestrator's timeline: the entries it made (by,
  // from or to name it) and, of ownedTypes, those of agents it owned then.
  // With last, the newest that many entries instead (oldest first).
  events({
    after = 0,
    jobId,
    limit = 200,
    types,
    owner,
    actor,
    ownedTypes = [],
    last = 0,
  } = {}) {
    limit = Math.min(Math.max(Number(last) || Number(limit) || 200, 1), 1000);
    const where = ["seq > ?"],
      args = [last > 0 ? 0 : Number(after) || 0];
    if (jobId) {
      where.push("job_id = ?");
      args.push(jobId);
    }
    if (actor) {
      const own = ownedTypes.length
        ? ` OR (type IN (${ownedTypes.map(() => "?").join(",")}) AND json_extract(data,'$.owner') = ?)`
        : "";
      where.push(
        `(json_extract(data,'$.by') = ? OR json_extract(data,'$.from') = ? OR json_extract(data,'$.to') = ?${own})`,
      );
      args.push(actor, actor, actor, ...(own ? [...ownedTypes, actor] : []));
    }
    if (owner) {
      where.push(
        "(job_id IN (SELECT id FROM jobs WHERE json_extract(data,'$.owner') = ?) OR (job_id IS NULL AND json_extract(data,'$.owner') = ?))",
      );
      args.push(owner, owner);
    }
    if (types?.length) {
      const exact = types.filter((t) => !t.endsWith("*")),
        prefixes = types.filter((t) => t.endsWith("*"));
      const any = [
        ...(exact.length
          ? [`type IN (${exact.map(() => "?").join(",")})`]
          : []),
        ...prefixes.map(() => "type LIKE ?"),
      ];
      where.push(`(${any.join(" OR ")})`);
      args.push(...exact, ...prefixes.map((p) => p.slice(0, -1) + "%"));
    }
    const select = `SELECT * FROM events WHERE ${where.join(" AND ")}`;
    return this.db
      .prepare(
        last > 0
          ? `SELECT * FROM (${select} ORDER BY seq DESC LIMIT ?) ORDER BY seq`
          : `${select} ORDER BY seq LIMIT ?`,
      )
      .all(...args, limit)
      .map(row);
  }
  // The first journal position at or after a time: entries are written in
  // time order, so a binary search over seq finds it without a scan.
  seqAt(iso) {
    const { lo, hi } = this.db
      .prepare("SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM events")
      .get();
    if (lo === null) return 1;
    const first = this.db.prepare(
      "SELECT seq, at FROM events WHERE seq >= ? ORDER BY seq LIMIT 1",
    );
    let low = lo,
      high = hi + 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const found = first.get(mid);
      if (found && found.at < iso) low = found.seq + 1;
      else high = mid;
    }
    return low;
  }
  // What metrics reads of the journal from a position: a few fields of the
  // entries of these types, without parsing whole entries.
  metricRows(fromSeq, types) {
    return this.db
      .prepare(
        `SELECT seq, job_id AS jobId, type, at,
          json_extract(data,'$.status') AS status,
          json_extract(data,'$.owner') AS owner,
          json_extract(data,'$.by') AS by,
          json_extract(data,'$.tokenUsage.total.totalTokens') AS total
        FROM events WHERE seq >= ? AND type IN (${types.map(() => "?").join(",")})
        ORDER BY seq`,
      )
      .all(fromSeq, ...types);
  }
  // One agent's newest entry of these types before a position.
  lastBefore(jobId, seq, types) {
    return (
      this.db
        .prepare(
          `SELECT type, json_extract(data,'$.tokenUsage.total.totalTokens') AS total
          FROM events WHERE job_id = ? AND seq < ? AND type IN (${types.map(() => "?").join(",")})
          ORDER BY seq DESC LIMIT 1`,
        )
        .get(jobId, seq, ...types) ?? null
    );
  }
  prune(now = Date.now()) {
    // Startup and periodic requests share one scan; never overlap maintenance.
    this.pruning ??= this.pruneHistory(now).finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }
  async pruneHistory(now) {
    const cutoff = new Date(now - 7 * 86400000).toISOString();
    if (this.closed) return { removed: 0, cutoff };
    const worker = new Worker(new URL("./retention-scan.js", import.meta.url), {
      workerData: { path: this.path, cutoff },
    });
    this.pruneWorker = worker;
    let candidates;
    try {
      candidates = await new Promise((resolve, reject) => {
        let rows;
        worker.once("message", (value) => {
          rows = value;
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (this.closed) resolve([]);
          else if (code === 0 && rows) resolve(rows);
          else reject(new Error(`History scan exited (${code})`));
        });
      });
    } finally {
      this.pruneWorker = null;
    }
    let removed = 0;
    for (let offset = 0; offset < candidates.length; offset += 128) {
      await yieldTurn();
      if (this.closed) break;
      const statement = this.db.prepare("DELETE FROM events WHERE seq=?");
      this.transaction(() => {
        for (const seq of candidates.slice(offset, offset + 128))
          removed += Number(statement.run(seq).changes);
      });
    }
    return { removed, cutoff };
  }
  compact() {
    // Only before dispatch at startup. VACUUM rewrites the entire database and
    // must never block live worker heartbeats.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  }
  cursor() {
    return this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events")
      .get().seq;
  }
  close() {
    this.closed = true;
    void this.pruneWorker?.terminate();
    this.db.close();
  }
}
