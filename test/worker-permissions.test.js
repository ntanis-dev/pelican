import test from "node:test";
import assert from "node:assert/strict";
import {
  autoMode,
  networkKey,
  permissionParams,
  turnSandbox,
  verifiedPermissions,
} from "../src/worker-permissions.js";

test("every agent runs in Codex auto mode with an explicit Windows sandbox", () => {
  assert.deepEqual(autoMode, {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  assert.deepEqual(permissionParams({}, {}, { platform: "linux" }), {
    ...autoMode,
    config: { [networkKey]: false },
  });
  assert.deepEqual(permissionParams({}, {}, { platform: "win32" }).config, {
    [networkKey]: false,
    "windows.sandbox": "elevated",
    "features.prefer_mxc": true,
  });
  assert.deepEqual(
    permissionParams(
      { windowsSandbox: "unelevated" },
      {},
      { platform: "win32", network: true },
    ).config,
    {
      [networkKey]: true,
      "windows.sandbox": "unelevated",
      "features.prefer_mxc": false,
    },
  );
});

test("the network switch rides in the thread config and every turn's sandbox", () => {
  assert.equal(networkKey, "sandbox_workspace_write.network_access");
  assert.equal(
    permissionParams({}, {}, { network: true, platform: "linux" }).config[
      networkKey
    ],
    true,
  );
  const permissions = verifiedPermissions({
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
    },
    approvalPolicy: "on-request",
  });
  assert.equal(permissions.networkAccess, false);
  assert.deepEqual(turnSandbox(permissions, true), {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: true,
  });
  assert.equal(turnSandbox(permissions, false).networkAccess, false);
});

test("a thread that did not start in auto mode never gets a turn", () => {
  const verified = verifiedPermissions({
    sandbox: { type: "workspaceWrite", writableRoots: [] },
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    cwd: "/work",
  });
  assert.equal(verified.approvalsReviewer, "auto_review");
  assert.equal(verified.sandbox.type, "workspaceWrite");
  assert.throws(
    () =>
      verifiedPermissions({
        sandbox: { type: "readOnly" },
        approvalPolicy: "on-request",
      }),
    /did not start in auto mode/,
  );
  assert.throws(
    () =>
      verifiedPermissions({
        sandbox: { type: "workspaceWrite" },
        approvalPolicy: "never",
      }),
    /did not start in auto mode/,
  );
});
