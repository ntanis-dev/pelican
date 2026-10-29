import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./config.js";
import { reads } from "./api.js";
import { facade } from "./facade.js";

// Talks to the running service over its HTTP RPC. The CLI, the MCP server
// and workflows use it; every call carries who is calling (as), the
// workspace it named and the folder it works in.
const resetCodes = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const transportCode = (error) => error.cause?.code || error.code || error.name;

export const dataDir = () =>
  resolve(process.env.PELICAN_DATA_DIR ?? resolve(root, ".pelican"));

export async function connection() {
  const dir = dataDir();
  let saved;
  try {
    saved = JSON.parse(await readFile(resolve(dir, "connection.json"), "utf8"));
  } catch {
    saved = {};
  }
  const url = process.env.PELICAN_URL ?? saved.url ?? "http://127.0.0.1:4319";
  let token = process.env.PELICAN_TOKEN;
  if (!token)
    try {
      token = (await readFile(resolve(dir, "token"), "utf8")).trim();
    } catch {
      throw Object.assign(
        new Error(
          `Pelican has no access token yet (${resolve(dir, "token")}). Start it once: pelican start`,
        ),
        { code: "PELICAN_DOWN" },
      );
    }
  return { url, token, pid: saved.pid ?? null };
}

function headers(token, { as, workspace, cwd }) {
  const h = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  for (const [name, value] of [
    ["x-pelican-as", as],
    ["x-pelican-workspace", workspace],
    ["x-pelican-cwd", cwd],
  ])
    if (value !== undefined && value !== null && value !== "")
      h[name] = encodeURIComponent(value);
  return h;
}

// With autostart, a call that finds no service starts one (once) and goes on:
// Pelican runs only while something uses it. A PELICAN_URL names a service
// somewhere else, which is never started.
export async function rpc(
  method,
  params = {},
  context = {},
  { autostart = false } = {},
) {
  const wait = Number(params?.timeoutMs) || 0;
  let starting = autostart && !process.env.PELICAN_URL;
  const start = async () => {
    starting = false;
    const { startService } = await import("./service.js");
    await startService();
  };
  let conn;
  try {
    conn = await connection();
  } catch (error) {
    // The first start makes the token.
    if (!starting || error.code !== "PELICAN_DOWN") throw error;
    await start();
    conn = await connection();
  }
  let { url, token } = conn;
  const request = {
    method: "POST",
    headers: headers(token, context),
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(60000 + wait),
  };
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url + "/api/rpc", request);
      break;
    } catch (error) {
      const code = transportCode(error);
      if (code === "ECONNREFUSED" && starting) {
        await start();
        ({ url, token } = await connection());
        request.headers = headers(token, context);
        request.signal = AbortSignal.timeout(60000 + wait);
        continue;
      }
      if (code === "ECONNREFUSED")
        throw Object.assign(
          new Error(
            `Pelican is not running (nothing answers at ${url}). Start it: pelican start`,
          ),
          { code: "PELICAN_DOWN", cause: error },
        );
      if (attempt || !reads.has(method) || !resetCodes.has(code))
        throw new Error(`${method} failed: ${error.message}`, { cause: error });
      // A fresh connection avoids repeating a stale keep-alive socket race.
      request.headers.connection = "close";
    }
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error)
    throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), {
      statusCode: response.status,
    });
  return body.result;
}

export async function health() {
  const { url, token } = await connection();
  try {
    const response = await fetch(url + "/api/health", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return { url, ...(await response.json()) };
  } catch {
    return null;
  }
}

// The gateway's calls as methods over HTTP (see facade.js):
//   const pelican = connect({ as: "lead" });
//   const agent = await pelican.spawn({ name, prompt, resultSchema });
//   const { agents } = await pelican.wait([agent.id]);
export function connect({
  as = process.env.PELICAN_AS,
  workspace = process.env.PELICAN_WORKSPACE,
  cwd = process.cwd(),
  autostart = true,
} = {}) {
  const context = { as, workspace, cwd };
  return facade(
    (method, params = {}) => rpc(method, params, context, { autostart }),
    context,
  );
}
