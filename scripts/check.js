import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
for (const dir of [
  "src",
  "src/menu",
  "src/menu/views",
  "src/menu/ui",
  "scripts",
  "test",
  "test/fixtures",
]) {
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".js")) continue;
    const result = spawnSync(process.execPath, ["--check", join(dir, file)], {
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
// Example workflows are scripts for the runner (top-level return), not
// modules: the runner's own parser checks them.
const { parseWorkflow } = await import("../src/workflow.js");
for (const file of await readdir("examples")) {
  if (!file.endsWith(".js")) continue;
  try {
    parseWorkflow(
      await readFile(join("examples", file), "utf8"),
      join("examples", file),
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
console.log("JavaScript syntax checks passed.");
