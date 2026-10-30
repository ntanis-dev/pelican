// One arrival order for questions and approvals, independent of agent grouping.
export function compareRequests(a, b) {
  if (Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence))
    return a.sequence - b.sequence;
  return (
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
    String(a.id || a.requestId).localeCompare(String(b.id || b.requestId))
  );
}

export function requestQueue(jobs) {
  return [...jobs]
    .filter((job) => !job.sunsetAt)
    .flatMap((job) =>
      (job.pending || []).map((request) => ({
        ...request,
        jobId: job.id,
        jobName: job.agentName,
      })),
    )
    .sort(compareRequests);
}
