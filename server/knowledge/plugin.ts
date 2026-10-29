import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { SnapshotSettings } from "../../shared/contracts";
import { KIND_LABELS, listProjectsRpc, listTasksRpc, memoriseStatusRpc, readKnowledgeRpc, reindexRpc, searchKnowledgeAttachmentsRpc, searchKnowledgeRpc } from "../../shared/knowledge";
import type { PaseoApi } from "../paseo-types";
import { loadTokenSecret, TokenAuthority } from "./auth";
import { KnowledgeBase } from "./base";
import { trackedBlobs } from "./indexer";
import { KNOWLEDGE_SERVER, KnowledgeMcp, knowledgeServerEntry } from "./mcp";
import { MemoriseLink, memorySuggestions } from "./memorise";
import { buildSection, unavailableSection, withoutSection, withSection } from "./section";
import { KnowledgeService } from "./service";
import { SymbolReader } from "./symbols";
import { buildTask, type TimelineEntry } from "./task-log";

const PLUGIN_ID = "contextualise";
// Paseo fails agent creation when a hook takes 30 s; indexing past this continues in the background.
const HOOK_WAIT_MS = 2_000;
const TIMELINE_PAGE = 200;
const MAX_TIMELINE_PAGES = 10;
const DOCS_URL = "https://github.com/monarchmaisuriya/contextualise#project-knowledge";
const ATTACH_RESULTS = 20;

interface KnowledgeDeps {
  resolveRoot: () => Promise<string>;
  settings: () => Promise<SnapshotSettings>;
}

// The plugin's install folder, from the daemon config. The server bundle has no file location of its
// own, and this folder holds node_modules/web-tree-sitter and grammars/.
async function ownDirectory(paseo: PaseoApi): Promise<string> {
  const { config } = await paseo.config.get();
  const entries = Object.entries(config.plugins ?? {});
  const byId = entries.find(([id]) => id === PLUGIN_ID)?.[1];
  if (byId && "path" in byId && typeof byId.path === "string") return byId.path;
  for (const [, entry] of entries) {
    if (!("path" in entry) || typeof entry.path !== "string") continue;
    const manifest = await readFile(join(entry.path, "paseo-plugin.json"), "utf8").catch(() => "");
    if (manifest.includes(`"id": "${PLUGIN_ID}"`) || manifest.includes(`"id":"${PLUGIN_ID}"`)) return entry.path;
  }
  throw new Error("Contextualise could not find its own install folder in the daemon config");
}

async function readTimeline(paseo: PaseoApi, agentId: string): Promise<TimelineEntry[]> {
  const timeline = paseo.agents.ref(agentId).timeline;
  const entries: TimelineEntry[] = [];
  let page = await timeline.refetch({ direction: "tail", limit: TIMELINE_PAGE, projection: "projected" });
  for (let pages = 1; ; pages += 1) {
    if (page.error) throw new Error(page.error);
    entries.unshift(...page.entries.map((entry) => ({ item: entry.item, timestamp: entry.timestamp })));
    if (!page.hasOlder || !page.startCursor || pages >= MAX_TIMELINE_PAGES) break;
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: TIMELINE_PAGE, projection: "projected" });
  }
  return entries;
}

