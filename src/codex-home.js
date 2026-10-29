import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stateDir } from "./config.js";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function info(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Codex home must stay inside Pelican's data directory.");
}

// Resolve only Pelican-owned paths. Reject junctions before creating or deleting
// anything; a persisted job or linked parent must never redirect cleanup.
function managedHome(dataDir, id) {
  if (id !== undefined && !uuid.test(id)) throw new Error("Invalid agent ID.");
  const data = realpathSync(resolve(dataDir));
  const root = join(data, "codex-homes");
  const home = id === undefined ? root : join(root, id);
  for (const path of new Set([root, home])) {
    inside(data, path);
    const entry = info(path);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw new Error("Pelican Codex homes must be ordinary directories.");
    if (entry) inside(data, realpathSync(path));
  }
  return home;
}

export function agentCodexHome(dataDir, id) {
  if (typeof id !== "string" || !uuid.test(id))
    throw new Error("Invalid agent ID.");
  return managedHome(dataDir, id);
}

// All Pelican processes share setup, authentication and the native thread index.
// This is separate from the desktop user's Codex home and from legacy worker homes.
export function sharedCodexHome(dataDir) {
  const data = realpathSync(resolve(dataDir));
  const home = join(data, "codex-home");
  inside(data, home);
  const entry = info(home);
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
    throw new Error(
      "Pelican's shared Codex home must be an ordinary directory.",
    );
  if (entry) inside(data, realpathSync(home));
  return home;
}

// History recovery reads only this agent's exact saved thread in its managed home.
export function agentRollout(dataDir, job) {
  if (!job.privateCodexHome || !job.threadId || job.sunsetAt) return null;
  return findRollout(
    job.codexHomeLayout === "shared"
      ? sharedCodexHome(dataDir)
      : agentCodexHome(dataDir, job.id),
    job.threadId,
  ).path;
}

function privateFile(home, name) {
  const path = join(home, name);
  const entry = info(path);
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1))
    throw new Error("Pelican Codex home contains a linked or invalid file.");
  return path;
}

function writePrivate(path, contents) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function seedAuthentication(source, home) {
  const target = privateFile(home, "auth.json");
  const marker = privateFile(home, ".pelican-auth-source");
  let contents;
  try {
    contents = readFileSync(join(source, "auth.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Removing file-based sign-in also removes any previously seeded copy.
    if (info(marker)) {
      rmSync(target, { force: true });
      rmSync(marker, { force: true });
    }
    return;
  }
  const fingerprint = createHash("sha256").update(contents).digest("hex");
  const previous = info(marker) ? readFileSync(marker, "utf8") : null;
  // Preserve a worker's refreshed credential until the source login changes.
  if (!info(target) || previous !== fingerprint) {
    writePrivate(target, contents);
    writePrivate(marker, fingerprint);
  }
}

function findRollout(source, threadId) {
  if (!uuid.test(threadId)) throw new Error("Invalid saved Codex thread ID.");
  for (const folder of ["sessions", "archived_sessions"]) {
    const root = join(source, folder);
    const entry = info(root);
    if (!entry) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Cannot import a linked Codex sessions directory.");
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) stack.push(path);
        else if (
          item.isFile() &&
          item.name.startsWith("rollout-") &&
          item.name.endsWith(`-${threadId}.jsonl`)
        )
          return {
            path: privateFile(dir, item.name),
            relativePath: relative(root, path),
          };
      }
    }
  }
  throw new Error(
    "Saved Codex session was not found; the agent was not restarted.",
  );
}

export function prepareAgentCodexHome(config, job) {
  // Validate the legacy namespace even after migration; cleanup must never follow
  // a substituted junction into someone else's files.
  const legacy = agentCodexHome(stateDir(config), job.id);
  const home = sharedCodexHome(stateDir(config));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const source = resolve(
    config.codexSourceHome ??
      process.env.CODEX_HOME ??
      join(homedir(), ".codex"),
  );
  seedAuthentication(source, home);
  if (job.threadId && job.codexHomeLayout !== "shared") {
    // Upgrade only this job's transcript. Never copy shared config, indexes,
    // other chats, or remove anything from the desktop's Codex home.
    const rollout = findRollout(
      job.privateCodexHome ? legacy : source,
      job.threadId,
    );
    let dir = home;
    for (const part of join("sessions", dirname(rollout.relativePath)).split(
      sep,
    )) {
      dir = join(dir, part);
      inside(home, dir);
      const entry = info(dir);
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
        throw new Error(
          "Cannot import into a linked Codex sessions directory.",
        );
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const target = privateFile(dir, rollout.relativePath.split(sep).at(-1));
    // A failed launch may already have imported the same rollout.
    if (!info(target))
      copyFileSync(rollout.path, target, constants.COPYFILE_EXCL);
  }
  job.privateCodexHome = true;
  job.codexHomeLayout = "shared";
  return home;
}

export async function removeAgentCodexHome(
  dataDir,
  id,
  { threadId, shared = false, deleteThread } = {},
) {
  const legacy = agentCodexHome(dataDir, id);
  // Never remove the shared directory when sunsetting one agent. Codex owns its
  // thread index, so use its thread deletion API instead of editing SQLite files.
  if (shared && threadId) {
    if (!uuid.test(threadId)) throw new Error("Invalid saved Codex thread ID.");
    const home = sharedCodexHome(dataDir);
    if (!deleteThread)
      throw new Error("Shared Codex cleanup requires thread deletion.");
    await deleteThread(home, threadId);
  }
  return rm(legacy, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export async function wipeAgentCodexHomes(dataDir) {
  const legacy = managedHome(dataDir),
    shared = sharedCodexHome(dataDir);
  for (const home of [legacy, shared])
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
}

export function validateCodexHomeRoot(dataDir) {
  managedHome(dataDir);
  return sharedCodexHome(dataDir);
}
