import { readFile, writeFile, unlink, open } from "node:fs/promises";
import { resolve } from "node:path";

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid Pelican service PID");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function acquireServiceLock(config, nonce, alive = processAlive) {
  const path = resolve(config.dataDir, "service.lock");
  const record = JSON.stringify({ pid: process.pid, nonce });
  const create = () => writeFile(path, record, { flag: "wx", mode: 0o600 });
  const release = async () => {
    try {
      if ((await readFile(path, "utf8")) === record) await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  try {
    await create();
    return { acquired: true, release };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let previous = JSON.parse(await readFile(path, "utf8"));
  if (!alive(previous.pid)) {
    // Serialize stale-lock recovery so two restarters cannot unlink each other's lease.
    const guardPath = path + ".recovery";
    let guard;
    try {
      guard = await open(guardPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error(
        "Another Pelican start is recovering the service lock. Try again shortly.",
      );
    }
    try {
      try {
        previous = JSON.parse(await readFile(path, "utf8"));
        if (!alive(previous.pid)) await unlink(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        await create();
        return { acquired: true, release };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      previous = JSON.parse(await readFile(path, "utf8"));
    } finally {
      await guard.close();
      await unlink(guardPath);
    }
  }
  let url = `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`;
  try {
    const saved = JSON.parse(
      await readFile(resolve(config.dataDir, "connection.json"), "utf8"),
    );
    const candidate = new URL(saved.url);
    if (
      saved.pid === previous.pid &&
      candidate.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(candidate.hostname) &&
      !candidate.username &&
      !candidate.password
    )
      url = candidate.origin;
  } catch {
    /* The owner may still be starting. */
  }
  let responsive = false;
  try {
    const response = await fetch(url + "/api/health", {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(2000),
    });
    const health = await response.json();
    responsive =
      response.ok &&
      health.service === "pelican" &&
      health.pid === previous.pid &&
      health.instance === previous.nonce;
  } catch {
    /* A live PID is not proof of a responsive service. */
  }
  return { acquired: false, pid: previous.pid, url, responsive };
}
