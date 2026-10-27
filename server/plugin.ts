import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addLinkRpc,
  addTagRpc,
  listTagsRpc,
  previewTagRpc,
  RECEIPT_KIND,
  RECEIPT_ROW_ID,
  removeLinkRpc,
  removeTagRpc,
  searchAgentsRpc,
  searchTagsRpc,
  searchTerminalsRpc,
  snapshotSettings,
  tagKey,
  type Receipt,
  type SnapshotSettings,
  type TagSummary,
} from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import { Memo, searchAgents, searchTags, searchTerminals, tagAttachment } from "./sources";
import { TagStore, type Outcome } from "./tag-store";
import { type Directory, mergeTags, readDirectory } from "./tags";

const READINGS_CACHE_MS = 30_000;
// Long enough to cover one burst of keystrokes in the picker, short enough that a new agent or
// label shows up almost at once.
const DIRECTORY_CACHE_MS = 5_000;

export function contributeTags(server: PluginServerContext, resolveRoot: () => Promise<string>) {
  const store = new TagStore(resolveRoot);
  const settings = server.registerSettings(snapshotSettings);
  const readings = new Memo(READINGS_CACHE_MS);
  const directories = new Memo(DIRECTORY_CACHE_MS);
  let serverId: Promise<string> | null = null;

  async function currentSettings(): Promise<SnapshotSettings> {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Contextualise settings are invalid (${state.error}). Fix them in Settings > Contextualise.`);
    return state.values;
  }

  const directory = (paseo: PaseoApi): Promise<Directory> => directories.get("directory", () => readDirectory(paseo));

  async function listTags(paseo: PaseoApi): Promise<TagSummary[]> {
    const [stored, current] = await Promise.all([store.read(), directory(paseo)]);
    return mergeTags(stored, current);
  }

  // Replaces this agent's one confirmation row, so /tag and /untag answer in place without piling up.
  async function confirm(paseo: PaseoApi, agentId: string, action: Receipt["action"], outcomes: Outcome[]): Promise<void> {
    const tags = new Map((await listTags(paseo)).map((tag) => [tag.key, tag]));
    const data: Receipt = {
      action,
      entries: outcomes.map((outcome) => {
        const tag = tags.get(outcome.tag);
        return { name: tag?.name ?? outcome.name, changed: outcome.changed, agents: tag?.agents.length ?? 0, workspaces: tag?.workspaces.length ?? 0, links: tag?.links.length ?? 0 };
      }),
    };
    try {
      const timeline = paseo.agents.ref(agentId).timeline;
      // The daemon appends only to an agent it has loaded; after a restart, an agent nobody has
      // opened yet is "unknown" until its timeline is read once.
      await timeline.refetch({ direction: "tail", limit: 1, projection: "projected" });
      await timeline.append({ type: "plugin", id: RECEIPT_ROW_ID, kind: RECEIPT_KIND, version: 1, data });
    } catch (error) {
      throw new Error(`Saved, but the confirmation row could not be added: ${String((error as Error).message ?? error)}`);
    }
  }

  server.handle(addTagRpc, async ({ tags, agentId, workspaceId }, { paseo }) => {
    const results = await store.add(tags, { agentId, workspaceId });
    await confirm(paseo, agentId, "tag", results);
    return { results };
  });

  server.handle(removeTagRpc, async ({ tags, agentId }, { paseo }) => {
    const results = await store.remove(tags, agentId);
    await confirm(paseo, agentId, "untag", results);
    return { results };
  });

  server.handle(addLinkRpc, ({ tag, url, title }) => store.addLink(tag, { url, title }));
  server.handle(removeLinkRpc, ({ tag, url }) => store.removeLink(tag, url));
  server.handle(listTagsRpc, async (_input, { paseo }) => ({ tags: await listTags(paseo) }));

  server.handle(previewTagRpc, async ({ tag }, { paseo }) => {
    const options = await currentSettings();
    const found = (await listTags(paseo)).find((summary) => summary.key === tagKey(tag));
    if (!found) throw new Error(`No tag named "${tag}"`);
    const item = await tagAttachment(paseo, readings, found, options);
    return { subtitle: item.subtitle ?? "", text: item.text };
  });

  server.handle(searchTagsRpc, async ({ query }, { paseo }) => {
    const options = await currentSettings();
    return { items: await searchTags(paseo, readings, await listTags(paseo), query, options) };
  });

  server.handle(searchAgentsRpc, async ({ query }, { paseo }) => {
    const options = await currentSettings();
    serverId ??= paseo.hosts.list().then((hosts) => hosts.self.serverId);
    return { items: await searchAgents(paseo, readings, await directory(paseo), await serverId, query, options) };
  });

  server.handle(searchTerminalsRpc, async ({ query }, { paseo }) => {
    const options = await currentSettings();
    return { items: await searchTerminals(paseo, readings, await directory(paseo), query, options) };
  });

  return () => {
    readings.clear();
    directories.clear();
  };
}
