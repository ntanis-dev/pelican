// Every agent runs in Codex auto mode: it writes inside its workspace, and a
// request to leave the sandbox (outside writes, escalation, and network unless
// the workspace allows it) goes to Codex's auto-reviewer. No approval ever
// waits for a person.
export const autoMode = Object.freeze({
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  approvalsReviewer: "auto_review",
});
// The Codex setting behind a workspace's network switch. It travels in the
// thread's config (thread/start, thread/resume) and in every turn's
// sandboxPolicy, so a resumed agent picks up a changed switch.
export const networkKey = "sandbox_workspace_write.network_access";

// Pelican's Codex home has no inherited Windows sandbox selection. Without one,
// Codex can silently negotiate read-only even when workspace-write was requested.
export function permissionParams(
  state,
  config,
  { network = false, platform = process.platform } = {},
) {
  const implementation =
    state?.windowsSandbox || config.windowsSandbox || "auto";
  return {
    ...autoMode,
    config: {
      [networkKey]: network === true,
      ...(platform === "win32"
        ? {
            "windows.sandbox":
              implementation === "auto" ? "elevated" : implementation,
            "features.prefer_mxc":
              implementation === "auto" || implementation === "mxc",
          }
        : {}),
    },
  };
}

// The sandbox for one turn: what Codex verified for the thread, with the
// workspace's current network switch.
export function turnSandbox(permissions, network) {
  return { ...permissions.sandbox, networkAccess: network === true };
}

export function verifiedPermissions(response) {
  if (
    response.sandbox?.type !== "workspaceWrite" ||
    response.approvalPolicy !== autoMode.approvalPolicy
  )
    throw new Error(
      `Codex did not start in auto mode: it returned ${response.sandbox?.type || "unknown"} / ${response.approvalPolicy || "unknown"}. No turn was started. Check the Windows sandbox setup and managed permission requirements.`,
    );
  return {
    sandbox: structuredClone(response.sandbox),
    approvalPolicy: response.approvalPolicy,
    approvalsReviewer: response.approvalsReviewer ?? autoMode.approvalsReviewer,
    networkAccess: response.sandbox.networkAccess === true,
    cwd: response.cwd,
    checkedAt: new Date().toISOString(),
  };
}
