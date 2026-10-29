import { z } from "zod";

// A spawn may carry resultSchema, a JSON Schema for the agent's structured
// result. The agent hands its result to pelican_report as JSON text; Pelican
// validates it here and tells the agent what to fix.
const compiled = new WeakMap();
const limit = 4000;
const clip = (text) =>
  text.length > limit ? `${text.slice(0, limit)} [truncated]` : text;

export function compileResultSchema(schema) {
  if (schema === undefined || schema === null) return null;
  if (typeof schema !== "object" || Array.isArray(schema))
    throw new Error("resultSchema must be a JSON Schema object.");
  if (compiled.has(schema)) return compiled.get(schema);
  let validator;
  try {
    validator = z.fromJSONSchema(schema);
  } catch (error) {
    throw new Error(
      `resultSchema is not a usable JSON Schema: ${error.message}`,
    );
  }
  compiled.set(schema, validator);
  return validator;
}

// The value of a result the agent gave: JSON text is parsed; anything else is
// taken as given.
export function parseResult(value) {
  if (typeof value !== "string") return { value };
  const text = value.trim();
  if (!text) return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { value: text, parseError: error.message };
  }
}

// { ok, value, error }: error is the message the agent sees when it must try
// again.
export function checkResult(schema, raw) {
  const { value, parseError } = parseResult(raw);
  if (!schema)
    return { ok: true, value: value === undefined ? null : value, error: null };
  if (value === undefined)
    return {
      ok: false,
      value: null,
      error:
        "No result was given. Call pelican_report with result: JSON text that matches the result schema.",
    };
  if (parseError)
    return {
      ok: false,
      value: null,
      error: clip(`The result is not valid JSON (${parseError}).`),
    };
  const parsed = compileResultSchema(schema).safeParse(value);
  if (parsed.success) return { ok: true, value, error: null };
  return {
    ok: false,
    value: null,
    error: clip(
      `The result does not match the result schema:\n${z.prettifyError(parsed.error)}`,
    ),
  };
}
