import { z } from "zod";

export const effortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
// What a caller gives an agent. Sandbox and approvals are not part of it:
// every agent runs in Codex auto mode (worker-permissions.js), with network
// access as its workspace's setting says. Model and effort default to the
// workspace's.
export const briefSchema = z
  .object({
    name: z.string().trim().min(1).max(140),
    prompt: z.string().trim().min(1).max(150000),
    cwd: z.string().min(1).optional(),
    resources: z.array(z.string().min(1)).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    effort: effortSchema.optional(),
    resultSchema: z.record(z.string(), z.unknown()).optional(),
    dependsOn: z.array(z.string().min(1)).default([]),
    priority: z.number().int().min(-100).max(100).default(0),
  })
  .strict();
// One workspace's settings. The folder is fixed when the workspace is added.
export const defaultSettings = Object.freeze({
  concurrency: 4,
  paused: false,
  model: "gpt-6.1-sol",
  effort: "high",
  network: false,
});
export const settingsSchema = z
  .object({
    concurrency: z.number().int().min(1).max(64).optional(),
    paused: z.boolean().optional(),
    model: z.string().trim().min(1).max(100).optional(),
    effort: effortSchema.optional(),
    network: z.boolean().optional(),
  })
  .strict();
export const textSchema = z.string().trim().min(1).max(150000);
// Who is calling: every orchestrator names itself, and its agents' questions
// come back to that name.
export const callerSchema = z
  .string()
  .trim()
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} ._:@/+-]{0,63}$/u,
    "A caller name is 1-64 letters, digits, spaces or . _ : @ / + - and starts with a letter or digit.",
  );
