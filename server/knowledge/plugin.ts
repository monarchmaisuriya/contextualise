import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { type SnapshotSettings, splitGlobs } from "../../shared/contracts";
import { browseKnowledgeRpc, generateKnowledgeRpc, KIND_LABELS, type SearchHit, listProjectsRpc, listTasksRpc, memoriseStatusRpc, pinEntryRpc, readKnowledgeRpc, reindexRpc, searchKnowledgeAttachmentsRpc, searchKnowledgeRpc, setProjectEnabledRpc } from "../../shared/knowledge";
import type { PaseoApi } from "../paseo-types";
import { capTitle } from "../rows";
import { loadTokenSecret, TokenAuthority } from "./auth";
import { KnowledgeBase } from "./base";
import { currentBlobs } from "./indexer";
import { type ProjectRoot, projectRoot } from "./git";
import { KNOWLEDGE_SERVER, KnowledgeMcp, knowledgeServerEntry } from "./mcp";
import { Generator } from "./generate";
import { MemoriseLink, memorySuggestions } from "./memorise";
import { ProjectPrefsStore } from "./prefs";
import { buildSection, unavailableSection, withoutSection, withSection } from "./section";
import { KnowledgeService } from "./service";
import { SymbolReader } from "./symbols";
import { buildTask, type TimelineEntry } from "./task-log";
import { runWorker } from "../workers";

const PLUGIN_ID = "contextualise";
// Paseo fails agent creation when a hook takes 30 s; indexing past this continues in the background.
const HOOK_WAIT_MS = 2_000;
const TIMELINE_PAGE = 200;
const MAX_TIMELINE_PAGES = 10;
const DOCS_URL = "https://github.com/monarchmaisuriya/contextualise#project-knowledge";
const ATTACH_RESULTS = 20;
const OVERVIEW_TASKS = 10;

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
export interface KnowledgeContribution {
  stop: () => Promise<void>;
  // Generated session titles by agent id, for picker rows of agents Paseo has no title for.
  generatedTitles: () => Promise<ReadonlyMap<string, string>>;
}

const TITLES_CACHE_MS = 30_000;

