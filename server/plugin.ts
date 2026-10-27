import type { PluginAttachmentItem } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { addTagRpc, listTagsRpc, removeTagRpc, searchTagsRpc, snapshotSettings, type SnapshotSettings, type TagSummary } from "../shared/contracts";
import type { AgentTimelineItem, PaseoApi } from "./paseo-types";
import { describeMembers, lastTurns, matchTags, renderSnapshot, type AgentTranscript } from "./snapshot";
import { TagStore } from "./tag-store";
import { mergeTags, readDirectory } from "./tags";

const TAGS_PER_SEARCH = 5;
const SNAPSHOT_CACHE_MS = 30_000;
const TIMELINE_PAGE = 200;
const MAX_TIMELINE_PAGES = 5;

// Reads backwards from the end until it has one more user message than it needs (so it knows
// earlier turns exist), the start of the timeline, or the page cap.
async function readTranscript(paseo: PaseoApi, agentId: string, turnsPerAgent: number): Promise<AgentTranscript> {
  const timeline = paseo.agents.ref(agentId).timeline;
  const items: AgentTimelineItem[] = [];
  let page = await timeline.refetch({ direction: "tail", limit: TIMELINE_PAGE, projection: "projected" });
  for (let pages = 1; ; pages += 1) {
    if (page.error) throw new Error(`Contextualise could not read agent ${agentId}: ${page.error}`);
    items.unshift(...page.entries.map((entry) => entry.item));
    const userMessages = items.filter((item) => item.type === "user_message").length;
    if (!page.hasOlder || !page.startCursor || userMessages > turnsPerAgent || pages >= MAX_TIMELINE_PAGES) break;
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: TIMELINE_PAGE, projection: "projected" });
  }
  return { agentId, ...lastTurns(items, turnsPerAgent), olderUnread: page.hasOlder };
}

export function contributeTags(server: PluginServerContext, resolveRoot: () => Promise<string>) {
  const store = new TagStore(resolveRoot);
  const settings = server.registerSettings(snapshotSettings);
  // Built snapshots by tag, members, and settings. Tagging changes members, so it clears the cache.
  const snapshots = new Map<string, { builtAt: number; item: PluginAttachmentItem }>();

  async function currentSettings(): Promise<SnapshotSettings> {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Contextualise settings are invalid (${state.error}). Fix them in Settings > Contextualise.`);
    return state.values;
  }

  async function attachmentFor(paseo: PaseoApi, tag: TagSummary, options: SnapshotSettings): Promise<PluginAttachmentItem> {
    const members = [...tag.workspaces.map((workspace) => workspace.workspaceId), ...tag.agents.map((agent) => `${agent.agentId}:${agent.state}`)];
    const cacheKey = JSON.stringify([tag.key, members, options]);
    const cached = snapshots.get(cacheKey);
    if (cached && Date.now() - cached.builtAt < SNAPSHOT_CACHE_MS) return cached.item;
    const readable = tag.agents.filter((agent) => agent.state !== "missing");
    const transcripts = await Promise.all(readable.map((agent) => readTranscript(paseo, agent.agentId, options.turnsPerAgent)));
    const item: PluginAttachmentItem = {
      id: tag.key,
      identifier: tag.name,
      title: tag.name,
      subtitle: describeMembers(tag),
      url: `paseo://contextualise/tag/${encodeURIComponent(tag.key)}`,
      text: renderSnapshot(tag, transcripts, options.snapshotMaxChars),
      resourceType: "tag",
    };
    snapshots.set(cacheKey, { builtAt: Date.now(), item });
    return item;
  }

  async function listTags(paseo: PaseoApi): Promise<TagSummary[]> {
    const [stored, directory] = await Promise.all([store.read(), readDirectory(paseo)]);
    return mergeTags(stored, directory);
  }

  server.handle(addTagRpc, async ({ tag, agentId, workspaceId }) => {
    const result = await store.add(tag, { agentId, workspaceId });
    snapshots.clear();
    return result;
  });

  server.handle(removeTagRpc, async ({ tag, agentId }) => {
    const result = await store.remove(tag, agentId);
    snapshots.clear();
    return result;
  });

  server.handle(listTagsRpc, async (_input, { paseo }) => ({ tags: await listTags(paseo) }));

  server.handle(searchTagsRpc, async ({ query }, { paseo }) => {
    const options = await currentSettings();
    const now = Date.now();
    for (const [key, entry] of snapshots) if (now - entry.builtAt >= SNAPSHOT_CACHE_MS) snapshots.delete(key);
    const matches = matchTags(await listTags(paseo), query, TAGS_PER_SEARCH);
    return { items: await Promise.all(matches.map((tag) => attachmentFor(paseo, tag, options))) };
  });

  return () => {
    snapshots.clear();
  };
}
