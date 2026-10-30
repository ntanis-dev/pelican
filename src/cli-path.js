import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

// How to run the Codex CLI without a shell: an executable, or Node with the
// npm package's launcher when only a .cmd shim is on PATH.
export function codexLaunch(bin = "codex") {
  const executable = resolveCodexBin(bin);
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(executable))
    return { command: executable, prefix: [] };
  const launcher = join(
    dirname(executable),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (!existsSync(launcher))
    throw new Error(
      "Set CODEX_BIN to codex.exe; the Codex shell shim cannot be launched directly.",
    );
  return { command: process.execPath, prefix: [launcher] };
}

export function resolveCodexBin(
  bin,
  env = process.env,
  platform = process.platform,
) {
  if (platform !== "win32" || isAbsolute(bin)) return bin;
  const extensions = /\.(exe|cmd|bat)$/i.test(bin) ? [""] : [".exe", ".cmd"];
  const onPath = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) =>
      extensions.map((ext) => join(dir.replace(/^"|"$/g, ""), bin + ext)),
    )
    .find(existsSync);
  if (onPath) return onPath;

  // A terminal launched outside the desktop app does not inherit its CLI PATH.
  // Use the installed desktop CLI only for the default executable name.
  if (!/^codex(?:\.exe)?$/i.test(bin) || !env.LOCALAPPDATA) return bin;
  const bundled = join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  try {
    return (
      readdirSync(bundled, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(bundled, entry.name, "codex.exe"))
        .filter(existsSync)
        .map((path) => ({ path, modified: statSync(path).mtimeMs }))
        .sort((a, b) => b.modified - a.modified)[0]?.path ?? bin
    );
  } catch {
    return bin;
  }
}
