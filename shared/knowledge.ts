import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

// Project knowledge: what a repository already says (docs, conventions, ADRs, code symbols) and the
// tasks agents finished in it. Learned facts (decisions made while working, pitfalls, preferences)
// belong to Memorise; nothing here stores or serves them.
export const KNOWLEDGE_KINDS = ["architecture", "convention", "adr", "doc", "code", "task"] as const;
export const knowledgeKindSchema = z.enum(KNOWLEDGE_KINDS);
export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>;

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  architecture: "Architecture",
  convention: "Conventions",
  adr: "Decisions (ADRs)",
  doc: "Docs",
  code: "Code",
  task: "Tasks",
};

export const relatedMemorySchema = z.object({ id: z.string(), subject: z.string() });
export type RelatedMemory = z.infer<typeof relatedMemorySchema>;

export const searchHitSchema = z.object({
  id: z.string(),
  kind: knowledgeKindSchema,
  path: z.string(),
  line: z.number().int(),
  title: z.string(),
  snippet: z.string(),
  // The source changed since this entry was written (a task's files, or an ADR marked superseded).
  needsCheck: z.boolean(),
  relatedMemories: z.array(relatedMemorySchema),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const knowledgeEntrySchema = searchHitSchema.omit({ snippet: true }).extend({ body: z.string() });
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

export const taskSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  provider: z.string(),
  title: z.string(),
  request: z.string(),
  outcome: z.enum(["completed", "failed", "canceled"]),
  files: z.array(z.string()),
  commands: z.array(z.object({ command: z.string(), exitCode: z.number().nullable() })),
  startedAt: z.string(),
  endedAt: z.string(),
  needsCheck: z.boolean(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const MEMORISE_STATES = ["available", "disabled", "needs-update", "not-installed"] as const;
export const memoriseStateSchema = z.enum(MEMORISE_STATES);
export type MemoriseState = z.infer<typeof memoriseStateSchema>;

export const projectSchema = z.object({
  repoKey: z.string(),
  name: z.string(),
  top: z.string(),
  counts: z.record(knowledgeKindSchema, z.number().int()),
  indexedAt: z.string().nullable(),
  indexing: z.boolean(),
  problem: z.string().nullable(),
});
export type Project = z.infer<typeof projectSchema>;

const projectInput = z.object({ repoKey: z.string().min(1) });

export const listProjectsRpc = defineRpc({
  name: "knowledge.projects",
  input: z.object({}),
  output: z.object({ projects: z.array(projectSchema), memorise: memoriseStateSchema }),
});

export const searchKnowledgeRpc = defineRpc({
  name: "knowledge.search",
  input: projectInput.extend({ query: z.string().trim().max(200), kinds: z.array(knowledgeKindSchema).default([]), limit: z.number().int().min(1).max(50).default(20) }),
  output: z.object({ hits: z.array(searchHitSchema) }),
});

export const readKnowledgeRpc = defineRpc({
  name: "knowledge.read",
  input: projectInput.extend({ id: z.string().min(1) }),
  output: knowledgeEntrySchema,
});

export const listTasksRpc = defineRpc({
  name: "knowledge.tasks",
  input: projectInput.extend({ limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({ tasks: z.array(taskSummarySchema) }),
});

export const reindexRpc = defineRpc({
  name: "knowledge.reindex",
  input: projectInput,
  output: z.object({ started: z.boolean() }),
});

export const memoriseStatusRpc = defineRpc({
  name: "knowledge.memorise-status",
  input: z.object({}),
  output: z.object({ state: memoriseStateSchema }),
});

// Attach > Project knowledge: one entry from any indexed project, sent in full with the prompt.
export const searchKnowledgeAttachmentsRpc = defineRpc({ name: "knowledge.attach-search", input: z.object({ query: z.string() }), output: PluginAttachmentSearchPayloadSchema });

export const knowledgeAttachmentSource = defineAttachmentSource({
  id: "knowledge",
  title: "Project knowledge",
  icon: "BookOpen",
  pickerTitle: "Attach project knowledge",
  searchPlaceholder: "Search docs, ADRs, code, and past tasks",
  search: searchKnowledgeAttachmentsRpc,
});
