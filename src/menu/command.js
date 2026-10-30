// A shell command as a person reads it: which shell it ran in, the script
// without the launcher wrapped around it, and a one-line summary for a
// collapsed row. Codex records commands the way it started them, such as
// `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "..."`.
const shells = {
  powershell: "PowerShell",
  pwsh: "PowerShell",
  bash: "bash",
  zsh: "zsh",
  sh: "sh",
  dash: "sh",
  cmd: "cmd",
};
const prompts = { PowerShell: "PS>", cmd: ">" };
const runs = /^(-command|-c|-lc|-ic|\/c|\/k)$/i;
// Flags that take a value, so the value is not mistaken for the script.
const valued = /^-(executionpolicy|ep|workingdirectory|wd)$/i;

// The script inside one pair of quotes: "Get-Content x" -> Get-Content x. A
// pair is only taken off when no unescaped quote of its kind is inside.
function unquote(text) {
  const value = text.trim(),
    q = value[0];
  if ((q !== '"' && q !== "'") || value.length < 2 || value.at(-1) !== q)
    return value;
  const inner = value.slice(1, -1);
  if (inner.replace(/\\./g, "").includes(q)) return value;
  return q === '"' ? inner.replace(/\\"/g, '"') : inner;
}

// { shell, script }: shell is null for a command that is not a shell's own
// launcher, and the script is then the whole command.
export function unwrap(command) {
  const text = String(command ?? "").trim();
  const head = /^("[^"]*"|'[^']*'|\S+)\s*/.exec(text);
  if (!head) return { shell: null, script: text };
  const program = head[1]
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]+/)
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, "");
  const shell = shells[program] ?? null;
  if (!shell) return { shell: null, script: text };
  let rest = text.slice(head[0].length);
  for (;;) {
    const flag = /^(-\S+|\/[ck])\s*/i.exec(rest);
    if (!flag) break;
    rest = rest.slice(flag[0].length);
    if (runs.test(flag[1])) return { shell, script: unquote(rest) };
    if (valued.test(flag[1])) rest = rest.replace(/^("[^"]*"|\S+)\s*/, "");
  }
  return { shell: null, script: text };
}

// What a row says of the script on one line: whitespace collapsed, and the
// body of a here-string left out (@' ... '@), since it is usually the program
// that is fed to something and the part after it is what runs.
export const summarize = (script) =>
  String(script ?? "")
    .replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, (m) => `@${m[1]} … ${m[1]}@`)
    .replace(/\s+/g, " ")
    .trim();

export const promptOf = (shell) => prompts[shell] ?? "$";

// How long a command took: 0.5s, 58.2s, 1m 12s.
export function took(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 100) return "<0.1s";
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// The lines an edit adds and removes, from its diff.
export function diffStats(diff) {
  let added = 0,
    removed = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
