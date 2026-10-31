import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

// Project knowledge: what a repository already says (docs, conventions, ADRs, code symbols) and the
// tasks agents finished in it. Learned facts (decisions made while working, pitfalls, preferences)
// belong to Memorise; nothing here stores or serves them.
export const KNOWLEDGE_KINDS = ["brief", "architecture", "convention", "adr", "doc", "code", "task"] as const;
export const knowledgeKindSchema = z.enum(KNOWLEDGE_KINDS);
export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>;

// The generated project brief is one entry with this id (kind "brief", path "(brief)").
export const BRIEF_ID = "brief:(brief):1";

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  brief: "About the project",
  architecture: "Design",
  convention: "Team rules",
  adr: "Decisions",
  doc: "Documents",
  code: "Code",
  task: "Past work",
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
  // Written by a background agent when generated knowledge is on: a short title and what was done.
  generatedTitle: z.string().optional(),
  summary: z.string().optional(),
  generatedAt: z.string().optional(),
  // How many of the agent's turns the summary covers, so it is not generated again without new turns.
  summarizedTurns: z.number().int().optional(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const MEMORISE_STATES = ["available", "disabled", "needs-update", "not-installed"] as const;
export const memoriseStateSchema = z.enum(MEMORISE_STATES);
export type MemoriseState = z.infer<typeof memoriseStateSchema>;

// A project's structure, computed from its index: areas of code, how they import each other, the
// names other areas use most, and the libraries the code imports.
export const keyNameSchema = z.object({ name: z.string(), kind: z.string(), path: z.string(), line: z.number(), uses: z.number() });
export const areaSchema = z.object({
  // "" for files at the root; "(other)" for small areas listed together, named in `merged`.
  path: z.string(),
  files: z.number(),
  tests: z.number(),
  symbols: z.number(),
  languages: z.record(z.string(), z.number()),
  keyNames: z.array(keyNameSchema),
  // The area's files that other files import most, by number of importing files.
  mainFiles: z.array(z.object({ path: z.string(), usedBy: z.number() })),
  merged: z.array(z.string()),
});
export type Area = z.infer<typeof areaSchema>;
export const areaLinkSchema = z.object({ from: z.string(), to: z.string(), count: z.number() });
export type AreaLink = z.infer<typeof areaLinkSchema>;
export const projectFactsSchema = z.object({
  version: z.number(),
  codeFiles: z.number(),
  testFiles: z.number(),
  languages: z.record(z.string(), z.number()),
  areas: z.array(areaSchema),
  links: z.array(areaLinkSchema),
  libraries: z.array(z.object({ name: z.string(), files: z.number() })),
  fingerprint: z.string(),
});
export type ProjectFacts = z.infer<typeof projectFactsSchema>;
// Files changed most in recent history; `available` is false outside git, and `problem` says why git
// could not be read.
// `area`: the area the file is in, or null for files outside every area (docs/ with no code).
export const busyFileSchema = z.object({ path: z.string(), changes: z.number(), lastAt: z.string(), area: z.string().nullable() });
export type BusyFile = z.infer<typeof busyFileSchema>;
export const busySchema = z.object({ at: z.string(), days: z.number(), available: z.boolean(), problem: z.string().nullable(), files: z.array(busyFileSchema) });
export type Busy = z.infer<typeof busySchema>;

export const projectSchema = z.object({
  repoKey: z.string(),
  name: z.string(),
  top: z.string(),
  counts: z.record(knowledgeKindSchema, z.number().int()),
  indexedAt: z.string().nullable(),
  indexing: z.boolean(),
  problem: z.string().nullable(),
  // A folder outside git, and the user's choices for this project.
  git: z.boolean(),
  enabled: z.boolean(),
  pins: z.array(z.string()),
  // The last "Import past sessions" or "Generate" run since the plugin started.
  generation: z.object({ state: z.enum(["running", "done", "failed"]), message: z.string(), at: z.string() }).nullable(),
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
  input: projectInput.extend({ limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
  output: z.object({ tasks: z.array(taskSummarySchema), total: z.number().int() }),
});

// One kind's entries without a search, a page at a time; the snippet is the start of the entry.
export const browseKnowledgeRpc = defineRpc({
  name: "knowledge.browse",
  input: projectInput.extend({ kind: knowledgeKindSchema.exclude(["task"]), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
  output: z.object({ hits: z.array(searchHitSchema), total: z.number().int() }),
});

export const reindexRpc = defineRpc({
  name: "knowledge.reindex",
  input: projectInput,
  output: z.object({ started: z.boolean() }),
});

export const setProjectEnabledRpc = defineRpc({
  name: "knowledge.project-enabled",
  input: projectInput.extend({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});

export const pinEntryRpc = defineRpc({
  name: "knowledge.pin",
  input: projectInput.extend({ id: z.string().min(1).max(600), pinned: z.boolean() }),
  output: z.object({ pins: z.array(z.string()) }),
});

export const generateKnowledgeRpc = defineRpc({
  name: "knowledge.generate",
  // false: import past sessions only (no model); true: also summaries and a brief when generation is on.
  input: projectInput.extend({ generate: z.boolean() }),
  output: z.object({ started: z.boolean() }),
});

export const memoriseStatusRpc = defineRpc({
  name: "knowledge.memorise-status",
  input: z.object({}),
  output: z.object({ state: memoriseStateSchema }),
});

// The four tools an agent gets for its project's knowledge, by name.
export const KNOWLEDGE_TOOLS = ["knowledge_search", "knowledge_read", "knowledge_outline", "knowledge_history"] as const;
export type KnowledgeTool = (typeof KNOWLEDGE_TOOLS)[number];

// How a project's knowledge tools were used over the last `days` days. `calls` is keyed by tool name.
export const knowledgeUsageSchema = z.object({
  days: z.number().int(),
  agentsGiven: z.number().int().min(0),
  agentsUsed: z.number().int().min(0),
  calls: z.object(Object.fromEntries(KNOWLEDGE_TOOLS.map((tool) => [tool, z.number().int().min(0)])) as Record<KnowledgeTool, z.ZodNumber>),
});
export type KnowledgeUsage = z.infer<typeof knowledgeUsageSchema>;

export const knowledgeUsageRpc = defineRpc({
  name: "knowledge.usage",
  input: z.object({ repoKey: z.string() }),
  output: knowledgeUsageSchema,
});

// The project a workspace's folder belongs to, for its Project knowledge tab, as the server resolves
// it: worktrees and subfolders map to their project. Null when the folder gets no knowledge.
export const projectForWorkspaceRpc = defineRpc({
  name: "knowledge.project-for",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ repoKey: z.string().nullable() }),
});

export const projectFactsRpc = defineRpc({
  name: "knowledge.facts",
  input: z.object({ repoKey: z.string() }),
  // `areaLines`: one written line per area path, when an agent has written them.
  output: z.object({ facts: projectFactsSchema, busy: busySchema, areaLines: z.record(z.string(), z.string()) }),
});

export const areaRpc = defineRpc({
  name: "knowledge.area",
  input: z.object({ repoKey: z.string(), path: z.string() }),
  output: z.object({
    area: areaSchema,
    line: z.string().nullable(),
    // Written on request ("Explain this area"), with when it was written.
    explanation: z.object({ body: z.string(), at: z.string() }).nullable(),
    dependsOn: z.array(areaLinkSchema),
    usedBy: z.array(areaLinkSchema),
    busy: z.array(busyFileSchema),
    documents: z.array(z.object({ id: z.string(), kind: knowledgeKindSchema, path: z.string(), title: z.string() })),
    tasks: z.array(taskSummarySchema),
  }),
});

// Background writing for a project; progress and outcome show as the project's `generation`.
export const describeProjectRpc = defineRpc({ name: "knowledge.describe", input: z.object({ repoKey: z.string() }), output: z.object({ started: z.boolean() }) });
export const explainAreaRpc = defineRpc({ name: "knowledge.explain-area", input: z.object({ repoKey: z.string(), path: z.string() }), output: z.object({ started: z.boolean() }) });

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
