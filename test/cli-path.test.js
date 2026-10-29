import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexBin } from "../src/cli-path.js";

test("Windows CLI discovery honors explicit paths and PATH before the installed desktop CLI", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pelican-cli-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const older = join(dir, "OpenAI", "Codex", "bin", "old", "codex.exe");
  const newer = join(dir, "OpenAI", "Codex", "bin", "new", "codex.exe");
  for (const path of [older, newer]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "fixture only");
  }
  await utimes(older, 100, 100);
  await utimes(newer, 200, 200);
  const env = { PATH: "", LOCALAPPDATA: dir };
  assert.equal(resolveCodexBin("codex", env, "win32"), newer);
  assert.equal(resolveCodexBin(older, env, "win32"), older);
  assert.equal(resolveCodexBin("custom-cli", env, "win32"), "custom-cli");
  assert.equal(resolveCodexBin("codex", env, "linux"), "codex");
  assert.equal(resolveCodexBin("codex", { PATH: "" }, "win32"), "codex");
  const pathDir = join(dir, "custom path");
  await mkdir(pathDir);
  await writeFile(join(pathDir, "codex.cmd"), "fixture only");
  assert.equal(
    resolveCodexBin("codex", { ...env, PATH: `"${pathDir}"` }, "win32"),
    join(pathDir, "codex.cmd"),
  );
});
