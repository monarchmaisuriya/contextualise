import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const contextSourceSchema = z.enum(["map", "chat", "tag", "terminal", "project", "entry", "knowledge", "history", "updates"]);
export type ContextSource = z.infer<typeof contextSourceSchema>;
export const contextSizeSchema = z.object({ characters: z.number().int().min(0), bytes: z.number().int().min(0), tokens: z.number().int().min(0) });
export const contextReceiptSchema = contextSizeSchema.extend({
  state: z.enum(["prepared", "configured", "returned"]),
  source: contextSourceSchema,
  included: z.number().int().min(0),
  omitted: z.number().int().min(0),
  freshness: z.enum(["current", "updating", "unknown"]),
});
export type ContextReceipt = z.infer<typeof contextReceiptSchema>;

// These names are fixed plugin capabilities, never user input or a path.
export const contextToolSchema = z.enum(["knowledge_search", "knowledge_read", "knowledge_outline", "knowledge_history", "knowledge_impact", "history_search", "history_browse", "history_load", "history_read", "attached_history_search", "attached_history_load", "attached_history_read", "workspace_history_chats", "workspace_history_search", "workspace_history_load", "workspace_history_read", "attachment_updates"]);
export type ContextTool = z.infer<typeof contextToolSchema>;
export const contextEventSchema = contextReceiptSchema.extend({
  id: z.number().int(), at: z.string(),
  tool: contextToolSchema.optional(),
  outcome: z.enum(["ok", "empty", "error"]),
  durationMs: z.number().min(0).nullable(),
  repeated: z.boolean(),
});
export type ContextEvent = z.infer<typeof contextEventSchema>;
export const contextActivitySchema = z.object({
  revision: z.number().int(), recording: z.boolean(), startedAt: z.string().nullable(),
  expiresAfterMinutes: z.literal(30), evicted: z.number().int(),
  window: z.literal("retained"), events: z.array(contextEventSchema).max(200),
});
export type ContextActivitySnapshot = z.infer<typeof contextActivitySchema>;
export const contextActivityRpc = defineRpc({ name: "context.activity", input: z.object({ repoKey: z.string().optional() }), output: contextActivitySchema });
export const contextRecordingRpc = defineRpc({ name: "context.recording", input: z.object({ action: z.enum(["start", "stop", "clear"]) }), output: contextActivitySchema });

export const contextModeSchema = z.enum(["overview", "selected", "full"]);
export type ContextMode = z.infer<typeof contextModeSchema>;
export const prepareContextRpc = defineRpc({
  name: "knowledge.prepare-context",
  input: z.object({ repoKey: z.string().min(1), mode: contextModeSchema, ids: z.array(z.string().min(1).max(600)).max(20).default([]) }),
  output: z.object({ text: z.string(), receipt: contextReceiptSchema, omissions: z.array(z.string()).max(20) }),
});

export const taskRelationsRpc = defineRpc({
  name: "knowledge.task-relations", input: z.object({ repoKey: z.string().min(1), id: z.string().min(1) }),
  output: z.object({ parent: z.object({ id: z.string(), title: z.string() }).nullable(), children: z.array(z.object({ id: z.string().nullable(), title: z.string(), status: z.enum(["running", "completed", "failed", "canceled"]), native: z.boolean() })).max(100), truncated: z.boolean() }),
});
