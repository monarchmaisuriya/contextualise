import { dirname, resolve, sep } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addLinkRpc,
  addTagRpc,
  describeAgentRpc,
  fetchItemRpc,
  fetchRouteRpc,
  refreshNoteRpc,
  removeNoteRpc,
  listTagsRpc,
  parseItemRef,
  pinAgentRpc,
  previewTagRpc,
  removeLinkRpc,
  removeTagRpc,
  searchAgentsRpc,
  searchTagsRpc,
  searchTerminalsRpc,
  snapshotSettings,
  tagKey,
  type SnapshotSettings,
  type TagSummary,
} from "../shared/contracts";
import { AutoRefresh } from "./auto-refresh";
import { contributeKnowledge } from "./knowledge/plugin";
import { Fetcher } from "./fetches";
import { configuredServers } from "./provider-config";
import type { PaseoApi } from "./paseo-types";
import { AgentReadings, Memo, searchAgents, searchTags, searchTerminals, tagAttachment } from "./sources";
import { TagStore } from "./tag-store";
import { describeAgent, type Directory, mergePins, mergeTags, readDirectory } from "./tags";

const READINGS_CACHE_MS = 30_000;
// Long enough to cover one burst of keystrokes in the picker, short enough that a new agent or
// label shows up almost at once.
const DIRECTORY_CACHE_MS = 5_000;

export function contributeTags(server: PluginServerContext, resolveRoot: () => Promise<string>) {
  const store = new TagStore(resolveRoot);
  const settings = server.registerSettings(snapshotSettings);
  const readings = new Memo(READINGS_CACHE_MS);
  const agentReadings = new AgentReadings();
  const directories = new Memo(DIRECTORY_CACHE_MS);
  let serverId: Promise<string> | null = null;
  const fetcher = new Fetcher({ store, resolveRoot, settings: () => currentSettings(), configuredServers: () => configuredServers() });
  const autoRefresh = new AutoRefresh((paseo) => fetcher.refreshStale(paseo));
  const followSetting = (state: Awaited<ReturnType<typeof settings.read>>) => autoRefresh.apply(state.status === "ready" && state.values.autoRefreshItems);
  void settings
    .read()
    .then(followSetting)
    .catch((error: unknown) => console.error(`[contextualise] could not read settings for automatic refresh: ${String(error)}`));
  const stopFollowingSetting = settings.subscribe(followSetting);
  void store
    .failInterruptedFetches()
    .then((count) => count > 0 && console.log(`[contextualise] marked ${count} interrupted fetch(es) as failed`))
    .catch((error: unknown) => console.error(`[contextualise] could not check for interrupted fetches: ${String(error)}`));

  async function currentSettings(): Promise<SnapshotSettings> {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Contextualise settings are invalid (${state.error}). Fix them in Settings > Contextualise.`);
    return state.values;
  }

  // Every list and search reads the directory, so this is where the timer gets its Paseo handle.
  const directory = (paseo: PaseoApi): Promise<Directory> => {
    autoRefresh.use(paseo);
    return directories.get("directory", () => readDirectory(paseo));
  };

  async function listTags(paseo: PaseoApi): Promise<TagSummary[]> {
    const [stored, current] = await Promise.all([store.read(), directory(paseo)]);
    return mergeTags(stored, current);
  }

  server.handle(addTagRpc, async ({ tags, agentId, workspaceId }) => ({ results: await store.add(tags, { agentId, workspaceId }) }));
  server.handle(removeTagRpc, async ({ tags, agentId }) => ({ results: await store.remove(tags, agentId) }));

  server.handle(fetchItemRpc, ({ tag, ref, provider, notifyAgentId }, { paseo }) => fetcher.start(paseo, tag, parseItemRef(ref), provider, notifyAgentId));
  server.handle(fetchRouteRpc, async ({ ref, provider }) => {
    const item = parseItemRef(ref);
    const route = await fetcher.route(item, provider);
    return { vendor: item.vendor, provider: route.provider, server: route.server };
  });
  server.handle(refreshNoteRpc, ({ tag, noteId }, { paseo }) => fetcher.refresh(paseo, tag, noteId));
  server.handle(removeNoteRpc, ({ tag, noteId }) => store.removeNote(tag, noteId));

  // Fetch workers may use only the named read tools of the vendor they fetch; everything else they
  // ask for is denied. Every decision is logged, so the plugin log shows what each worker touched. Requests from any other agent are left alone.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    const decision = await fetcher.decide(agent.id, agent.cwd, request);
    if (!decision) return;
    console.log(`[contextualise] ${decision === "allow" ? "allowed" : "denied"} fetch worker ${agent.id} the tool ${request.name}`);
    const response = decision === "allow" ? { behavior: "allow" as const } : { behavior: "deny" as const, message: "Contextualise fetch workers may only use the read tools of the item's own connector." };
    await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response });
  });

  server.handle(addLinkRpc, ({ tag, url, title }) => store.addLink(tag, { url, title }));
  server.handle(removeLinkRpc, ({ tag, url }) => store.removeLink(tag, url));
  server.handle(listTagsRpc, async (_input, { paseo }) => {
    const [tags, pins, current] = await Promise.all([listTags(paseo), store.pinnedAgents(), directory(paseo)]);
    return { tags, pinnedAgents: mergePins(pins, current) };
  });
  server.handle(describeAgentRpc, async ({ agentId }, { paseo }) => describeAgent(await directory(paseo), agentId));
  server.handle(pinAgentRpc, ({ agentId, pinned }) => store.pinAgent(agentId, pinned));

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
    const pinned = new Set((await store.pinnedAgents()).map((pin) => pin.agentId));
    // Both plugins' background agents run under the Paseo home's plugin-data folder.
    const pluginData = dirname(await resolveRoot());
    const isBackground = (agent: { cwd?: string }) => Boolean(agent.cwd) && (resolve(agent.cwd as string) === pluginData || resolve(agent.cwd as string).startsWith(`${pluginData}${sep}`));
    return { items: await searchAgents(paseo, await directory(paseo), query, options, { readings: agentReadings, pinned, serverId: await serverId, generatedTitles: await knowledge.generatedTitles(), isBackground }) };
  });

  server.handle(searchTerminalsRpc, async ({ query }, { paseo }) => {
    const options = await currentSettings();
    return { items: await searchTerminals(paseo, readings, await directory(paseo), query, options) };
  });

  const knowledge = contributeKnowledge(server, { resolveRoot, settings: currentSettings });

  return async () => {
    autoRefresh.stop();
    void stopFollowingSetting();
    readings.clear();
    agentReadings.clear();
    directories.clear();
    await knowledge.stop();
  };
}
