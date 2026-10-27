import { defineAttachmentSource, defineRpc, defineSettings, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

export const TAG_NAME_MAX_CHARS = 80;
export const TAGS_PER_COMMAND = 10;
export const LINK_URL_MAX_CHARS = 2_000;
export const LINK_TITLE_MAX_CHARS = 200;
// Where a tag or terminal attachment's pill leads when clicked: the section that explains it.
export const DOCS_URL = "https://github.com/monarchmaisuriya/contextualise#readme";

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

// "/tag auth, billing" tags with both. Duplicates by key collapse to the first spelling.
export function parseTagNames(raw: string): string[] {
  const names = new Map<string, string>();
  for (const part of raw.split(",")) if (part.trim() !== "") names.set(tagKey(part), names.get(tagKey(part)) ?? parseTagName(part));
  if (names.size === 0) throw new Error("A tag needs a name, for example: /tag auth-rewrite (several: /tag auth, billing)");
  if (names.size > TAGS_PER_COMMAND) throw new Error(`Expected at most ${TAGS_PER_COMMAND} tags at once, got ${names.size}`);
  return [...names.values()];
}

// Only web links: a tag's links are listed in prompts and opened by people, so file:, javascript:
// and similar schemes are refused.
export function parseLinkUrl(raw: string): string {
  const text = raw.trim();
  if (text === "") throw new Error("A link needs a URL, for example: /tag-link https://example.com/spec auth-rewrite");
  if (text.length > LINK_URL_MAX_CHARS) throw new Error(`Expected a URL of at most ${LINK_URL_MAX_CHARS} characters, got ${text.length}`);
  // A pattern, not the URL class: this also runs in the app, where React Native's URL is partial.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && scheme !== "https" && scheme !== "http") throw new Error(`Expected an https:// or http:// link, got ${scheme}:`);
  if (!/^https?:\/\/[^\s/?#]+\.[^\s/?#]+(?::\d+)?(?:[/?#]\S*)?$/i.test(text) && !/^https?:\/\/(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]\S*)?$/i.test(text)) {
    throw new Error(`Expected a web address starting with https:// or http://, got "${text.slice(0, 80)}"`);
  }
  return text;
}

// "/tag-link https://example.com/spec auth rewrite": the URL first, since it has no spaces, then the tag.
export function parseLinkCommand(args: string): { url: string; tag: string } {
  const [first = "", ...rest] = args.trim().split(/\s+/);
  return { url: parseLinkUrl(first), tag: parseTagName(rest.join(" ")) };
}

// Wraps a parser so schema errors carry its message instead of a generic one.
function parsed<T>(parse: (value: string) => T) {
  return z.string().transform((value, ctx) => {
    try {
      return parse(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  });
}

const tagNameInput = parsed(parseTagName);
const linkUrlInput = parsed(parseLinkUrl);

export const tagOutcomeSchema = z.object({ tag: z.string(), name: z.string(), changed: z.boolean() });

export const addTagRpc = defineRpc({
  name: "tags.add",
  input: z.object({ tags: z.array(tagNameInput).min(1).max(TAGS_PER_COMMAND), agentId: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.object({ results: z.array(tagOutcomeSchema) }),
});

export const removeTagRpc = defineRpc({
  name: "tags.remove",
  input: z.object({ tags: z.array(tagNameInput).min(1).max(TAGS_PER_COMMAND), agentId: z.string().min(1) }),
  output: z.object({ results: z.array(tagOutcomeSchema) }),
});

export const addLinkRpc = defineRpc({
  name: "tags.link.add",
  input: z.object({ tag: tagNameInput, url: linkUrlInput, title: z.string().trim().max(LINK_TITLE_MAX_CHARS).optional() }),
  output: tagOutcomeSchema,
});

export const removeLinkRpc = defineRpc({
  name: "tags.link.remove",
  input: z.object({ tag: tagNameInput, url: z.string().min(1) }),
  output: tagOutcomeSchema,
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

export const linkMemberSchema = z.object({ url: z.string(), title: z.string(), taggedAt: z.string() });
export type LinkMember = z.infer<typeof linkMemberSchema>;

export const tagSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  // False when no workspace carries a label of this name, for example after the label was renamed.
  hasWorkspaceLabel: z.boolean(),
  workspaces: z.array(workspaceMemberSchema),
  agents: z.array(agentMemberSchema),
  links: z.array(linkMemberSchema),
});
export type TagSummary = z.infer<typeof tagSummarySchema>;

export const listTagsRpc = defineRpc({
  name: "tags.list",
  input: z.object({}),
  output: z.object({ tags: z.array(tagSummarySchema) }),
});

// Exactly what Attach > Tag would send for this tag, so it can be read before sending.
export const previewTagRpc = defineRpc({
  name: "tags.preview",
  input: z.object({ tag: tagNameInput }),
  output: z.object({ subtitle: z.string(), text: z.string() }),
});

const searchInput = z.object({ query: z.string() });

export const searchTagsRpc = defineRpc({ name: "tags.search", input: searchInput, output: PluginAttachmentSearchPayloadSchema });
export const searchAgentsRpc = defineRpc({ name: "agents.search", input: searchInput, output: PluginAttachmentSearchPayloadSchema });
export const searchTerminalsRpc = defineRpc({ name: "terminals.search", input: searchInput, output: PluginAttachmentSearchPayloadSchema });

export const tagAttachmentSource = defineAttachmentSource({
  id: "tag",
  title: "Tag",
  icon: "Tags",
  pickerTitle: "Attach a tag",
  searchPlaceholder: "Search tags",
  search: searchTagsRpc,
});

export const agentAttachmentSource = defineAttachmentSource({
  id: "agent",
  title: "Agent conversation",
  icon: "MessagesSquare",
  pickerTitle: "Attach another agent's conversation",
  searchPlaceholder: "Search agents by title, provider, or workspace",
  search: searchAgentsRpc,
});

export const terminalAttachmentSource = defineAttachmentSource({
  id: "terminal",
  title: "Terminal output",
  icon: "SquareTerminal",
  pickerTitle: "Attach terminal output",
  searchPlaceholder: "Search terminals by name or workspace",
  search: searchTerminalsRpc,
});

// One confirmation row per agent, replaced on every /tag or /untag in that agent.
export const RECEIPT_KIND = "receipt";
export const RECEIPT_ROW_ID = "contextualise-receipt";
export const receiptSchema = z.object({
  action: z.enum(["tag", "untag"]),
  entries: z.array(z.object({ name: z.string(), changed: z.boolean(), agents: z.number(), workspaces: z.number(), links: z.number() })),
});
export type Receipt = z.infer<typeof receiptSchema>;

export const SNAPSHOT_MAX_CHARS_DEFAULT = 40_000;
export const TURNS_PER_AGENT_DEFAULT = 6;
export const TERMINAL_LINES_DEFAULT = 200;

// 0 means "use the default", never "unlimited"; anything else outside the range is invalid, and
// Paseo reports invalid stored settings instead of replacing them.
function boundedCount(min: number, max: number, fallback: number) {
  return z.preprocess((value) => (value === 0 ? undefined : value), z.number().int().min(min).max(max).default(fallback));
}

export const snapshotSettingsSchema = z.object({
  snapshotMaxChars: boundedCount(1_000, 200_000, SNAPSHOT_MAX_CHARS_DEFAULT),
  turnsPerAgent: boundedCount(1, 50, TURNS_PER_AGENT_DEFAULT),
  terminalLines: boundedCount(10, 5_000, TERMINAL_LINES_DEFAULT),
});
export type SnapshotSettings = z.infer<typeof snapshotSettingsSchema>;

export const snapshotSettings = defineSettings({
  id: "snapshot",
  scope: "host",
  version: 1,
  schema: snapshotSettingsSchema,
});
