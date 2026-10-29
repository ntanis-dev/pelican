import {
  appendFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const logPattern =
  /^(?:service-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log|service\.(?:stdout|stderr)\.log)$/;
export function pruneLogs(dataDir, now = Date.now(), wipe = false) {
  const files = readdirSync(dataDir)
    .filter((name) => logPattern.test(name))
    .map((name) => {
      const path = join(dataDir, name);
      return { path, ...statSync(path) };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let total = 0;
  for (const file of files) {
    total += file.size;
    if (wipe || file.mtimeMs < now - 7 * 86400000 || total > 50 * 1024 * 1024) {
      try {
        unlinkSync(file.path);
      } catch {
        writeFileSync(file.path, "");
      }
    }
  }
}
export function installLogging(dataDir) {
  pruneLogs(dataDir);
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      const day = new Date().toISOString().slice(0, 10);
      let part = 0,
        path;
      do {
        path = join(dataDir, `service-${day}${part ? `.${part}` : ""}.log`);
        part++;
      } while (existsSync(path) && statSync(path).size >= 5 * 1024 * 1024);
      try {
        appendFileSync(
          path,
          chunk,
          typeof encoding === "string" ? encoding : undefined,
        );
      } catch {
        /* Logging must not prevent shutdown or serving requests. */
      }
      return original(chunk, encoding, callback);
    };
  }
}
