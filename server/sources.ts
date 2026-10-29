import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { timeAgo } from "../shared/time";
import { tokenEstimate } from "../shared/tokens";
import { DOCS_URL, type AgentMember, type SnapshotSettings, type TagSummary } from "../shared/contracts";
import type { AgentTimelineItem, PaseoApi } from "./paseo-types";
import { describeMembers, isUnreadable, lastTurns, matchTags, renderConversation, renderSnapshot, renderTerminal, type AgentReading } from "./snapshot";
import { agentTitle, capTitle, cleanTitle, gitParts, workspaceLabel, workspaceSearchText } from "./rows";
import type { Directory, DirectoryAgent, DirectoryWorkspace } from "./tags";

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
    title: capTitle(tag.name, options.pickerTitleMaxChars),
    subtitle: subtitle([describeMembers(tag, readings.filter(isUnreadable).length)], text, options),
    url: DOCS_URL,
    text,
    resourceType: "tag",
  };
}

export async function searchTags(paseo: PaseoApi, memo: Memo, tags: readonly TagSummary[], query: string, options: SnapshotSettings): Promise<PluginAttachmentItem[]> {
  return Promise.all(matchTags(tags, query).map((tag) => tagAttachment(paseo, memo, tag, options)));
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// Every word must appear somewhere in the haystack; an empty query matches everything.
function matches(haystack: string, query: string): boolean {
  const text = haystack.toLowerCase();
  return words(query).every((word) => text.includes(word));
}

function workspacesById(directory: Directory): Map<string, DirectoryWorkspace> {
  return new Map(directory.workspaces.map((workspace) => [workspace.id, workspace]));
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

// Conversations already read, kept until the agent changes: an agent's turns can only change when
// its last update does, so the key holds both. Opening the picker then reads only agents that changed
// since last time, which is what lets it list every conversation instead of the newest 20.
export class AgentReadings {
  private readonly entries = new Map<string, Promise<AgentReading>>();

  constructor(private readonly maxEntries = 2_000) {}

  read(paseo: PaseoApi, agent: Pick<DirectoryAgent, "id" | "updatedAt">, turns: number): Promise<AgentReading> {
    const key = `${agent.id}:${agent.updatedAt ?? ""}:${turns}`;
    let reading = this.entries.get(key);
    if (!reading) {
      reading = readAgent(paseo, agent.id, turns);
      this.entries.set(key, reading);
      // An unreadable agent is tried again next time instead of being remembered.
      void reading.then((result) => isUnreadable(result) && this.entries.delete(key));
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    }
    return reading;
  }

  clear(): void {
    this.entries.clear();
  }
}

const PARALLEL_READS = 6;

// Like Promise.all over `items`, with at most `limit` calls running at once, results in order.
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface AgentSearchContext {
  readings: AgentReadings;
  pinned: ReadonlySet<string>;
  serverId: string | null;
  // Titles written for past sessions (project knowledge), used where Paseo has none.
  generatedTitles?: ReadonlyMap<string, string>;
  // Background agents (plugins' workers) are never offered.
  isBackground?: (agent: DirectoryAgent) => boolean;
}

// Every agent on this host that matches the search words: title, provider, workspace, branch, and
// folder. Pinned agents first (shown even when archived ones are hidden), then most recently active,
// archived ones last. No row limit: Paseo's picker scrolls.
export async function searchAgents(paseo: PaseoApi, directory: Directory, query: string, options: SnapshotSettings, context: AgentSearchContext): Promise<PluginAttachmentItem[]> {
  const { pinned, serverId } = context;
  const generatedTitles = context.generatedTitles ?? new Map<string, string>();
  const workspaces = workspacesById(directory);
  const sharing = new Map<string, number>();
  for (const agent of directory.agents) if (agent.workspaceId) sharing.set(agent.workspaceId, (sharing.get(agent.workspaceId) ?? 0) + 1);
  const found = directory.agents
    .filter((agent) => !agent.internal && !context.isBackground?.(agent))
    .filter((agent) => options.includeArchivedAgents || !agent.archivedAt || pinned.has(agent.id))
    .filter((agent) => matches([agent.title, generatedTitles.get(agent.id), agent.provider, workspaceSearchText(workspaces.get(agent.workspaceId ?? "")), agent.cwd, agent.id].join(" "), query))
    .sort(
      (a, b) =>
        Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
        Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
        (options.agentSort === "title" ? cleanTitle(a.title ?? a.id, false).localeCompare(cleanTitle(b.title ?? b.id, false)) : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    );
  return mapLimited(found, PARALLEL_READS, async (agent) => {
      const workspace = workspaces.get(agent.workspaceId ?? "");
      const workspaceName = workspace ? workspaceLabel(workspace) : null;
      const member = asMember(agent, workspaceName);
      const reading = await context.readings.read(paseo, agent, options.turnsPerAgent);
      const state = isUnreadable(reading) ? "unreadable" : agent.archivedAt ? "archived" : agent.status === "running" ? "running" : null;
      const active = agent.updatedAt ? timeAgo(agent.updatedAt) : "";
      const text = renderConversation(member, workspaceName, reading, options.snapshotMaxChars);
      const { title, includesWorkspace } = agentTitle(agent, workspace, sharing.get(agent.workspaceId ?? "") ?? 1, { maxChars: options.pickerTitleMaxChars, shortenLinks: options.shortenLinks, generated: generatedTitles.get(agent.id) });
      return {
        id: agent.id,
        // Paseo labels a row "<identifier> <title>" and the attached pill "<source> <identifier>".
        identifier: rowPrefix("agent", agent.provider, options.pickerPrefix),
        title,
        // Paseo cuts the muted text where the popup ends, so it leads with what tells rows apart.
        subtitle: subtitle(
          [
            pinned.has(agent.id) && "pinned",
            options.agentShowActivity && active ? active : null,
            ...(options.agentShowGit ? gitParts(workspace) : []),
            options.agentShowWorkspace && !includesWorkspace ? (workspaceName ?? "no workspace") : null,
            options.agentShowStatus || state === "unreadable" ? state : null,
          ],
          text,
          options,
        ),
        url: serverId ? agentLink(serverId, agent.id) : DOCS_URL,
        text,
        resourceType: "agent",
      };
    });
}

// Any terminal on this host, matched on name, workspace, and folder.
export async function searchTerminals(paseo: PaseoApi, memo: Memo, directory: Directory, query: string, options: SnapshotSettings): Promise<PluginAttachmentItem[]> {
  const workspaces = workspacesById(directory);
  const { entries } = await paseo.terminals.list();
  const found = entries.filter((terminal) => matches([terminal.name, workspaceSearchText(workspaces.get(terminal.workspaceId)), terminal.cwd].join(" "), query));
  return Promise.all(
    found.map(async (terminal) => {
      const workspace = workspaces.get(terminal.workspaceId);
      const workspaceName = workspace ? workspaceLabel(workspace) : null;
      const capture = await memo.get(`terminal:${terminal.id}:${options.terminalLines}`, () => paseo.terminals.ref(terminal.id).capture({ start: -options.terminalLines, stripAnsi: true }));
      const text = renderTerminal(terminal, workspaceName, capture.lines, capture.totalLines, options.snapshotMaxChars);
      return {
        id: terminal.id,
        identifier: rowPrefix("terminal", undefined, options.pickerPrefix),
        title: capTitle(terminal.name, options.pickerTitleMaxChars),
        subtitle: subtitle([workspaceName, workspace?.gitRuntime?.currentBranch, `${capture.totalLines} lines`], text, options),
        url: DOCS_URL,
        text,
        resourceType: "terminal",
      };
    }),
  );
}
