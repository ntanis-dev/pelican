// Shared by new requests and the browser so older journal entries also read clearly.
export function approvalTitle(method) {
  return {
    "item/commandExecution/requestApproval": "Permission to run a command",
    "item/fileChange/requestApproval": "Permission to change files",
    "item/permissions/requestApproval": "Additional permissions requested",
  }[method];
}

export function approvalAnswerSummary(answer, method) {
  const decision = typeof answer === "string" ? answer : answer?.decision;
  if (
    method === "item/commandExecution/requestApproval" &&
    decision &&
    typeof decision === "object"
  ) {
    if (decision.acceptWithExecpolicyAmendment)
      return "Command approved with a reusable rule";
    if (decision.applyNetworkPolicyAmendment)
      return `Network ${decision.applyNetworkPolicyAmendment.network_policy_amendment?.action === "deny" ? "denied" : "allowed"} with a reusable rule`;
  }
  const outcomes = {
    accept: "approved",
    acceptForSession: "approved for this session",
    decline: "declined",
    cancel: "cancelled",
  };
  const outcome = Object.hasOwn(outcomes, decision) ? outcomes[decision] : null;
  // Old pages may contain an answer without its original request. Infer only
  // an explicit protocol decision object, never ordinary text such as "accept".
  if (!approvalTitle(method)) {
    if (method || !answer || typeof answer !== "object" || !outcome)
      return null;
    return outcome[0].toUpperCase() + outcome.slice(1);
  }
  if (method === "item/permissions/requestApproval")
    return "Permissions response sent";
  if (!outcome) return "Approval response sent";
  return `${method === "item/fileChange/requestApproval" ? "File changes" : "Command"} ${outcome}`;
}

export function requestSummary(request) {
  const p = request.params || {};
  const title = approvalTitle(request.method);
  if (title) {
    const command = Array.isArray(p.command) ? p.command.join(" ") : p.command;
    return [
      title,
      p.reason,
      command ? `Command: ${command}` : null,
      p.cwd ? `Directory: ${p.cwd}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return (
    p.arguments?.question ||
    p.reason ||
    p.message ||
    p.questions?.map((q) => q.question).join("\n") ||
    (request.question !== request.method ? request.question : null) ||
    "Agent requested a decision"
  );
}