export function contributeKnowledge(server: PluginServerContext, deps: KnowledgeDeps): KnowledgeContribution {
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
    indexOptions: async () => {
      const values = await deps.settings();
      return {
        codeSymbols: values.knowledgeCodeSymbols,
        classify: { exclude: splitGlobs(values.knowledgeExcludeGlobs), extraDocs: splitGlobs(values.knowledgeExtraDocGlobs), languages: new Set(values.knowledgeLanguages) },
        maxFileBytes: values.knowledgeMaxFileKb * 1024,
        maxDocuments: values.knowledgeMaxDocs,
      };
    },
    onChanges: async (repo, store, changes) => {
      const values = await deps.settings();
      if (!values.knowledgeEnabled || !values.memoriseSuggestions || !(await memoriseAvailable())) return;
      const sent = await link.send(repo.key, memorySuggestions(changes, await link.memories(repo.key), (name) => store.hasSymbol(name)));
      if (sent > 0) console.log(`[contextualise] suggested ${sent} memory change(s) to Memorise for ${repo.key}`);
    },
  });
  const prefs = new ProjectPrefsStore(async () => join(await deps.resolveRoot(), "knowledge"));
  const generator = new Generator({ base, prefs, root: deps.resolveRoot, settings: deps.settings, runWorker, readTimeline });
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

  // Paseo projects outside git are project roots: agents in their subfolders share the project, as in
  // Memorise. Recorded once per plugin start for existing workspaces, then for each new one.
  let rootsKnown: Promise<void> | null = null;
  const markRoots = (paseo: PaseoApi) => {
    rootsKnown ??= (async () => {
      for (let cursor: string | undefined; ; ) {
        const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const workspace of page.entries) await base.markRoot(workspace.projectRootPath).catch(() => undefined);
        if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
        cursor = page.pageInfo.nextCursor;
      }
    })().catch((error: unknown) => {
      rootsKnown = null;
      console.error(`[contextualise] could not record project roots: ${String(error)}`);
    });
    return rootsKnown;
  };
  server.on("workspace.created", async ({ workspace }, { paseo }) => {
    remember(paseo);
    await base.markRoot(workspace.cwd).catch((error: unknown) => console.error(`[contextualise] could not record ${workspace.cwd} as a project root: ${String(error)}`));
  });

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
      await markRoots(paseo);
      const repo = await base.repoFor(config.cwd);
      if (!repo) return { ...request, config: stripped };
      const projectPrefs = await prefs.get(repo.key);
      if (!projectPrefs.enabled) return { ...request, config: stripped };
      const { tokens, port, problem } = await runtime;
      if (problem) return { ...request, config: { ...stripped, systemPrompt: withSection(stripped.systemPrompt, unavailableSection(problem)) } };
      const updating = (await base.refresh(repo, HOOK_WAIT_MS)) === "updating";
      const section = buildSection({
        repoKey: repo.key,
        store: await base.open(repo),
        maxLines: values.knowledgeMapLines,
        memoriseAvailable: await memoriseAvailable(),
        updating,
        parts: values.knowledgeMapParts,
        recentTasks: values.knowledgeRecentTasks,
        pins: projectPrefs.pins,
      });
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
    if (!isKnowledge || !(await deps.settings()).knowledgeAutoApproveTools) return;
    await remember(paseo).agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });

  // Each finished turn updates the agent's task entry, from its timeline alone.
  server.on("agent.turn_ended", async ({ agent, outcome }, { paseo }) => {
    remember(paseo);
    try {
      if (!(await deps.settings()).knowledgeEnabled) return;
      const repo = await base.repoFor(agent.cwd);
      if (!repo || !(await prefs.get(repo.key)).enabled) return;
      const task = buildTask({ agent, outcome: outcome.kind, entries: await readTimeline(paseo, agent.id), top: repo.top, now: new Date().toISOString() });
      if (!task) return;
      const blobs = await currentBlobs(repo);
      const previous = (await base.open(repo)).task(task.id);
      // A turn adds to the session; its generated title and summary stay until they are regenerated.
      await base.recordTask(repo, { ...previous, ...task, citations: task.files.map((path) => ({ path, blob: blobs.get(path) ?? "missing" })) });
      await generator.schedule(paseo, repo, agent);
    } catch (error) {
      console.error(`[contextualise] could not record the task of agent ${agent.id}: ${String(error)}`);
    }
  });

  const project = async (repoKey: string) => {
    const found = await base.byKey(repoKey);
    if (!found) throw new Error(`No project knowledge for ${repoKey}; open an agent in that repository first`);
    return found.repo;
  };

  server.handle(listProjectsRpc, async (_input, { paseo }) => ({
    projects: await Promise.all((await base.projects()).map(async (project) => ({ ...project, ...(await prefs.get(project.repoKey)), generation: generator.status(project.repoKey) }))),
    memorise: await link.state(remember(paseo)),
  }));
  server.handle(generateKnowledgeRpc, async ({ repoKey, generate }, { paseo }) => {
    generator.run(remember(paseo), await project(repoKey), generate);
    return { started: true };
  });
  server.handle(setProjectEnabledRpc, async ({ repoKey, enabled }) => ({ enabled: (await prefs.setEnabled((await project(repoKey)).key, enabled)).enabled }));
  server.handle(pinEntryRpc, async ({ repoKey, id, pinned }) => ({ pins: (await prefs.setPinned((await project(repoKey)).key, id, pinned)).pins }));
  server.handle(memoriseStatusRpc, async (_input, { paseo }) => ({ state: await link.state(remember(paseo)) }));
  server.handle(searchKnowledgeRpc, async ({ repoKey, query, kinds, limit }, { paseo }) => {
    remember(paseo);
    return { hits: query.trim() ? await service.search(await project(repoKey), query, kinds, limit) : [] };
  });
  server.handle(readKnowledgeRpc, async ({ repoKey, id }, { paseo }) => {
    remember(paseo);
    return service.read(await project(repoKey), id);
  });
  server.handle(listTasksRpc, async ({ repoKey, limit, offset }) => service.tasks(await project(repoKey), limit, offset));
  server.handle(browseKnowledgeRpc, async ({ repoKey, kind, limit, offset }, { paseo }) => {
    remember(paseo);
    return service.browse(await project(repoKey), kind, limit, offset);
  });
  server.handle(reindexRpc, async ({ repoKey }, { paseo }) => {
    remember(paseo);
    const repo = await project(repoKey);
    base.invalidate(repo.key);
    void base.refresh(repo, 0);
    return { started: true };
  });
  // A project's essentials, newest work last: its description, design docs, team rules, decisions,
  // and recent work.
  const overview = async (repo: ProjectRoot): Promise<SearchHit[]> => {
    const parts = await Promise.all([service.browse(repo, "brief", 1, 0), service.browse(repo, "architecture", 10, 0), service.browse(repo, "convention", 10, 0), service.browse(repo, "adr", 20, 0)]);
    const { tasks } = await service.tasks(repo, OVERVIEW_TASKS);
    return [
      ...parts.flatMap((part) => part.hits),
      ...tasks.map((task) => ({ id: task.id, kind: "task" as const, path: task.files[0] ?? "", line: 0, title: task.generatedTitle ?? task.title, snippet: task.summary ?? task.request, needsCheck: task.needsCheck, relatedMemories: [] })),
    ];
  };

  server.handle(searchKnowledgeAttachmentsRpc, async ({ query }, { paseo }) => {
    remember(paseo);
    const { pickerTitleMaxChars } = await deps.settings();
    const items = [];
    for (const found of await base.projects()) {
      const repo = projectRoot(found.repoKey, found.top);
      // With no search words, each project's essentials are offered instead of nothing.
      const hits = query.trim() ? await service.search(repo, query, [], ATTACH_RESULTS) : await overview(repo);
      for (const hit of hits) {
        const entry = await service.read(repo, hit.id);
        items.push({
          id: `${found.repoKey}|${hit.id}`,
          identifier: KIND_LABELS[hit.kind],
          title: capTitle(hit.title, pickerTitleMaxChars),
          // The snippet shows why the row matched, and Paseo's picker filters rows by their own text.
          subtitle: `${found.name} · ${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}${hit.needsCheck ? " · needs check" : ""} · ${hit.snippet.replace(/\s+/g, " ").trim()}`.slice(0, 200),
          url: DOCS_URL,
          text: `Project knowledge from ${found.repoKey} (${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}), quoted from the repository:\n\n${entry.body}`,
          resourceType: "knowledge",
        });
      }
    }
    // Every project's results are kept; Paseo's picker scrolls.
    return { items };
  });

  let titles: { at: number; map: Promise<Map<string, string>> } | null = null;
  const generatedTitles = () => {
    if (!titles || Date.now() - titles.at > TITLES_CACHE_MS) {
      titles = {
        at: Date.now(),
        map: (async () => {
          const map = new Map<string, string>();
          for (const found of await base.projects()) {
            const store = (await base.byKey(found.repoKey))?.store;
            for (const task of store?.tasks(1_000) ?? []) if (task.generatedTitle) map.set(task.agentId, task.generatedTitle);
          }
          return map;
        })(),
      };
    }
    return titles.map;
  };

  return {
    generatedTitles,
    stop: async () => {
      generator.stop();
      base.close();
      const resolved = await runtime.catch(() => null);
      const http = resolved?.http;
      if (!http) return;
      const closed = new Promise<void>((done) => http.close(() => done()));
      http.closeAllConnections();
      await closed;
    },
  };
}
