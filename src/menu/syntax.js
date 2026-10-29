import { clean } from "./text.js";

// Colour for what a conversation is made of, so a command, its files and its
// output are not one block of white text. Three small lexers, none of them a
// real parser: code (a shell script or the program fed to it), prose (what
// agents write) and output (what a command printed). Each gives lines of
// spans, [text, style], which the pane wraps like any other.
//
//   commands        accent bold      flags and JSON keys   info
//   strings         ok               paths and files       beak
//   variables       stop             keywords              stop
//   punctuation     muted            comments              muted italic
const tone = {
  command: "accent bold",
  keyword: "stop",
  variable: "stop",
  flag: "info",
  key: "info",
  string: "ok",
  path: "beak",
  op: "muted",
  comment: "muted italic",
};

const exts =
  "ts|tsx|js|mjs|cjs|jsx|json|jsonl|md|mdx|yml|yaml|toml|rs|go|py|rb|sh|ps1|cmd|bat|exe|dll|css|scss|html|htm|xml|txt|csv|tsv|sql|lock|log|diff|patch|ini|cfg|conf|svg|png|jpg|gif|pdf|zip|tgz|gz|db|sqlite";
const keywords = new Set(
  (
    "const let var function return if else elseif for foreach while do switch case break continue " +
    "throw try catch finally new class extends import export from default await async yield " +
    "of in typeof instanceof delete void null true false undefined param exit"
  ).split(" "),
);

// A path or a file name, not a fraction (71/71) or a pair of words (and/or):
// it has an extension, three or more parts, or begins as a path does. In a
// command (loose) any two parts will do: dir/dir is a folder there.
const extension = new RegExp(String.raw`\.(?:${exts})$`, "i");
function pathLike(text, loose = false) {
  if (/^\d+(?:[\\/]\d+)+$/.test(text)) return false;
  if (/^[A-Za-z]:[\\/]./.test(text) || /^(?:\.{1,2}|~)[\\/]./.test(text))
    return true;
  const parts = text.split(/[\\/]/).filter(Boolean);
  if (parts.length >= (loose ? 2 : 3)) return true;
  return extension.test(parts.at(-1) ?? "");
}
// A match that swallowed the punctuation after it ("NOTES.md.", "a/b,"). A
// loop, not a regex: over a long run of dots a regex reads the run again from
// every position.
function trimmed(raw) {
  let end = raw.length;
  while (end > 0 && ".,;:!?)]}".includes(raw[end - 1])) end--;
  return end > 0 && end < raw.length
    ? [raw.slice(0, end), raw.slice(end)]
    : [raw, ""];
}

const part = String.raw`[\w.@~+%-]`;
const pathSource = [
  String.raw`[A-Za-z]:[\\/][\w.@~+%\\/-]*`,
  String.raw`(?:\.{1,2}|~)?[\\/]${part}+(?:[\\/]${part}+)*`,
  // A path starts where a run of path characters starts, not inside it: else
  // every position of a long run is a start that reads the rest of the run.
  String.raw`(?<!${part})${part}+(?:[\\/]${part}+)+`,
].join("|");
const fileSource = String.raw`(?<![\w.-])[\w.-]+\.(?:${exts})(?![\w(])(?!\.\w)`;

const codeLexer = new RegExp(
  [
    String.raw`(?<ws>\s+)`,
    String.raw`(?<comment>(?<![\w:/.$-])(?:#|//)[^\n]*)`,
    String.raw`(?<string>"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|\x60(?:[^\x60\\]|\\.)*\x60?)`,
    String.raw`(?<variable>\$\{[^}\n]*\}|\$[\w:?]+)`,
    `(?<path>${pathSource})`,
    String.raw`(?<flag>(?<![\w-])-{1,2}[A-Za-z][\w-]*)`,
    `(?<file>${fileSource})`,
    String.raw`(?<word>[A-Za-z_]\w*(?:-[A-Za-z_]\w*)*)`,
    String.raw`(?<number>\d+(?:\.\d+)?)`,
    String.raw`(?<op>[|;&<>(){}\[\],=+*!?:.\\/-])`,
    String.raw`(?<other>[\s\S])`,
  ].join("|"),
  "gu",
);
const starts = new Set(["|", ";", "&", "(", "{"]);

function lexCode(text, shell, out) {
  // A shell's command is the first word of each statement; inside a program
  // fed to it (a here-string) there is no such place.
  let command = shell;
  for (const match of text.matchAll(codeLexer)) {
    const raw = match[0];
    const kind = Object.keys(match.groups).find(
      (k) => match.groups[k] !== undefined,
    );
    let style = "";
    switch (kind) {
      case "ws":
        if (shell && raw.includes("\n")) command = true;
        break;
      case "comment":
        style = tone.comment;
        break;
      case "string": {
        const after = text.slice(match.index + raw.length);
        style = /^\s*:(?!:)/.test(after) ? tone.key : tone.string;
        command = false;
        break;
      }
      case "variable":
        style = tone.variable;
        command = false;
        break;
      case "path":
        style = pathLike(raw, true) ? (command ? tone.command : tone.path) : "";
        command = false;
        break;
      case "flag":
        style = tone.flag;
        break;
      case "file":
        style = command ? tone.command : tone.path;
        command = false;
        break;
      case "word":
        style = keywords.has(raw) ? tone.keyword : command ? tone.command : "";
        command = false;
        break;
      case "op":
        style = tone.op;
        command = shell && starts.has(raw);
        break;
      case "other":
        style = raw === "…" ? tone.op : "";
        command = false;
        break;
      default:
        command = false;
    }
    out.push([raw, style]);
  }
}

