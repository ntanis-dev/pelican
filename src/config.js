import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function loadConfig(overrides = {}) {
  const dataDir = resolve(
    overrides.dataDir ??
      process.env.PELICAN_DATA_DIR ??
      resolve(root, ".pelican"),
  );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = resolve(dataDir, "token");
  let token = overrides.token ?? process.env.PELICAN_TOKEN;
  if (!token) {
    try {
      token = (await readFile(tokenPath, "utf8")).trim();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      token = randomBytes(32).toString("hex");
      try {
        await writeFile(tokenPath, token, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        token = (await readFile(tokenPath, "utf8")).trim();
      }
    }
  }
  if (token.length < 24)
    throw new Error("PELICAN_TOKEN must contain at least 24 characters");
  const host = overrides.host ?? process.env.PELICAN_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error(
      "Bind Pelican to loopback; use an authenticated tunnel for remote access",
    );
  const port = Number(overrides.port ?? process.env.PELICAN_PORT ?? 4319);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  const windowsSandbox =
    overrides.windowsSandbox ?? process.env.PELICAN_WINDOWS_SANDBOX ?? "auto";
  if (!["auto", "elevated", "unelevated", "mxc"].includes(windowsSandbox))
    throw new Error("Invalid PELICAN_WINDOWS_SANDBOX implementation");
  // How long the service stays up with nothing to do.
  const idleMinutes = Number(
    overrides.idleMinutes ?? process.env.PELICAN_IDLE_MINUTES ?? 5,
  );
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0)
    throw new Error("PELICAN_IDLE_MINUTES must be a number of minutes above 0");
  return {
    dataDir,
    idleMinutes,
    token,
    tokenPath,
    host,
    port,
    windowsSandbox,
    codexBin: overrides.codexBin ?? process.env.CODEX_BIN ?? "codex",
    ...overrides,
  };
}
// Where a workspace keeps its own data. Privacy checks always use dataDir,
// which contains every workspace.
export const stateDir = (config) => config.workspaceDir ?? config.dataDir;
