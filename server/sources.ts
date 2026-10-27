import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { timeAgo } from "../shared/time";
import { shortenLink } from "../shared/links";
import { tokenEstimate } from "../shared/tokens";
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

// Agent titles are often the first prompt, with Markdown and links in it; the picker shows one
// plain line.
export function cleanTitle(title: string, shortenLinks: boolean): string {
  const plain = title
    .replace(/^\s*#+\s*/, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return shortenLinks ? plain.replace(/https?:\/\/\S+/gi, shortenLink) : plain;
}

// The text before a picker row's title: nothing, or the provider or source word. Paseo draws
// plugin picker rows from text only (no icon), so these are the only choices.
export function rowPrefix(kind: "agent" | "tag" | "terminal", provider: string | undefined, style: SnapshotSettings["pickerPrefix"]): string {
  if (style === "none") return "";
  if (kind !== "agent") return kind === "tag" ? "Tag" : "Terminal";
  const name = (provider ?? "").split("/")[0];
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Agent";
}

// A subtitle from its parts, with the attachment's estimated size at the end when the setting is on.
function subtitle(parts: ReadonlyArray<string | null | false | undefined>, text: string, options: SnapshotSettings): string {
  return [...parts, options.showTokenEstimates ? tokenEstimate(text.length) : null].filter(Boolean).join(" · ");
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
  const text = renderSnapshot(tag, readings, options.snapshotMaxChars);
  return {
    id: tag.key,
    identifier: rowPrefix("tag", undefined, options.pickerPrefix),
    title: tag.name,
    subtitle: subtitle([describeMembers(tag, readings.filter(isUnreadable).length)], text, options),
    url: DOCS_URL,
    text,
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
  // A plain-folder workspace has its project's name; "checkout-web / checkout-web" says nothing more.
  return new Map(directory.workspaces.map((workspace) => [workspace.id, workspace.name === workspace.projectDisplayName ? workspace.name : `${workspace.projectDisplayName} / ${workspace.name}`]));
}

function asMember(agent: DirectoryAgent, workspaceName: string | null): AgentMember {
  return {
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? "",
    taggedAt: "",
    title: agent.title,
    provider: agent.provider,
    workspaceName,
    state: agent.archivedAt ? "archived" : "active",
  };
}

// Any agent on this host, matched on title, provider, workspace, and folder. Pinned agents first
// (kept even when archived agents are hidden), then most recently active, archived ones last.
export async function searchAgents(paseo: PaseoApi, memo: Memo, directory: Directory, pinned: ReadonlySet<string>, serverId: string | null, query: string, options: SnapshotSettings): Promise<PluginAttachmentItem[]> {
  const names = workspaceNames(directory);
  const found = directory.agents
    .filter((agent) => options.includeArchivedAgents || !agent.archivedAt || pinned.has(agent.id))
    .filter((agent) => matches([agent.title, agent.provider, names.get(agent.workspaceId ?? ""), agent.cwd, agent.id].join(" "), query))
    .sort(
      (a, b) =>
        Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
        Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
        (options.agentSort === "title" ? cleanTitle(a.title ?? a.id, false).localeCompare(cleanTitle(b.title ?? b.id, false)) : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    )
    .slice(0, options.resultsPerSearch);
  return Promise.all(
    found.map(async (agent) => {
      const workspaceName = names.get(agent.workspaceId ?? "") ?? null;
      const member = asMember(agent, workspaceName);
      const reading = await memo.get(`agent:${agent.id}:${options.turnsPerAgent}`, () => readAgent(paseo, agent.id, options.turnsPerAgent));
      const state = isUnreadable(reading) ? "unreadable" : agent.archivedAt ? "archived" : agent.status === "running" ? "running" : null;
      const active = agent.updatedAt ? timeAgo(agent.updatedAt) : "";
      const text = renderConversation(member, workspaceName, reading, options.snapshotMaxChars);
      return {
        id: agent.id,
        // Paseo labels a row "<identifier> <title>" and the attached pill "<source> <identifier>".
        identifier: rowPrefix("agent", agent.provider, options.pickerPrefix),
        title: cleanTitle(agent.title ?? "", options.shortenLinks) || agent.id,
        subtitle: subtitle(
          [
            pinned.has(agent.id) && "pinned",
            options.agentShowWorkspace ? (workspaceName ?? "no workspace") : null,
            options.agentShowStatus || state === "unreadable" ? state : null,
            options.agentShowActivity && active ? active : null,
          ],
          text,
          options,
        ),
        url: serverId ? agentLink(serverId, agent.id) : DOCS_URL,
        text,
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
      const text = renderTerminal(terminal, workspaceName, capture.lines, capture.totalLines, options.snapshotMaxChars);
      return {
        id: terminal.id,
        identifier: rowPrefix("terminal", undefined, options.pickerPrefix),
        title: terminal.name,
        subtitle: subtitle([workspaceName, `${capture.totalLines} lines`], text, options),
        url: DOCS_URL,
        text,
        resourceType: "terminal",
      };
    }),
  );
}
