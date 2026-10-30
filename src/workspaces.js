import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Store } from "./store.js";
import { Fleet } from "./fleet.js";
import { liveStates } from "./views.js";

// Workspaces are separate fleets: each has its own folder, store, settings,
// queue and agents. Agent ids are unique across all of them, so an agent is
// found without naming its workspace.
const registryName = "workspaces.json";
const failure = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode });
const slug = (name) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
const fold = (path) =>
  process.platform === "win32" ? path.toLowerCase() : path;
const within = (root, path) => {
  const r = relative(fold(root), fold(path));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const overlapping = (a, b) => within(a, b) || within(b, a);

export class Workspaces extends EventEmitter {
  constructor({ config, options = {} }) {
    super();
    this.config = config;
    this.options = options;
    this.records = [];
    this.fleets = new Map();
    this.closing = false;
  }
  // A single existing fleet, for tests and embedded use.
  static single(fleet, record = {}) {
    const hub = new Workspaces({ config: fleet.config });
    hub.attach(
      {
        id: fleet.config.workspace?.id ?? "default",
        name: fleet.config.workspace?.name ?? "Workspace",
        folder: fleet.folder,
        dir: null,
        createdAt: new Date().toISOString(),
        ...record,
      },
      fleet,
    );
    return hub;
  }
  static async open({ config, ...options }) {
    const hub = new Workspaces({ config, options });
    await hub.load();
    return hub;
  }
  get registryPath() {
    return join(this.config.dataDir, registryName);
  }
  async load() {
    let saved = null;
    try {
      saved = JSON.parse(readFileSync(this.registryPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let records = Array.isArray(saved?.workspaces) ? saved.workspaces : null;
    if (!records) {
      // The data from before workspaces existed becomes the first workspace,
      // in place, so nothing is moved while agents might still reference it.
      records = [];
      if (existsSync(join(this.config.dataDir, "pelican.sqlite"))) {
        const store = new Store(this.config.dataDir);
        const folder =
          store.setting("scheduler", {})?.defaultCwd ||
          resolve(this.config.dataDir, "../..");
        store.close();
        const name = basename(folder) || "Workspace";
        records.push({
          id: `${slug(name)}-${randomBytes(2).toString("hex")}`,
          name,
          folder,
          dir: null,
          createdAt: new Date().toISOString(),
        });
      }
      this.records = records;
      await this.persist();
    }
    for (const record of records) await this.boot(record);
  }
  async persist() {
    const path = this.registryPath;
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify(
        {
          workspaces: this.records.map(
            ({ id, name, folder, dir, createdAt }) => ({
              id,
              name,
              folder,
              dir,
              createdAt,
            }),
          ),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  }
  directory(record) {
    return record.dir
      ? resolve(this.config.dataDir, record.dir)
      : this.config.dataDir;
  }
  async boot(record) {
    const dir = this.directory(record);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Captured by the earlier evidence pipeline; nothing reads it now.
    await rm(join(dir, "evidence-objects"), { recursive: true, force: true });
    const store = new Store(dir);
    const fleet = new Fleet({
      store,
      config: {
        ...this.config,
        workspaceDir: dir,
        workspace: { id: record.id, name: record.name, folder: record.folder },
      },
      ...this.options,
    });
    await fleet.prune();
    store.compact();
    this.attach(record, fleet);
    return fleet;
  }
  attach(record, fleet) {
    if (!this.records.includes(record)) this.records.push(record);
    this.fleets.set(record.id, fleet);
    fleet.workspace = record;
    fleet.on("event", (event) => this.emit("event", record.id, event));
  }
  // By id or (case-insensitive) name.
  record(ref) {
    const wanted = String(ref ?? "").trim();
    const record =
      this.records.find((r) => r.id === wanted) ??
      this.records.find((r) => r.name.toLowerCase() === wanted.toLowerCase());
    if (!record)
      throw failure(
        404,
        `No workspace "${wanted}". Known: ${this.records.map((r) => `${r.id} (${r.name})`).join(", ") || "none"}.`,
      );
    return record;
  }
  fleet(ref) {
    return this.fleets.get(this.record(ref).id);
  }
  // The most specific workspace whose folder contains a path.
  containing(path) {
    if (typeof path !== "string" || !isAbsolute(path)) return null;
    return (
      this.records
        .filter((r) => within(r.folder, path))
        .sort((a, b) => b.folder.length - a.folder.length)[0] ?? null
    );
  }
  // The workspace a call means: the one it names, else the one containing
  // the given paths (an agent's cwd, then the caller's), else the only one.
  resolve({ workspace, paths = [] } = {}) {
    if (workspace) return this.record(workspace);
    for (const path of paths) {
      const record = this.containing(path);
      if (record) return record;
    }
    if (this.records.length === 1) return this.records[0];
    throw failure(
      409,
      this.records.length
        ? `Choose a workspace with --workspace (or PELICAN_WORKSPACE): ${this.records.map((r) => r.id).join(", ")}.`
        : "No workspace exists yet. Add one: pelican workspace add <folder>.",
    );
  }
  // An agent by id, unique id prefix or unique agent name, in any workspace.
  find(ref) {
    const wanted = String(ref ?? "").trim();
    if (!wanted) throw failure(400, "Name an agent by its id.");
    const all = [];
    for (const record of this.records) {
      const fleet = this.fleets.get(record.id);
      const exact = fleet.jobs.get(wanted);
      if (exact) return { record, fleet, job: exact };
      for (const job of fleet.jobs.values()) all.push({ record, fleet, job });
    }
    const lower = wanted.toLowerCase();
    let matches =
      wanted.length >= 4
        ? all.filter(({ job }) => job.id.startsWith(lower))
        : [];
    if (!matches.length)
      matches = all.filter(({ job }) => job.agentName.toLowerCase() === lower);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw failure(
        409,
        `"${wanted}" matches ${matches.length} agents: ${matches
          .slice(0, 5)
          .map(({ job }) => `${job.id} (${job.agentName})`)
          .join(", ")}. Use more of the id.`,
      );
    throw failure(404, `No agent "${wanted}".`);
  }
  summary(record) {
    const fleet = this.fleets.get(record.id);
    const jobs = [...fleet.jobs.values()];
    return {
      id: record.id,
      name: record.name,
      folder: record.folder,
      createdAt: record.createdAt,
      settings: { ...fleet.settings },
      agents: jobs.length,
      working: fleet.active.size,
      queued: jobs.filter((job) => job.status === "queued").length,
      questions: jobs.reduce((sum, job) => sum + job.pending.length, 0),
      finished: jobs.filter((job) => !liveStates.has(job.status)).length,
    };
  }
  list() {
    return this.records.map((record) => this.summary(record));
  }
  async add({ name, folder } = {}) {
    if (this.closing) throw failure(409, "Pelican is stopping.");
    if (typeof folder !== "string" || !isAbsolute(folder.trim()))
      throw new Error("Give the workspace's folder as an absolute path.");
    let path;
    try {
      path = await realpath(folder.trim());
      if (!(await stat(path)).isDirectory()) throw new Error();
    } catch {
      throw new Error(`${folder} does not exist or is not a directory.`);
    }
    name =
      typeof name === "string" && name.trim() ? name.trim() : basename(path);
    if (!name || name.length > 60)
      throw new Error("Name the workspace (1-60 characters).");
    if (this.records.some((r) => r.name.toLowerCase() === name.toLowerCase()))
      throw new Error(
        `Another workspace is already called ${name}. Pass --name.`,
      );
    const data = await realpath(this.config.dataDir);
    if (within(data, path))
      throw new Error("Pelican's private data cannot be a workspace.");
    const duplicate = this.records.find((r) => fold(r.folder) === fold(path));
    if (duplicate)
      throw new Error(
        `The ${duplicate.name} workspace (${duplicate.id}) already uses this folder.`,
      );
    const id = `${slug(name)}-${randomBytes(2).toString("hex")}`;
    const record = {
      id,
      name,
      folder: path,
      dir: join("workspaces", id),
      createdAt: new Date().toISOString(),
    };
    await this.boot(record);
    await this.persist();
    this.fleets.get(id).schedule();
    return {
      ...this.summary(record),
      // Agents in different workspaces do not share path reservations.
      overlaps: this.records
        .filter((r) => r !== record && overlapping(r.folder, path))
        .map((r) => r.id),
    };
  }
  // Only a quiet workspace can go. Its own data directory goes with it; the
  // first workspace's data lives in Pelican's data folder and stays there.
  async remove(ref) {
    const record = this.record(ref);
    const fleet = this.fleets.get(record.id);
    const busy = [...fleet.jobs.values()].filter(
      (job) => liveStates.has(job.status) || fleet.active.has(job.id),
    );
    if (busy.length)
      throw failure(
        409,
        `${record.name} has ${busy.length} agent${busy.length === 1 ? "" : "s"} running or queued. Stop them first: pelican stop --all --workspace ${record.id}`,
      );
    await fleet.shutdown();
    fleet.store.close();
    this.records = this.records.filter((r) => r !== record);
    this.fleets.delete(record.id);
    await this.persist();
    const dir = this.directory(record);
    if (record.dir)
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    return {
      removed: record.id,
      name: record.name,
      folder: record.folder,
      data: record.dir ? { removed: dir } : { kept: dir },
    };
  }
  schedule() {
    for (const fleet of this.fleets.values()) fleet.schedule();
  }
  // Agents running or queued to run, in every workspace.
  busy() {
    let n = 0;
    for (const fleet of this.fleets.values()) n += fleet.busy();
    return n;
  }
  async prune() {
    for (const fleet of this.fleets.values()) await fleet.prune();
  }
  async shutdown() {
    this.closing = true;
    this.emit("closing");
    await Promise.all([...this.fleets.values()].map((f) => f.shutdown()));
  }
  close() {
    for (const fleet of this.fleets.values()) fleet.store.close();
  }
}