// Project knowledge: the index, the agents' read tools and project map, the task log, the screens'
// RPCs, and the link to Memorise. Returns the cleanup.
export function contributeKnowledge(server: PluginServerContext, deps: KnowledgeDeps): () => Promise<void> {
  // The newest Paseo handle from any hook or RPC: background work (symbol loading, Memorise checks
  // after a re-index) runs between calls and needs one.
  let paseoHandle: PaseoApi | null = null;
  const remember = (paseo: PaseoApi) => {
    paseoHandle = paseo;
    return paseo;
  };
  let directory: Promise<string> | null = null;
  const pluginDir = () => {
    if (!paseoHandle) return Promise.reject(new Error("Contextualise has not been called by Paseo yet, so its folder is unknown"));
    directory ??= ownDirectory(paseoHandle).catch((error: unknown) => {
      directory = null;
      throw error;
    });
    return directory;
  };
  const link = new MemoriseLink(async () => {
    const own = await deps.resolveRoot();
    return { own, memorise: join(dirname(own), "memorise") };
  });
  const memoriseAvailable = async () => paseoHandle !== null && (await link.state(paseoHandle)) === "available";

  const base = new KnowledgeBase({
    root: deps.resolveRoot,
    symbols: new SymbolReader(pluginDir),
    codeSymbols: async () => (await deps.settings()).knowledgeCodeSymbols,
    onChanges: async (repo, store, changes) => {
      const values = await deps.settings();
      if (!values.knowledgeEnabled || !values.memoriseSuggestions || !(await memoriseAvailable())) return;
      const sent = await link.send(repo.key, memorySuggestions(changes, await link.memories(repo.key), (name) => store.hasSymbol(name)));
      if (sent > 0) console.log(`[contextualise] suggested ${sent} memory change(s) to Memorise for ${repo.key}`);
    },
  });
  const service = new KnowledgeService(base, async () => ((await memoriseAvailable()) ? (repoKey, path) => link.related(repoKey, path) : null));

  const runtime = (async () => {
    const root = await deps.resolveRoot();
    const tokens = new TokenAuthority(await loadTokenSecret(join(root, "knowledge")));
    const { knowledgePort } = await deps.settings();
    try {
      const http: Server | null = await new KnowledgeMcp(tokens, service).listen(knowledgePort);
      console.log(`[contextualise] knowledge tools on 127.0.0.1:${knowledgePort}`);
      return { tokens, port: knowledgePort, http, problem: null };
    } catch (error) {
      // Agents keep their stored tool address, so the port never moves on its own.
      const problem = `the knowledge tool server could not listen on 127.0.0.1:${knowledgePort} (${String(error)}); change the port in Settings > Contextualise and reload the plugin`;
      console.error(`[contextualise] ${problem}`);
      return { tokens, port: knowledgePort, http: null as Server | null, problem };
    }
  })();
  runtime.catch((error: unknown) => console.error(`[contextualise] knowledge failed to start: ${String(error)}`));

  // Adds the project map and the read tools to every new agent in a git repository. Knowledge enriches
  // an agent; it must never stop one being created, so every failure becomes one line in the section.
  server.before("agent.create", async ({ request }, { paseo }) => {
    remember(paseo);
    const { config } = request;
    const others = Object.fromEntries(Object.entries(config.mcpServers ?? {}).filter(([name]) => name !== KNOWLEDGE_SERVER));
    const stripped = { ...config, systemPrompt: withoutSection(config.systemPrompt), mcpServers: others };
    try {
      const values = await deps.settings();
      if (!values.knowledgeEnabled) return { ...request, config: stripped };
      const repo = await base.repoFor(config.cwd);
      if (!repo) return { ...request, config: stripped };
      const { tokens, port, problem } = await runtime;
      if (problem) return { ...request, config: { ...stripped, systemPrompt: withSection(stripped.systemPrompt, unavailableSection(problem)) } };
      const updating = (await base.refresh(repo, HOOK_WAIT_MS)) === "updating";
      const section = buildSection({ repoKey: repo.key, store: await base.open(repo), maxLines: values.knowledgeMapLines, memoriseAvailable: await memoriseAvailable(), updating });
      return {
        ...request,
        config: {
          ...stripped,
          systemPrompt: section ? withSection(stripped.systemPrompt, section) : stripped.systemPrompt,
          mcpServers: { ...others, ...knowledgeServerEntry(port, tokens.mint({ repoKey: repo.key, top: repo.top })) },
        },
      };
    } catch (error) {
      console.error(`[contextualise] could not prepare project knowledge for an agent in ${config.cwd}: ${String(error)}`);
      return { ...request, config: { ...stripped, systemPrompt: withSection(stripped.systemPrompt, unavailableSection(String(error instanceof Error ? error.message : error))) } };
    }
  });

  // The knowledge tools only read the agent's own repository's index, so their calls are approved.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    const isKnowledge = request.name.startsWith(`mcp__${KNOWLEDGE_SERVER}__`) || (request.name === "CodexMcpElicitation" && request.metadata?.serverName === KNOWLEDGE_SERVER);
    if (!isKnowledge) return;
    await remember(paseo).agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });

  // Each finished turn updates the agent's task entry, from its timeline alone.
  server.on("agent.turn_ended", async ({ agent, outcome }, { paseo }) => {
    remember(paseo);
    try {
      if (!(await deps.settings()).knowledgeEnabled) return;
      const repo = await base.repoFor(agent.cwd);
      if (!repo) return;
      const task = buildTask({ agent, outcome: outcome.kind, entries: await readTimeline(paseo, agent.id), top: repo.top, now: new Date().toISOString() });
      if (!task) return;
      const blobs = await trackedBlobs(repo.top);
      await base.recordTask(repo, { ...task, citations: task.files.map((path) => ({ path, blob: blobs.get(path) ?? "missing" })) });
    } catch (error) {
      console.error(`[contextualise] could not record the task of agent ${agent.id}: ${String(error)}`);
    }
  });

  const project = async (repoKey: string) => {
    const found = await base.byKey(repoKey);
    if (!found) throw new Error(`No project knowledge for ${repoKey}; open an agent in that repository first`);
    return found.repo;
  };

  server.handle(listProjectsRpc, async (_input, { paseo }) => ({ projects: await base.projects(), memorise: await link.state(remember(paseo)) }));
  server.handle(memoriseStatusRpc, async (_input, { paseo }) => ({ state: await link.state(remember(paseo)) }));
  server.handle(searchKnowledgeRpc, async ({ repoKey, query, kinds, limit }, { paseo }) => {
    remember(paseo);
    return { hits: query.trim() ? await service.search(await project(repoKey), query, kinds, limit) : [] };
  });
  server.handle(readKnowledgeRpc, async ({ repoKey, id }, { paseo }) => {
    remember(paseo);
    return service.read(await project(repoKey), id);
  });
  server.handle(listTasksRpc, async ({ repoKey, limit }) => ({ tasks: await service.tasks(await project(repoKey), limit) }));
  server.handle(reindexRpc, async ({ repoKey }, { paseo }) => {
    remember(paseo);
    const repo = await project(repoKey);
    base.invalidate(repo.key);
    void base.refresh(repo, 0);
    return { started: true };
  });
  server.handle(searchKnowledgeAttachmentsRpc, async ({ query }, { paseo }) => {
    remember(paseo);
    if (!query.trim()) return { items: [] };
    const items = [];
    for (const found of await base.projects()) {
      const repo = { key: found.repoKey, top: found.top };
      for (const hit of await service.search(repo, query, [], ATTACH_RESULTS)) {
        const entry = await service.read(repo, hit.id);
        items.push({
          id: `${found.repoKey}|${hit.id}`,
          identifier: KIND_LABELS[hit.kind],
          title: hit.title,
          // The snippet shows why the row matched, and Paseo's picker filters rows by their own text.
          subtitle: `${found.name} · ${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}${hit.needsCheck ? " · needs check" : ""} · ${hit.snippet.replace(/\s+/g, " ").trim()}`.slice(0, 200),
          url: DOCS_URL,
          text: `Project knowledge from ${found.repoKey} (${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}), quoted from the repository:\n\n${entry.body}`,
          resourceType: "knowledge",
        });
      }
    }
    return { items: items.slice(0, ATTACH_RESULTS) };
  });

  return async () => {
    base.close();
    const resolved = await runtime.catch(() => null);
    const http = resolved?.http;
    if (!http) return;
    const closed = new Promise<void>((done) => http.close(() => done()));
    http.closeAllConnections();
    await closed;
  };
}
