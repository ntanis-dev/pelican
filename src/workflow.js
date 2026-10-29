import vm from "node:vm";
import { z } from "zod";

// A workflow script, as Claude Code's workflow runner takes it:
//
//   export const meta = { name, description, phases: [{ title, detail }] };
//   phase("Build");
//   const result = await agent("...", { schema, label });
//   return result;
//
// meta is a plain object literal. The body runs inside an async function, so
// top-level await and a top-level return (the run's result) both work; a
// script may instead export default an async function, which is called with
// args and whose return value is the result. The body sees only the injected
// globals (args, agent, parallel, pipeline, phase, log) and the language's
// built-ins: no import, require, process or file system.
const phaseSchema = z
  .object({
    title: z.string().trim().min(1).max(140),
    detail: z.string().max(2000).optional(),
  })
  .passthrough();
export const metaSchema = z
  .object({
    name: z.string().trim().min(1).max(140),
    description: z.string().trim().min(1).max(2000),
    whenToUse: z.string().max(4000).optional(),
    phases: z.array(phaseSchema).max(100).optional(),
  })
  .passthrough();
const problem = (message) =>
  Object.assign(new Error(message), { statusCode: 400 });

// Where a regular expression may start: after these characters or words a
// "/" begins one, elsewhere it divides.
const regexAfter = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const regexWords = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
function quoted(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === quote) return j + 1;
    else if (src[j] === "\n") return j;
  }
  return src.length;
}
function regex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "\n") return j;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "/") {
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      return j;
    }
  }
  return src.length;
}
// Which characters are top-level code (outside strings, templates, comments,
// regular expressions and every bracket), and where each top-level "{"
// closes. Enough of a tokenizer to find `export` statements and the end of
// the meta literal; the compiler checks the rest.
function scan(src) {
  const top = new Uint8Array(src.length);
  const close = new Map();
  const holes = [];
  let depth = 0,
    template = false,
    prev = null,
    open = -1,
    i = 0;
  while (i < src.length) {
    const c = src[i];
    if (template) {
      if (c === "\\") i += 2;
      else if (c === "`") {
        template = false;
        prev = "x";
        i++;
      } else if (c === "$" && src[i + 1] === "{") {
        holes.push(depth++);
        template = false;
        prev = "(";
        i += 2;
      } else i++;
      continue;
    }
    if (depth === 0) top[i] = 1;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      i = quoted(src, i);
      prev = "x";
    } else if (c === "`") {
      template = true;
      i++;
    } else if (c === "/" && (prev === null || regexAfter.has(prev))) {
      i = regex(src, i);
      prev = "x";
    } else if (c === "{" || c === "(" || c === "[") {
      if (depth === 0 && c === "{") open = i;
      depth++;
      prev = c;
      i++;
    } else if (c === "}" || c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      i++;
      if (c === "}" && holes.length && holes.at(-1) === depth) {
        holes.pop();
        template = true;
        continue;
      }
      if (c === "}" && depth === 0 && open >= 0) {
        close.set(open, i - 1);
        open = -1;
      }
      prev = c === "}" ? "}" : "x";
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      prev = regexWords.has(src.slice(i, j)) ? "(" : "x";
      i = j;
    } else if (/\s/.test(c)) i++;
    else {
      prev = /[\w.]/.test(c) ? "x" : c;
      i++;
    }
  }
  return { top, close };
}
const syntaxLine = (error) =>
  /:(\d+)\r?\n/.exec(String(error?.stack ?? ""))?.[1];

