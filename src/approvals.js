import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const commandMethod = "item/commandExecution/requestApproval";
const simpleDecisions = ["accept", "acceptForSession", "decline", "cancel"];
const decisionSchema = z.union([
  z.enum(simpleDecisions),
  z
    .object({
      acceptWithExecpolicyAmendment: z
        .object({
          execpolicy_amendment: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      applyNetworkPolicyAmendment: z
        .object({
          network_policy_amendment: z
            .object({
              host: z.string().min(1),
              action: z.enum(["allow", "deny"]),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
]);

// Auto mode sends approvals to Codex's auto-reviewer. One that still reaches
// Pelican goes to the orchestrator, which answers with an offered decision.
export function approvalResponse(request, answer) {
  const decision = typeof answer === "string" ? answer : answer?.decision;
  const parsed = decisionSchema.safeParse(decision);
  if (!parsed.success)
    throw new Error(
      "Decision must be accept, acceptForSession, decline, cancel, or an offered policy amendment",
    );
  const p = request.params || {};
  if (typeof decision === "object" && request.method !== commandMethod)
    throw new Error(
      "Policy amendments apply only to command approval requests",
    );
  if (Array.isArray(p.availableDecisions)) {
    if (
      !p.availableDecisions.some((offered) =>
        isDeepStrictEqual(offered, decision),
      )
    )
      throw new Error(
        "Decision was not offered for this request; choose an exact availableDecisions entry",
      );
  } else if (typeof decision === "object") {
    const exec = decision.acceptWithExecpolicyAmendment?.execpolicy_amendment;
    const network =
      decision.applyNetworkPolicyAmendment?.network_policy_amendment;
    if (
      !(exec && isDeepStrictEqual(exec, p.proposedExecpolicyAmendment)) &&
      !(
        network &&
        p.proposedNetworkPolicyAmendments?.some((offered) =>
          isDeepStrictEqual(offered, network),
        )
      )
    )
      throw new Error(
        "Policy amendment must exactly match a proposal from this request",
      );
  }
  return { decision: parsed.data };
}
