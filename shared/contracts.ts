import { defineAttachmentSource, defineRpc, defineSettings, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { z } from "zod";

export const TAG_NAME_MAX_CHARS = 80;
export const TAGS_PER_COMMAND = 10;
export const LINK_URL_MAX_CHARS = 2_000;
export const LINK_TITLE_MAX_CHARS = 200;
export const NOTE_MAX_CHARS = 8_000;
export const MAX_CUSTOM_ROUTES = 20;
// Where a tag or terminal attachment's pill leads when clicked: the section that explains it.
export const DOCS_URL = "https://github.com/monarchmaisuriya/contextualise#readme";

// The same rule Paseo applies to workspace label names, so a tag "Auth Rewrite" and a workspace
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
  if (name === "") throw new Error("A tag needs a name, for example: auth-rewrite");
  if (name.length > TAG_NAME_MAX_CHARS) throw new Error(`Expected a tag name of at most ${TAG_NAME_MAX_CHARS} characters, got ${name.length}`);
  return name;
}

// "auth, billing" means both tags. Duplicates by key collapse to the first spelling.
export function parseTagNames(raw: string): string[] {
  const names = new Map<string, string>();
  for (const part of raw.split(",")) if (part.trim() !== "") names.set(tagKey(part), names.get(tagKey(part)) ?? parseTagName(part));
  if (names.size === 0) throw new Error("A tag needs a name, for example: auth-rewrite (several: auth, billing)");
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

// Items a worker agent can fetch through the connectors Claude agents already have.
export const VENDORS = ["jira", "sentry", "slack", "notion"] as const;
export type Vendor = (typeof VENDORS)[number];
export const VENDOR_LABELS: Record<Vendor, string> = { jira: "Jira", sentry: "Sentry", slack: "Slack", notion: "Notion" };
export interface ItemRef {
  vendor: Vendor;
  ref: string;
}

// Agents that can fetch. OpenCode is not one: in its default mode it ran shell commands without
// asking (checked live), so it cannot be kept read-only.
export const FETCH_PROVIDERS = ["claude", "codex"] as const;
export type FetchProvider = (typeof FETCH_PROVIDERS)[number];
export const FETCH_PROVIDER_LABELS: Record<FetchProvider, string> = { claude: "Claude", codex: "Codex" };
export const FETCH_PREFERENCES = ["auto", "claude", "codex"] as const;
export type FetchPreference = (typeof FETCH_PREFERENCES)[number];

// Where a worker reads a vendor from: which agent, which of its MCP servers, and the only tools it
// may use there. Tool and server names are plain identifiers; anything else is refused.
const mcpName = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/, "Expected a server or tool name made of letters, digits, _, ., or -");
export const routeSchema = z.object({
  vendor: z.enum(VENDORS),
  provider: z.enum(FETCH_PROVIDERS),
  server: mcpName,
  tools: z.array(mcpName).min(1).max(30),
});
export type Route = z.infer<typeof routeSchema>;

const ITEM_REF_FORMS = "a Jira key like PROJ-123, or a Jira, Sentry, Slack, or Notion link (or prefix it: jira:, sentry:, slack:, notion:)";

