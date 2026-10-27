import { defineAttachmentSource, defineRpc, defineSettings, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

export const TAG_NAME_MAX_CHARS = 80;

// The same rule Paseo applies to workspace label names, so `/tag Auth Rewrite` and a workspace
// label "auth rewrite" are one tag. Mirrors normalizeWorkspaceLabelName and workspaceLabelKey in
// @getpaseo/protocol/workspace-labels; plugins may not import that package at runtime.
export function normalizeTagName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

// Rejects what cannot be a tag instead of storing it; the caller shows the message.
export function parseTagName(raw: string): string {
  const name = normalizeTagName(raw);
  if (name === "") throw new Error("A tag needs a name, for example: /tag auth-rewrite");
  if (name.length > TAG_NAME_MAX_CHARS) throw new Error(`Expected a tag name of at most ${TAG_NAME_MAX_CHARS} characters, got ${name.length}`);
  return name;
}

const tagNameInput = z.string().transform((value, ctx) => {
  try {
    return parseTagName(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});

export const addTagRpc = defineRpc({
  name: "tags.add",
  input: z.object({ tag: tagNameInput, agentId: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.object({ tag: z.string(), added: z.boolean() }),
});

export const removeTagRpc = defineRpc({
  name: "tags.remove",
  input: z.object({ tag: tagNameInput, agentId: z.string().min(1) }),
  output: z.object({ tag: z.string(), removed: z.boolean() }),
});

export const agentMemberSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  taggedAt: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  // "missing": the daemon no longer knows the agent. It stays in the tag until M removes it.
  state: z.enum(["active", "archived", "missing"]),
});
export type AgentMember = z.infer<typeof agentMemberSchema>;

export const workspaceMemberSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  projectName: z.string(),
  directory: z.string(),
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const tagSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  // False when no workspace carries a label of this name, for example after the label was renamed.
  hasWorkspaceLabel: z.boolean(),
  workspaces: z.array(workspaceMemberSchema),
  agents: z.array(agentMemberSchema),
});
export type TagSummary = z.infer<typeof tagSummarySchema>;

export const listTagsRpc = defineRpc({
  name: "tags.list",
  input: z.object({}),
  output: z.object({ tags: z.array(tagSummarySchema) }),
});

export const searchTagsRpc = defineRpc({
  name: "tags.search",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const tagAttachmentSource = defineAttachmentSource({
  id: "tag",
  title: "Tag",
  icon: "Tags",
  pickerTitle: "Attach a tag",
  searchPlaceholder: "Search tags",
  search: searchTagsRpc,
});

export const SNAPSHOT_MAX_CHARS_DEFAULT = 40_000;
export const TURNS_PER_AGENT_DEFAULT = 6;

// 0 means "use the default", never "unlimited"; anything else outside the range is invalid, and
// Paseo reports invalid stored settings instead of replacing them.
function boundedCount(min: number, max: number, fallback: number) {
  return z.preprocess((value) => (value === 0 ? undefined : value), z.number().int().min(min).max(max).default(fallback));
}

export const snapshotSettingsSchema = z.object({
  snapshotMaxChars: boundedCount(1_000, 200_000, SNAPSHOT_MAX_CHARS_DEFAULT),
  turnsPerAgent: boundedCount(1, 50, TURNS_PER_AGENT_DEFAULT),
});
export type SnapshotSettings = z.infer<typeof snapshotSettingsSchema>;

export const snapshotSettings = defineSettings({
  id: "snapshot",
  scope: "host",
  version: 1,
  schema: snapshotSettingsSchema,
});
