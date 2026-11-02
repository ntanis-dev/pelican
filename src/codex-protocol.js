import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLaunch } from "./cli-path.js";
import { runCommand } from "./windows-sandbox.js";

// The slice of the Codex app-server protocol Pelican relies on, held against
// the schema the installed Codex generates. A Codex update that drops or
// renames one of these fails the check, and agents stop before they break
// mid-turn. Keep it in step with codex.js, fleet.js, account.js and
// approvals.js.

// Requests Pelican sends: every field it sends must still exist, and every
// field the schema requires must be one it always sends.
const requests = {
  initialize: { always: ["clientInfo", "capabilities"] },
  "thread/start": {
    always: [
      "model",
      "cwd",
      "sandbox",
      "approvalPolicy",
      "approvalsReviewer",
      "config",
      "developerInstructions",
      "dynamicTools",
      "serviceName",
      "ephemeral",
    ],
  },
  "thread/resume": {
    always: [
      "threadId",
      "model",
      "cwd",
      "sandbox",
      "approvalPolicy",
      "approvalsReviewer",
      "config",
      "developerInstructions",
      "excludeTurns",
    ],
  },
  "turn/start": {
    always: [
      "threadId",
      "input",
      "model",
      "effort",
      "cwd",
      "sandboxPolicy",
      "approvalPolicy",
      "approvalsReviewer",
      "serviceTier",
    ],
  },
  "turn/steer": { always: ["threadId", "expectedTurnId", "input"] },
  "turn/interrupt": { always: ["threadId", "turnId"] },
  "model/list": { always: ["cursor", "limit"] },
  "account/read": { always: ["refreshToken"] },
  "account/rateLimits/read": { always: [] },
  "account/login/cancel": { always: ["loginId"] },
};

// Requests Codex sends that Pelican answers, with the params fields it reads.
const serverRequests = {
  "item/tool/call": ["tool", "arguments"],
  "item/tool/requestUserInput": ["questions"],
  "item/commandExecution/requestApproval": ["command", "reason"],
  "item/fileChange/requestApproval": ["reason"],
  "item/permissions/requestApproval": ["permissions", "reason"],
  "mcpServer/elicitation/request": [],
};

// Notifications Pelican acts on, with the params fields it reads.
const notifications = {
  "turn/started": ["turn"],
  "turn/completed": ["threadId", "turn"],
  "item/started": ["threadId", "item"],
  "item/completed": ["threadId", "item"],
  "turn/plan/updated": ["plan"],
  "thread/tokenUsage/updated": ["tokenUsage"],
  "serverRequest/resolved": ["requestId"],
  error: ["error", "willRetry"],
  "account/login/completed": ["loginId", "success", "error"],
};

// Other shapes Pelican reads fields from or sends.
const shapes = {
  InitializeCapabilities: ["experimentalApi", "optOutNotificationMethods"],
  ThreadStartResponse: [
    "thread",
    "cwd",
    "sandbox",
    "approvalPolicy",
    "approvalsReviewer",
  ],
  ThreadResumeResponse: [
    "thread",
    "cwd",
    "sandbox",
    "approvalPolicy",
    "approvalsReviewer",
  ],
  Thread: ["id"],
  TurnStartResponse: ["turn"],
  Turn: ["id", "status", "error"],
  TurnError: ["message", "codexErrorInfo"],
  ThreadTokenUsage: ["total"],
  FileUpdateChange: ["path"],
  ModelListResponse: ["data", "nextCursor"],
  Model: [
    "id",
    "displayName",
    "hidden",
    "isDefault",
    "supportedReasoningEfforts",
    "serviceTiers",
  ],
  ModelServiceTier: ["id", "name"],
  ReasoningEffortOption: ["reasoningEffort"],
  DynamicToolCallResponse: ["contentItems", "success"],
  ToolRequestUserInputQuestion: ["id", "question"],
  ToolRequestUserInputResponse: ["answers"],
  PermissionsRequestApprovalResponse: ["permissions", "scope"],
  McpServerElicitationRequestResponse: ["action"],
};

// Enum values Pelican sends or branches on.
const enums = {
  SandboxMode: ["workspace-write"],
  AskForApproval: ["on-request"],
  ApprovalsReviewer: ["auto_review"],
  TurnStatus: ["completed", "interrupted", "failed"],
  CodexErrorInfo: ["serverOverloaded"],
  MessagePhase: ["final_answer"],
  PermissionGrantScope: ["turn"],
  CommandExecutionApprovalDecision: [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ],
  FileChangeApprovalDecision: [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ],
  McpServerElicitationAction: ["decline"],
};

