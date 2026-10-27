import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { timeAgo } from "../shared/time";
import { DOCS_URL, type AgentMember, type SnapshotSettings, type TagSummary } from "../shared/contracts";
import type { AgentTimelineItem, PaseoApi } from "./paseo-types";
import { describeMembers, isUnreadable, lastTurns, matchTags, renderConversation, renderSnapshot, renderTerminal, type AgentReading } from "./snapshot";
import type { Directory, DirectoryAgent } from "./tags";

const TIMELINE_PAGE = 200;
const MAX_TIMELINE_PAGES = 5;

// Results by key for `ttlMs`. The picker searches on every keystroke, so repeated reads of the same
// conversation or terminal within that window are served from here.
export class Memo {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly ttlMs: number) {}

  get<T>(key: string, build: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [old, entry] of this.entries) if (now - entry.at >= this.ttlMs) this.entries.delete(old);
    const hit = this.entries.get(key);
    if (hit) return hit.value as Promise<T>;
    const value = build();
    this.entries.set(key, { at: now, value });
    // A failed build is not remembered, so the next keystroke tries again.
    value.catch(() => this.entries.delete(key));
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

// Reads backwards from the end until it has one more user message than it needs (so it knows
// earlier turns exist), the start of the timeline, or the page cap. A failed read becomes an
// UnreadableAgent with the reason, so one broken agent cannot fail a whole tag or search.
export async function readAgent(paseo: PaseoApi, agentId: string, turnsPerAgent: number): Promise<AgentReading> {
  try {
    const timeline = paseo.agents.ref(agentId).timeline;
    const items: AgentTimelineItem[] = [];
    let page = await timeline.refetch({ direction: "tail", limit: TIMELINE_PAGE, projection: "projected" });
    for (let pages = 1; ; pages += 1) {
      if (page.error) throw new Error(page.error);
      items.unshift(...page.entries.map((entry) => entry.item));
      const userMessages = items.filter((item) => item.type === "user_message").length;
      if (!page.hasOlder || !page.startCursor || userMessages > turnsPerAgent || pages >= MAX_TIMELINE_PAGES) break;
      page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: TIMELINE_PAGE, projection: "projected" });
    }
    return { agentId, ...lastTurns(items, turnsPerAgent), olderUnread: page.hasOlder };
  } catch (error) {
    console.error(`[contextualise] could not read agent ${agentId}: ${String((error as Error).message ?? error)}`);
    return { agentId, error: String((error as Error).message ?? error) };
  }
}