function hostOf(text: string): string | null {
  return /^https:\/\/([^/?#:\s]+)/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

// Which vendor an item reference belongs to, from its shape. An explicit "vendor:" prefix wins.
export function parseItemRef(raw: string): ItemRef {
  const text = raw.trim();
  if (text === "") throw new Error(`An item needs a reference: ${ITEM_REF_FORMS}`);
  if (text.length > LINK_URL_MAX_CHARS) throw new Error(`Expected a reference of at most ${LINK_URL_MAX_CHARS} characters, got ${text.length}`);
  const prefixed = /^(jira|sentry|slack|notion):\s*(\S.*)$/i.exec(text);
  if (prefixed) return { vendor: prefixed[1].toLowerCase() as Vendor, ref: prefixed[2].trim() };
  if (/^[A-Z][A-Z0-9_]+-\d+$/.test(text)) return { vendor: "jira", ref: text };
  const host = hostOf(text);
  if (host) {
    if (host.endsWith(".atlassian.net")) return { vendor: "jira", ref: text };
    if (host === "sentry.io" || host.endsWith(".sentry.io")) return { vendor: "sentry", ref: text };
    if (host.endsWith(".slack.com")) return { vendor: "slack", ref: text };
    if (host === "notion.so" || host === "www.notion.so" || host.endsWith(".notion.site")) return { vendor: "notion", ref: text };
  }
  throw new Error(`Expected ${ITEM_REF_FORMS}; got "${text.slice(0, 80)}"`);
}

// "/tag-fetch PROJ-123 auth rewrite": the reference first, since it has no spaces, then the tag.
export function parseFetchCommand(args: string): { ref: string; tag: string } {
  const [first = "", ...rest] = args.trim().split(/\s+/);
  parseItemRef(first);
  return { ref: first, tag: parseTagName(rest.join(" ")) };
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

export const fetchItemRpc = defineRpc({
  name: "tags.fetch",
  // Checked here but kept as text: Paseo validates inputs on both sides, so an input schema must
  // accept its own output. The handler reads the vendor from it with parseItemRef.
  input: z.object({ tag: tagNameInput, ref: parsed((value) => (parseItemRef(value), value.trim())), provider: z.enum(FETCH_PREFERENCES).optional(), notifyAgentId: z.string().min(1).optional() }),
  output: z.object({ tag: z.string(), name: z.string(), noteId: z.string(), changed: z.boolean(), provider: z.enum(FETCH_PROVIDERS), server: z.string() }),
});

// Which agent and connector a fetch would use, before starting it.
export const fetchRouteRpc = defineRpc({
  name: "tags.fetch.route",
  input: z.object({ ref: parsed((value) => (parseItemRef(value), value.trim())), provider: z.enum(FETCH_PREFERENCES).optional() }),
  output: z.object({ vendor: z.enum(VENDORS), provider: z.enum(FETCH_PROVIDERS), server: z.string() }),
});

export const refreshNoteRpc = defineRpc({
  name: "tags.fetch.refresh",
  input: z.object({ tag: tagNameInput, noteId: z.string().min(1) }),
  output: z.object({ tag: z.string(), name: z.string(), noteId: z.string(), changed: z.boolean() }),
});

export const removeNoteRpc = defineRpc({
  name: "tags.fetch.remove",
  input: z.object({ tag: tagNameInput, noteId: z.string().min(1) }),
  output: tagOutcomeSchema,
});

export const agentMemberSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  taggedAt: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  // Named by the server: plugin screens cannot read Paseo's workspace state themselves.
  workspaceName: z.string().nullable(),
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

// An item a worker agent fetched (or is fetching) into a tag. The text is a stored copy; Refresh
// fetches it again.
export const noteMemberSchema = z.object({
  id: z.string(),
  vendor: z.enum(VENDORS),
  ref: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  status: z.enum(["fetching", "ready", "failed"]),
  text: z.string(),
  error: z.string().nullable(),
  addedAt: z.string(),
  fetchedAt: z.string().nullable(),
  // The agent that fetched it; null for items fetched before 0.7.0 (always Claude then).
  provider: z.enum(FETCH_PROVIDERS).nullable().default(null),
  // The agent whose /tag-fetch or pill popover started it; its timeline gets the result row.
  notifyAgentId: z.string().nullable().default(null),
});
export type NoteMember = z.infer<typeof noteMemberSchema>;

export const tagSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  // False when no workspace carries a label of this name, for example after the label was renamed.
  hasWorkspaceLabel: z.boolean(),
  workspaces: z.array(workspaceMemberSchema),
  agents: z.array(agentMemberSchema),
  links: z.array(linkMemberSchema),
  notes: z.array(noteMemberSchema),
});
export type TagSummary = z.infer<typeof tagSummarySchema>;

// An agent M pinned so it comes first in Attach > Agent conversation.
export const pinnedAgentSchema = z.object({
  agentId: z.string(),
  pinnedAt: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  state: z.enum(["active", "archived", "missing"]),
});
export type PinnedAgent = z.infer<typeof pinnedAgentSchema>;

export const listTagsRpc = defineRpc({
  name: "tags.list",
  input: z.object({}),
  output: z.object({ tags: z.array(tagSummarySchema), pinnedAgents: z.array(pinnedAgentSchema) }),
});

// One agent's title and workspace, for the Tags pill and the Tags screen opened for that agent.
export const agentInfoSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  state: z.enum(["active", "archived", "missing"]),
});
export type AgentInfo = z.infer<typeof agentInfoSchema>;

