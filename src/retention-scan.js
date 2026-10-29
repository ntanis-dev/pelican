import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

// Read-only work on a separate thread. Deletions stay with the journal owner in
// small transactions so maintenance never holds a long competing writer lock.
const db = new DatabaseSync(workerData.path, { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
  const rows = db
    .prepare(
      `SELECT seq FROM events WHERE at < ? OR (
    seq < COALESCE((SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET 49999), 0)
    AND (
      type IN ('job.updated','thread/tokenUsage/updated')
      OR ((type LIKE '%/delta' OR type LIKE '%Delta') AND EXISTS (
        SELECT 1 FROM events completed
        WHERE completed.job_id IS events.job_id AND completed.type = 'item/completed'
          AND completed.seq > events.seq
          AND json_extract(completed.data, '$.item.id') = json_extract(events.data, '$.itemId')
      ))
    )
  ) ORDER BY seq`,
    )
    .all(workerData.cutoff);
  parentPort.postMessage(rows.map(({ seq }) => seq));
} finally {
  db.close();
}