// Agent titles are often the first prompt, with Markdown in it; the picker shows one plain line.
export function cleanTitle(title: string): string {
  return title
    .replace(/^\s*#+\s*/, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// "claude" -> "Claude", "codex" -> "Codex"; a provider id with a model ("claude/opus") keeps only the provider.
function providerLabel(provider: string): string {
  const name = provider.split("/")[0] || "agent";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Paseo's own agent link: clicking the attachment opens that agent.
export function agentLink(serverId: string, agentId: string): string {
  return `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

// The parts of a tag the settings include. Applied before anything is read or rendered, so the
// subtitle and the text describe exactly what is sent, and excluded agents are not read at all.
export function includedParts(tag: TagSummary, options: SnapshotSettings): TagSummary {
  return {
    ...tag,
    workspaces: options.includeWorkspaces ? tag.workspaces : [],
    links: options.includeLinks ? tag.links : [],
    notes: options.includeItems ? tag.notes : [],
    agents: options.includeAgents ? tag.agents : [],
  };
}

export async function tagAttachment(paseo: PaseoApi, memo: Memo, fullTag: TagSummary, options: SnapshotSettings): Promise<PluginAttachmentItem> {
  const tag = includedParts(fullTag, options);
  const readable = tag.agents.filter((agent) => agent.state !== "missing");
  const readings = await Promise.all(readable.map((agent) => memo.get(`agent:${agent.agentId}:${options.turnsPerAgent}`, () => readAgent(paseo, agent.agentId, options.turnsPerAgent))));
  return {
    id: tag.key,
    identifier: "Tag",
    title: tag.name,
    subtitle: describeMembers(tag, readings.filter(isUnreadable).length),
    url: DOCS_URL,
    text: renderSnapshot(tag, readings, options.snapshotMaxChars),
    resourceType: "tag",
  };
}

export async function searchTags(paseo: PaseoApi, memo: Memo, tags: readonly TagSummary[], query: string, options: SnapshotSettings): Promise<PluginAttachmentItem[]> {
  return Promise.all(matchTags(tags, query, options.resultsPerSearch).map((tag) => tagAttachment(paseo, memo, tag, options)));
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// Every word must appear somewhere in the haystack; an empty query matches everything.
function matches(haystack: string, query: string): boolean {
  const text = haystack.toLowerCase();
  return words(query).every((word) => text.includes(word));
}

function workspaceNames(directory: Directory): Map<string, string> {
  return new Map(directory.workspaces.map((workspace) => [workspace.id, `${workspace.projectDisplayName} / ${workspace.name}`]));
}

function asMember(agent: DirectoryAgent): AgentMember {
  return {
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? "",
    taggedAt: "",
    title: agent.title,
    provider: agent.provider,
    state: agent.archivedAt ? "archived" : "active",
  };
}

// Any agent on this host, matched on title, provider, workspace, and folder; most recently active
// first, archived ones after the rest.
export async function searchAgents(paseo: PaseoApi, memo: Memo, directory: Directory, serverId: string | null, query: string, options: SnapshotSettings): Promise<PluginAttachmentItem[]> {
  const names = workspaceNames(directory);
  const found = directory.agents
    .filter((agent) => matches([agent.title, agent.provider, names.get(agent.workspaceId ?? ""), agent.cwd, agent.id].join(" "), query))
    .sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, options.resultsPerSearch);
  return Promise.all(
    found.map(async (agent) => {
      const member = asMember(agent);
      const workspaceName = names.get(agent.workspaceId ?? "") ?? null;
      const reading = await memo.get(`agent:${agent.id}:${options.turnsPerAgent}`, () => readAgent(paseo, agent.id, options.turnsPerAgent));
      const state = isUnreadable(reading) ? "unreadable" : agent.archivedAt ? "archived" : agent.status === "running" ? "running" : null;
      const active = agent.updatedAt ? timeAgo(agent.updatedAt) : "";
      return {
        id: agent.id,
        // Paseo labels a row "<identifier> <title>" and the attached pill "<source> <identifier>";
        // the provider makes both informative instead of repeating "Agent".
        identifier: providerLabel(agent.provider),
        title: cleanTitle(agent.title ?? "") || agent.id,
        subtitle: [workspaceName ?? "no workspace", state, active ? `active ${active}` : null].filter(Boolean).join(" · "),
        url: serverId ? agentLink(serverId, agent.id) : DOCS_URL,
        text: renderConversation(member, workspaceName, reading, options.snapshotMaxChars),
        resourceType: "agent",
      };
    }),
  );
}

// Any terminal on this host, matched on name, workspace, and folder.
export async function searchTerminals(paseo: PaseoApi, memo: Memo, directory: Directory, query: string, options: SnapshotSettings): Promise<PluginAttachmentItem[]> {
  const names = workspaceNames(directory);
  const { entries } = await paseo.terminals.list();
  const found = entries.filter((terminal) => matches([terminal.name, names.get(terminal.workspaceId), terminal.cwd].join(" "), query)).slice(0, options.resultsPerSearch);
  return Promise.all(
    found.map(async (terminal) => {
      const workspaceName = names.get(terminal.workspaceId) ?? null;
      const capture = await memo.get(`terminal:${terminal.id}:${options.terminalLines}`, () => paseo.terminals.ref(terminal.id).capture({ start: -options.terminalLines, stripAnsi: true }));
      return {
        id: terminal.id,
        identifier: "Terminal",
        title: terminal.name,
        subtitle: [workspaceName, `${capture.totalLines} lines`].filter(Boolean).join(" · "),
        url: DOCS_URL,
        text: renderTerminal(terminal, workspaceName, capture.lines, capture.totalLines, options.snapshotMaxChars),
        resourceType: "terminal",
      };
    }),
  );
}