// The script's meta and the code the worker runs. Throws (status 400) with
// what to fix: a missing or computed meta, an unsupported export, a syntax
// error with its line.
export function parseWorkflow(source, filename = "workflow.js") {
  let text = String(source ?? "");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.startsWith("#!")) text = `//${text.slice(2)}`;
  const { top, close } = scan(text);
  const lineStart = (index) =>
    /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index));
  const find = (pattern) =>
    [...text.matchAll(pattern)].filter(
      (m) => top[m.index] === 1 && lineStart(m.index),
    );
  const metas = find(/export[ \t]+const[ \t]+meta[ \t]*=[ \t]*/g);
  if (!metas.length)
    throw problem(
      `${filename}: a workflow starts with export const meta = { name, description } (a plain object literal).`,
    );
  if (metas.length > 1) throw problem(`${filename}: meta is declared twice.`);
  const [declaration] = metas;
  const open = declaration.index + declaration[0].length;
  if (text[open] !== "{" || !close.has(open))
    throw problem(
      `${filename}: meta must be an object literal: export const meta = { name: "...", description: "..." }.`,
    );
  let meta;
  try {
    const literal = text.slice(open, close.get(open) + 1);
    meta = JSON.parse(
      JSON.stringify(
        vm.runInNewContext(`(${literal})`, Object.create(null), {
          timeout: 250,
          filename,
        }),
      ),
    );
  } catch (error) {
    throw problem(
      `${filename}: meta must be a plain literal, without variables or calls (${error.message}).`,
    );
  }
  const checked = metaSchema.safeParse(meta);
  if (!checked.success)
    throw problem(`${filename}: meta: ${z.prettifyError(checked.error)}`);
  if (find(/export[ \t]*[{*]/g).length)
    throw problem(
      `${filename}: only export const meta and export default are supported.`,
    );
  // Same lines, same columns where it matters: errors point into the file.
  const edits = [
    {
      at: declaration.index,
      length: /^export[ \t]+/.exec(declaration[0])[0].length,
      text: "",
    },
    ...find(/export[ \t]+default[ \t]+/g).map((m) => ({
      at: m.index,
      length: m[0].length,
      text: "__pelicanDefault = ",
    })),
    ...find(/export[ \t]+(?=(?:const|let|var|function|async|class)\b)/g)
      .filter((m) => m.index !== declaration.index)
      .map((m) => ({ at: m.index, length: m[0].length, text: "" })),
  ].sort((a, b) => b.at - a.at);
  let body = text;
  for (const edit of edits)
    body =
      body.slice(0, edit.at) + edit.text + body.slice(edit.at + edit.length);
  const code = `(async () => { let __pelicanDefault; ${body}\n;if (typeof __pelicanDefault === "function") return await __pelicanDefault(args);\n})()`;
  try {
    new vm.Script(code, { filename });
  } catch (error) {
    const line = syntaxLine(error);
    throw problem(
      `${filename}${line ? `:${line}` : ""}: ${error.message}${/import/.test(error.message) ? " (workflows cannot import modules; use the injected globals)" : ""}`,
    );
  }
  const phases = [];
  for (const { title, detail } of checked.data.phases ?? [])
    if (!phases.some((p) => p.title === title))
      phases.push({ title, ...(detail ? { detail } : {}) });
  return {
    meta: {
      name: checked.data.name,
      description: checked.data.description,
      ...(checked.data.whenToUse ? { whenToUse: checked.data.whenToUse } : {}),
      phases,
    },
    code,
    filename,
  };
}

// Compiled inside the run's context (by its source text), so everything it
// makes belongs to that context. host is the worker's bridge to the service;
// values cross it as JSON text.
export function prelude(host, argsJson) {
  const { parse, stringify } = JSON;
  const text = (value) => {
    if (typeof value === "string") return value;
    try {
      return stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const reason = (error) => (error && error.message) || String(error);
  let current = null;
  const log = (...parts) => {
    host.log(parts.map(text).join(" "));
  };
  const phase = (title) => {
    current = String(title);
    host.phase(current);
  };
  const agent = (prompt, opts) =>
    new Promise((resolve, reject) => {
      let payload;
      try {
        payload = stringify({ prompt, opts: opts ?? {} });
      } catch (error) {
        reject(new TypeError(`agent() options must be JSON: ${reason(error)}`));
        return;
      }
      host.agent(payload, current).then(
        (json) => resolve(parse(json)),
        (message) => reject(new Error(String(message))),
      );
    });
  const items = (list, name) => {
    if (!Array.isArray(list)) throw new TypeError(`${name}() takes an array.`);
    if (list.length > 4096)
      throw new RangeError(`${name}() takes at most 4096 items.`);
  };
  // A barrier: every thunk runs at once; one that throws gives null.
  const parallel = (thunks) => {
    items(thunks, "parallel");
    return Promise.all(
      thunks.map((thunk, index) => {
        try {
          return Promise.resolve(
            typeof thunk === "function" ? thunk() : thunk,
          ).catch((error) => {
            log(`parallel item ${index} failed: ${reason(error)}`);
            return null;
          });
        } catch (error) {
          log(`parallel item ${index} failed: ${reason(error)}`);
          return Promise.resolve(null);
        }
      }),
    );
  };
  // No barrier: each item goes through every stage on its own. A stage gets
  // (previous result, original item, index); one that throws drops the item
  // to null and skips its remaining stages.
  const pipeline = (list, ...stages) => {
    items(list, "pipeline");
    return Promise.all(
      list.map(async (item, index) => {
        let value = item;
        for (let s = 0; s < stages.length; s++) {
          try {
            value = await stages[s](value, item, index);
          } catch (error) {
            log(
              `pipeline item ${index}, stage ${s + 1} failed: ${reason(error)}`,
            );
            return null;
          }
        }
        return value;
      }),
    );
  };
  // Claude Code workflow globals Pelican has no counterpart for.
  const budget = Object.freeze({
    total: null,
    spent: () => 0,
    remaining: () => Infinity,
  });
  const workflow = () =>
    Promise.reject(
      new Error("Pelican workflows do not nest: workflow() is not available."),
    );
  const console = { log, info: log, warn: log, error: log, debug: log };
  Object.assign(globalThis, {
    args: argsJson === undefined ? undefined : parse(argsJson),
    agent,
    parallel,
    pipeline,
    phase,
    log,
    budget,
    workflow,
    console,
  });
}
