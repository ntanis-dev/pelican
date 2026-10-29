import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { CodexAccount } from "./account.js";
import { Gateway } from "./gateway.js";
import { Workspaces } from "./workspaces.js";

// The HTTP face of the gateway: POST /api/rpc {method, params} with the token
// from .pelican/token. Headers carry the caller's context: x-pelican-as (its
// name), x-pelican-workspace and x-pelican-cwd (URI-encoded).
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, value) => {
  if (res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const header = (req, name) => {
  const value = req.headers[name];
  if (typeof value !== "string" || !value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024)
      throw Object.assign(new Error("Request too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 });
  }
}

export async function createServer({
  config,
  gateway,
  workspaces,
  fleet,
  account,
}) {
  const ownAccount = !gateway && !account;
  account ??= new CodexAccount({ config });
  gateway ??= new Gateway(workspaces ?? Workspaces.single(fleet), { account });
  const hub = gateway.hub;
  let port;
  // Loopback only, by name and port: a page elsewhere cannot rebind to it.
  const validHost = (req) => {
    try {
      const url = new URL("http://" + req.headers.host);
      return (
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        Number(url.port) === port
      );
    } catch {
      return false;
    }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    try {
      // Browsers are not clients: any Origin is refused.
      if (!validHost(req) || req.headers.origin)
        return json(res, 403, { error: "Invalid host or origin" });
      if (
        !equal(req.headers.authorization?.replace(/^Bearer /, ""), config.token)
      )
        return json(res, 401, {
          error: "Send the token from .pelican/token as a Bearer token.",
        });
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/api/health" && req.method === "GET")
        return json(res, 200, {
          service: "pelican",
          pid: process.pid,
          instance: config.instanceId,
          active: [...hub.fleets.values()].reduce(
            (n, f) => n + f.active.size,
            0,
          ),
          workspaces: hub.records.length,
        });
      if (path !== "/api/rpc" || req.method !== "POST")
        return json(res, 404, { error: "Not found" });
      const { method, params } = await body(req);
      const cancellation = new AbortController();
      const cancel = () => cancellation.abort();
      res.once("close", cancel);
      try {
        const result = await gateway.invoke(
          String(method ?? ""),
          params,
          {
            as: header(req, "x-pelican-as"),
            workspace: header(req, "x-pelican-workspace"),
            cwd: header(req, "x-pelican-cwd"),
          },
          { signal: cancellation.signal },
        );
        return json(res, 200, { result: result ?? null });
      } finally {
        res.off("close", cancel);
      }
    } catch (error) {
      if (!res.headersSent)
        json(res, error.statusCode ?? 400, { error: error.message });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  port = server.address().port;
  const origin = `http://${config.host === "::1" ? "[::1]" : config.host}:${port}`;
  gateway.service.url = origin;
  return {
    origin,
    server,
    gateway,
    async close() {
      if (ownAccount) await account.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