const hereString = /(@'[\s\S]*?'@|@"[\s\S]*?"@)/;
// Past this much text is left uncoloured: it is a dump, not something to read
// in colour, and the pane has to stay quick whatever an agent printed.
const limit = 50000;
// A script as spans: the shell around a here-string is read as a shell, the
// program inside it as a program, and its @' and '@ stay quiet.
function codeSpans(text) {
  const out = [];
  if (String(text ?? "").length > limit) return [[clean(text), ""]];
  clean(text)
    .split(hereString)
    .forEach((piece, i) => {
      if (i % 2 === 0) return lexCode(piece, true, out);
      out.push([piece.slice(0, 2), tone.op]);
      lexCode(piece.slice(2, -2), false, out);
      out.push([piece.slice(-2), tone.op]);
    });
  return merge(out);
}

// Neighbours in one style become one span.
function merge(spans) {
  const out = [];
  for (const [text, style] of spans) {
    if (!text) continue;
    if (out.length && out.at(-1)[1] === style) out.at(-1)[0] += text;
    else out.push([text, style]);
  }
  return out;
}
// Spans (which may hold newlines) as lines of spans.
function lines(spans) {
  const out = [[]];
  for (const [text, style] of spans) {
    const pieces = text.split("\n");
    pieces.forEach((piece, i) => {
      if (i) out.push([]);
      if (piece) out.at(-1).push([piece, style]);
    });
  }
  return out;
}

// A script, or a program, as lines of spans.
export const codeLines = (text) => lines(codeSpans(text));
// One line of it, such as a summary: no newlines.
export const codeLine = (text) => codeSpans(text);

// What an agent wrote: `code`, links, paths and file names, --flags; the rest
// in the style it came in (italic and muted for its thinking, say).
const proseLexer = new RegExp(
  [
    String.raw`(?<code>\x60[^\x60\n]+\x60)`,
    String.raw`(?<url>https?://[^\s<>"')\]]+)`,
    `(?<path>${pathSource})`,
    `(?<file>${fileSource})`,
    String.raw`(?<flag>(?<![\w-])--[a-z][\w-]+)`,
  ].join("|"),
  "gu",
);
export function proseLines(text, base = "") {
  const value = clean(text);
  if (value.length > limit) return lines([[value, base]]);
  const out = [];
  const plain = (t) => out.push([t, base]);
  const styled = (t, own) => out.push([t, `${base} ${own}`.trim()]);
  let at = 0;
  for (const match of value.matchAll(proseLexer)) {
    if (match.index > at) plain(value.slice(at, match.index));
    at = match.index + match[0].length;
    const kind = Object.keys(match.groups).find(
      (k) => match.groups[k] !== undefined,
    );
    if (kind === "code") {
      styled("`", tone.op);
      styled(match[0].slice(1, -1), tone.path);
      styled("`", tone.op);
    } else if (kind === "url") {
      const [url, rest] = trimmed(match[0]);
      styled(url, "info underline");
      if (rest) plain(rest);
    } else if (kind === "flag") styled(match[0], tone.flag);
    else {
      const [name, rest] = trimmed(match[0]);
      if (pathLike(name)) styled(name, tone.path);
      else plain(name);
      if (rest) plain(rest);
    }
  }
  if (at < value.length) plain(value.slice(at));
  return lines(merge(out));
}

// What a command printed: the files it names (with the line after a colon),
// and the words that say how it went.
const outputLexer = new RegExp(
  [
    `(?<path>${pathSource}|${fileSource})(?<place>(?::\\d+){1,2})?`,
    String.raw`(?<bad>\b(?:not ok|errors?|failed|failures?|fail|exceptions?|fatal|panic)\b|✗)`,
    String.raw`(?<warn>\b(?:warn(?:ings?)?|deprecated)\b)`,
    String.raw`(?<good>\b(?:passed|pass|success(?:ful)?|ok)\b|✓)`,
  ].join("|"),
  "giu",
);
export function outputLines(text, base = "muted") {
  const value = clean(text);
  if (value.length > limit) return lines([[value, base]]);
  const out = [];
  let at = 0;
  for (const match of value.matchAll(outputLexer)) {
    if (match.index > at) out.push([value.slice(at, match.index), base]);
    at = match.index + match[0].length;
    const g = match.groups;
    if (g.path !== undefined) {
      const [name, rest] = trimmed(g.path);
      if (pathLike(name)) out.push([name, tone.path]);
      else out.push([name, base]);
      if (rest) out.push([rest, base]);
      if (g.place) out.push([g.place, base]);
    } else
      out.push([
        match[0],
        g.bad !== undefined ? "err" : g.warn !== undefined ? "warn" : "ok",
      ]);
  }
  if (at < value.length) out.push([value.slice(at), base]);
  return lines(merge(out));
}

// A list of paths, such as an edit's files.
export const pathLine = (list) =>
  merge(
    list.flatMap((name, i) => [
      ...(i ? [[", ", tone.op]] : []),
      [name, pathLike(name) ? tone.path : ""],
    ]),
  );