// Variants of tagged unions, by their type tag, with the fields Pelican uses.
const variants = {
  ThreadItem: {
    agentMessage: ["text", "phase"],
    commandExecution: ["command"],
    fileChange: ["changes"],
  },
  SandboxPolicy: { workspaceWrite: ["networkAccess"] },
  UserInput: { text: ["text", "text_elements"] },
  DynamicToolSpec: { function: ["name", "description", "inputSchema"] },
  DynamicToolCallOutputContentItem: { inputText: ["text"] },
};

// Object variants of CodexErrorInfo, keyed by their one property.
const errorVariants = { responseStreamDisconnected: ["httpStatusCode"] };

export const contract = {
  requests,
  serverRequests,
  notifications,
  shapes,
  enums,
  variants,
  errorVariants,
};

const refName = (ref) => ref?.split("/").pop();
const properties = (def) => Object.keys(def?.properties ?? {});

function methodParams(file) {
  const map = new Map();
  for (const variant of file?.oneOf ?? []) {
    const method = variant.properties?.method?.enum?.[0];
    if (method) map.set(method, refName(variant.properties?.params?.$ref));
  }
  return map;
}

function enumValues(def) {
  if (!def) return [];
  if (def.enum) return def.enum;
  return (def.oneOf ?? def.anyOf ?? []).flatMap((v) => v.enum ?? []);
}

// A generated schema bundle: its method files and every definition, merged.
export async function readSchema(dir) {
  const files = {};
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json")))
    files[name] = JSON.parse(await readFile(join(dir, name), "utf8"));
  return files;
}

// Readable problems with the schema bundle; none means compatible.
export function checkContract(files) {
  const definitions = {};
  for (const file of Object.values(files)) {
    Object.assign(definitions, file.definitions ?? {});
    if (file.title && !definitions[file.title]) definitions[file.title] = file;
  }
  const clientRequests = files["ClientRequest.json"];
  const codexRequests = files["ServerRequest.json"];
  const codexNotifications = files["ServerNotification.json"];
  // The files that map methods to params are authoritative for those params.
  Object.assign(
    definitions,
    codexRequests?.definitions,
    codexNotifications?.definitions,
    clientRequests?.definitions,
  );
  const problems = [];

  const sent = methodParams(clientRequests);
  for (const [method, { always, sometimes = [] }] of Object.entries(requests)) {
    if (!sent.has(method)) {
      problems.push(`request ${method} no longer exists`);
      continue;
    }
    const params = sent.get(method);
    if (!params) {
      if (always.length) problems.push(`${method} no longer takes params`);
      continue;
    }
    const def = definitions[params];
    const fields = properties(def);
    for (const field of [...always, ...sometimes])
      if (!fields.includes(field))
        problems.push(`${method}: field "${field}" was removed`);
    for (const field of def?.required ?? [])
      if (!always.includes(field))
        problems.push(`${method}: new required field "${field}"`);
  }

  for (const [label, file, wanted] of [
    ["request", codexRequests, serverRequests],
    ["notification", codexNotifications, notifications],
  ]) {
    const map = methodParams(file);
    for (const [method, read] of Object.entries(wanted)) {
      if (!map.has(method)) {
        problems.push(`${label} ${method} no longer exists`);
        continue;
      }
      const fields = properties(definitions[map.get(method)]);
      for (const field of read)
        if (!fields.includes(field))
          problems.push(`${method}: field "${field}" was removed`);
    }
  }

  for (const [name, read] of Object.entries(shapes)) {
    if (!definitions[name]) {
      problems.push(`type ${name} no longer exists`);
      continue;
    }
    const fields = properties(definitions[name]);
    for (const field of read)
      if (!fields.includes(field))
        problems.push(`${name}: field "${field}" was removed`);
  }

  for (const [name, values] of Object.entries(enums)) {
    const have = enumValues(definitions[name]);
    for (const value of values)
      if (!have.includes(value))
        problems.push(`${name}: value "${value}" was removed`);
  }

  for (const [name, byType] of Object.entries(variants)) {
    const found = new Map(
      (definitions[name]?.oneOf ?? []).map((v) => [
        v.properties?.type?.enum?.[0],
        properties(v),
      ]),
    );
    for (const [type, read] of Object.entries(byType)) {
      if (!found.has(type)) {
        problems.push(`${name} ${type} no longer exists`);
        continue;
      }
      for (const field of read)
        if (!found.get(type).includes(field))
          problems.push(`${name} ${type}: field "${field}" was removed`);
    }
  }

  const errorObjects = new Map(
    (definitions.CodexErrorInfo?.anyOf ?? [])
      .filter((v) => v.properties)
      .map((v) => {
        const [key] = Object.keys(v.properties);
        return [key, properties(v.properties[key])];
      }),
  );
  for (const [key, read] of Object.entries(errorVariants)) {
    if (!errorObjects.has(key)) {
      problems.push(`CodexErrorInfo ${key} no longer exists`);
      continue;
    }
    for (const field of read)
      if (!errorObjects.get(key).includes(field))
        problems.push(`CodexErrorInfo ${key}: field "${field}" was removed`);
  }
  return problems;
}