export const describeAgentRpc = defineRpc({ name: "agents.describe", input: z.object({ agentId: z.string().min(1) }), output: agentInfoSchema });

export const pinAgentRpc = defineRpc({
  name: "agents.pin",
  input: z.object({ agentId: z.string().min(1), pinned: z.boolean() }),
  output: z.object({ pinned: z.boolean(), changed: z.boolean() }),
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

// Confirmation rows that v0.2.1 added to agent timelines after /tag and /untag. Nothing adds them
// any more; the renderer stays so rows already in timelines still display.
export const RECEIPT_KIND = "receipt";

// The row a finished fetch adds to the agent that asked for it; one per fetched item (row id
// "fetch-<noteId>"), replaced when the item is fetched again.
export const FETCH_RESULT_KIND = "fetch-result";
export const fetchResultSchema = z.object({
  tag: z.string(),
  noteId: z.string(),
  vendor: z.enum(VENDORS),
  ref: z.string(),
  title: z.string(),
  status: z.enum(["ready", "failed"]),
  error: z.string().nullable(),
  chars: z.number().int().min(0),
});
export type FetchResult = z.infer<typeof fetchResultSchema>;
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
  // Attachments
  snapshotMaxChars: boundedCount(1_000, 200_000, SNAPSHOT_MAX_CHARS_DEFAULT),
  turnsPerAgent: boundedCount(1, 50, TURNS_PER_AGENT_DEFAULT),
  terminalLines: boundedCount(10, 5_000, TERMINAL_LINES_DEFAULT),
  // How many tags, agents, or terminals one search returns; the picker scrolls through them, and
  // each agent result reads that agent's recent turns.
  resultsPerSearch: boundedCount(5, 50, 20),
  // Pickers. A row reads "<prefix> <title>": nothing (rows start with the title) or the provider or
  // source word. Paseo draws plugin picker rows as text only, so there is no icon option.
  pickerPrefix: z.enum(["none", "word"]).default("none"),
  shortenLinks: z.boolean().default(true),
  agentShowWorkspace: z.boolean().default(true),
  agentShowStatus: z.boolean().default(true),
  agentShowActivity: z.boolean().default(true),
  includeArchivedAgents: z.boolean().default(true),
  agentSort: z.enum(["recent", "title"]).default("recent"),
  showTokenEstimates: z.boolean().default(true),
  includeWorkspaces: z.boolean().default(true),
  includeLinks: z.boolean().default(true),
  includeItems: z.boolean().default(true),
  includeAgents: z.boolean().default(true),
  // Tags pill
  showPill: z.boolean().default(true),
  pillLabel: z.enum(["names", "count"]).default("names"),
  pillNameMaxChars: boundedCount(10, 60, 24),
  // Fetching
  fetchProvider: z.enum(FETCH_PREFERENCES).default("auto"),
  // Empty means the provider's own default model.
  claudeFetchModel: z.string().trim().max(100).default("claude-sonnet-5-5"),
  codexFetchModel: z.string().trim().max(100).default(""),
  // Advanced
  fetchTimeoutSeconds: boundedCount(30, 900, 180),
  notifyFetchResults: z.boolean().default(true),
  // Off means no refresh timer runs. On: ready items older than the hours are fetched again.
  autoRefreshItems: z.boolean().default(false),
  autoRefreshHours: boundedCount(1, 168, 24),
  maxConcurrentFetches: boundedCount(1, 5, 2),
  noteMaxChars: boundedCount(1_000, 20_000, NOTE_MAX_CHARS),
  // 0 is meaningful here (no comments), so it is not a "0 means default" count.
  commentsPerItem: z.number().int().min(0).max(50).default(10),
  extraInstructions: z.string().max(1_000).default(""),
  customRoutes: z.array(routeSchema).max(MAX_CUSTOM_ROUTES).default([]),
});
export type SnapshotSettings = z.infer<typeof snapshotSettingsSchema>;

export const snapshotSettings = defineSettings({
  id: "snapshot",
  scope: "host",
  version: 1,
  schema: snapshotSettingsSchema,
});