// A smoke run (npm run smoke) records the Codex version it ran against.
const verifiedPath = (config) => join(config.dataDir, "codex-verified.json");

export async function verifiedVersion(config) {
  try {
    return (
      JSON.parse(await readFile(verifiedPath(config), "utf8")).codexVersion ??
      null
    );
  } catch {
    return null;
  }
}

export async function recordVerified(config, codexVersion) {
  await writeFile(
    verifiedPath(config),
    JSON.stringify(
      { codexVersion, verifiedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}

async function run(launch, args) {
  const result = await runCommand(
    {
      command: launch.command,
      args: [...launch.prefix, ...args],
      timeoutMs: 60000,
    },
    tmpdir(),
  ).promise;
  if (result.exitCode !== 0)
    throw new Error(
      `codex ${args[0]} failed: ${result.error ?? (result.output.trim().split(/\r?\n/).at(-1) || `exit ${result.exitCode}`)}`,
    );
  return result.output;
}

// Schema checks by Codex executable, its size and its modification time: an
// update replaces or rewrites the file, which starts a new check.
const checks = new Map();

async function checkInstalled(config) {
  const launch = codexLaunch(config.codexBin);
  const binary = launch.prefix[0] ?? launch.command;
  const file = await stat(binary).catch(() => null);
  const key = file ? `${binary}|${file.size}|${file.mtimeMs}` : null;
  if (key && checks.has(key)) return checks.get(key);
  const checking = (async () => {
    const codexVersion = (await run(launch, ["--version"]))
      .trim()
      .split(/\r?\n/)
      .at(-1);
    const dir = await mkdtemp(join(tmpdir(), "pelican-codex-schema-"));
    try {
      await run(launch, [
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        dir,
      ]);
      return {
        codexVersion,
        problems: checkContract(await readSchema(dir)),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  if (key) {
    checks.set(key, checking);
    // A check that could not run is tried again next time.
    checking.catch(() => checks.delete(key));
  }
  return checking;
}

// Whether the installed Codex speaks the protocol Pelican relies on:
// verified (it matches, and a smoke run passed on this version), unverified
// (it matches; no smoke run yet), incompatible (problems lists what changed)
// or unknown (the check could not run; error says why).
export async function codexProtocol(
  config,
  { check: run = checkInstalled } = {},
) {
  let check;
  try {
    check = await run(config);
  } catch (error) {
    return {
      state: "unknown",
      error: error.message,
      checkedAt: new Date().toISOString(),
    };
  }
  const verified = await verifiedVersion(config);
  if (check.problems.length)
    return { state: "incompatible", ...check, verifiedVersion: verified };
  return {
    state: verified === check.codexVersion ? "verified" : "unverified",
    ...check,
    verifiedVersion: verified,
  };
}

// What to tell a caller about the protocol state, or null when all is well.
export function protocolNote(protocol) {
  if (protocol?.state === "unverified")
    return `Codex ${protocol.codexVersion} matches the protocol Pelican relies on but has not passed its live smoke test (last verified: ${protocol.verifiedVersion ?? "never"}). Run npm run smoke in Pelican's folder before relying on it.`;
  if (protocol?.state === "unknown")
    return `Pelican could not check the installed Codex: ${protocol.error}`;
  return null;
}

export function incompatibility(protocol) {
  return `The installed Codex (${protocol.codexVersion ?? "unknown version"}) changed the protocol Pelican relies on: ${protocol.problems.join("; ")}. Update Pelican, then run npm run smoke.`;
}

// For agent workers: refuses to start Codex on an incompatible version. An
// unknown state lets the worker try, and its own start reports what fails.
export async function requireCompatibleCodex(config) {
  const protocol = await codexProtocol(config);
  if (protocol.state === "incompatible")
    throw Object.assign(new Error(incompatibility(protocol)), {
      permanent: true,
    });
  return protocol;
}
