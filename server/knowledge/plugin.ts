import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { type SnapshotSettings, splitGlobs } from "../../shared/contracts";
import { areaRpc, browseKnowledgeRpc, describeProjectRpc, explainAreaRpc, fileConnectionsRpc, generateKnowledgeRpc, KIND_LABELS, knowledgeAgentsNowRpc, knowledgeChangesRpc, knowledgeOverviewRpc, knowledgePulseRpc, knowledgeUsageRpc, projectForWorkspaceRpc, listProjectsRpc, listTasksRpc, memoriseStatusRpc, pinEntryRpc, projectFactsRpc, readKnowledgeRpc, reindexRpc, searchKnowledgeAttachmentsRpc, searchKnowledgeRpc, setProjectEnabledRpc } from "../../shared/knowledge";
import type { PaseoApi } from "../paseo-types";
import { capTitle } from "../rows";
import { requestedTool } from "../vendor-fetch";
import { loadTokenSecret, TokenAuthority } from "./auth";
import { KnowledgeBase } from "./base";
import { currentBlobs } from "./indexer";
import { projectRoot } from "./git";
import { KNOWLEDGE_OFF, KNOWLEDGE_SERVER, KNOWLEDGE_TOOLS, KnowledgeMcp, knowledgeServerEntry } from "./mcp";
import { Generator } from "./generate";
import { MemoriseLink, memorySuggestions } from "./memorise";
import { ProjectPrefsStore } from "./prefs";
import { UsageLog } from "./usage";
import { overviewFor, withoutMarkers } from "./overview";
import { projectPack } from "./pack";
import { type LiveAgent, needsYou } from "../agent-state";
import { waitingAgents } from "./pulse";
import { unavailableSection, withoutSection, withSection } from "./section";
import { KnowledgeService } from "./service";
import { SymbolReader } from "./symbols";
import type { KnowledgeStore } from "./store";
import { buildTask, type TimelineEntry } from "./task-log";
import type { z } from "zod";
import { runWorker } from "../workers";

const PLUGIN_ID = "contextualise";
// Paseo fails agent creation when a hook takes 30 s; indexing past this continues in the background.
const HOOK_WAIT_MS = 2_000;
const TIMELINE_PAGE = 200;
const MAX_TIMELINE_PAGES = 10;
const DOCS_URL = "https://github.com/monarchmaisuriya/contextualise#project-knowledge";
const ATTACH_RESULTS = 20;
// How long Attach waits for each project's check for changed files, all projects at once. A git
// repository's check took 16 to 47 ms and a 14,000-file folder's 240 to 460 ms on a real machine.
const ATTACH_WAIT_MS = 300;

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
  const usage = new UsageLog(async () => join(await deps.resolveRoot(), "knowledge"));
  const generator = new Generator({ base, prefs, root: deps.resolveRoot, settings: deps.settings, runWorker, readTimeline });
  const service = new KnowledgeService(base, async () => ((await memoriseAvailable()) ? (repoKey, path) => link.related(repoKey, path) : null));

  // Off means off: nothing is read, indexed, recorded, or offered. Settings that cannot be read count
  // as off.
  const knowledgeOn = async () => {
    try {
      return (await deps.settings()).knowledgeEnabled;
    } catch {
      return false;
    }
  };

  // Every knowledge RPC but the Memorise check (Settings asks it) fails while knowledge is off, so
  // no screen can read or re-index a project then.
  const handleOn = <Input extends z.ZodType, Output extends z.ZodType>(contract: PluginRpcContract<Input, Output>, handler: (input: z.output<Input>, context: PluginHandlerContext) => z.input<Output> | Promise<z.input<Output>>) =>
    server.handle(contract, async (input, context) => {
      if (!(await knowledgeOn())) throw new Error(KNOWLEDGE_OFF);
      return handler(input, context);
    });

  const runtime = (async () => {
    const root = await deps.resolveRoot();
    const tokens = new TokenAuthority(await loadTokenSecret(join(root, "knowledge")));
    const { knowledgePort } = await deps.settings();
    try {
      // It listens while knowledge is off too, answering that it is off: agents keep their stored tool
      // address, and OpenCode will not load an agent whose tool server refuses connections.
      const http: Server | null = await new KnowledgeMcp(tokens, service, usage, knowledgeOn).listen(knowledgePort);
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
    if (!(await knowledgeOn())) {
      // Recorded by the next agent created once knowledge is on again.
      rootsKnown = null;
      return;
    }
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
      const map = await overviewFor({
        repoKey: repo.key,
        settings: values,
        prefs: await prefs.get(repo.key),
        problem: async () => (await runtime).problem,
        open: async () => {
          const updating = (await base.refresh(repo, HOOK_WAIT_MS)) === "updating";
          // Counting is advisory: a failed count is logged and never stops the agent.
          await usage.recordGiven(repo.key).catch((error: unknown) => console.error(`[contextualise] could not count an agent given knowledge in ${repo.key}: ${String(error)}`));
          return { store: await base.open(repo), updating };
        },
        memoriseAvailable,
      });
      if (map.state === "off") return { ...request, config: stripped };
      const section = map.text;
      if (map.state === "unavailable") return { ...request, config: { ...stripped, systemPrompt: section ? withSection(stripped.systemPrompt, section) : stripped.systemPrompt } };
      const { tokens, port } = await runtime;
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

  // The knowledge tools only read the agent's own repository's index, so their calls are approved:
  // each one by its exact server and tool name. Another server whose name starts the same way, or a
  // tool the knowledge server does not offer, is left to the user.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    const asked = requestedTool(request.name === "CodexMcpElicitation" ? "codex" : "claude", request);
    const isKnowledge = typeof asked === "object" && asked !== null && asked.server === KNOWLEDGE_SERVER && (KNOWLEDGE_TOOLS as readonly string[]).includes(asked.tool);
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

  handleOn(listProjectsRpc, async (_input, { paseo }) => ({
    projects: await Promise.all((await base.projects()).map(async (project) => ({ ...project, ...(await prefs.get(project.repoKey)), generation: generator.status(project.repoKey) }))),
    memorise: await link.state(remember(paseo)),
  }));
  handleOn(generateKnowledgeRpc, async ({ repoKey, generate }, { paseo }) => {
    generator.run(remember(paseo), await project(repoKey), generate);
    return { started: true };
  });
  handleOn(setProjectEnabledRpc, async ({ repoKey, enabled }) => ({ enabled: (await prefs.setEnabled((await project(repoKey)).key, enabled)).enabled }));
  handleOn(pinEntryRpc, async ({ repoKey, id, pinned }) => ({ pins: (await prefs.setPinned((await project(repoKey)).key, id, pinned)).pins }));
  server.handle(memoriseStatusRpc, async (_input, { paseo }) => ({ state: await link.state(remember(paseo)) }));
  handleOn(searchKnowledgeRpc, async ({ repoKey, query, kinds, limit }, { paseo }) => {
    remember(paseo);
    return { hits: query.trim() ? await service.search(await project(repoKey), query, kinds, limit) : [] };
  });
  handleOn(readKnowledgeRpc, async ({ repoKey, id }, { paseo }) => {
    remember(paseo);
    return service.read(await project(repoKey), id, { connections: true });
  });
  handleOn(listTasksRpc, async ({ repoKey, limit, offset }) => service.tasks(await project(repoKey), limit, offset));
  handleOn(projectFactsRpc, async ({ repoKey }) => service.facts(await project(repoKey)));
  // Paseo's panel state hooks throw in screens and this plugin shares components between both, so the
  // client sends the workspace id and the folder is looked up here.
  handleOn(projectForWorkspaceRpc, async ({ workspaceId }, { paseo }) => {
    for (let cursor: string | undefined; ; ) {
      const page = await remember(paseo).workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      const found = page.entries.find((entry) => entry.id === workspaceId);
      if (found) return { repoKey: (await base.repoFor(found.workspaceDirectory ?? found.projectRootPath))?.key ?? null };
      if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) throw new Error(`Paseo has no workspace ${workspaceId}`);
      if (page.pageInfo.nextCursor === cursor) throw new Error(`Paseo's workspace list repeated a page while looking for ${workspaceId}`);
      cursor = page.pageInfo.nextCursor;
    }
  });
  handleOn(knowledgeUsageRpc, async ({ repoKey }) => usage.lastDays((await project(repoKey)).key));
  // The live agents working in a project: not archived, not Paseo's own, and in a folder of the
  // project. An agent whose folder cannot be resolved (gone, unreadable, git refusing it) is not
  // counted here and is logged; it cannot fail the answer for every project.
  const liveAgentsIn = async (paseo: PaseoApi, repoKey: string): Promise<LiveAgent[]> => {
    const found: LiveAgent[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, cursor } });
      for (const { agent } of page.entries as { agent: LiveAgent & { cwd?: string; internal?: boolean; archivedAt?: string | null } }[]) {
        if (agent.internal || agent.archivedAt || !agent.cwd) continue;
        const repo = await base.repoFor(agent.cwd).catch((error: unknown) => {
          console.error(`[contextualise] could not tell which project agent ${agent.id} works in: ${String(error)}`);
          return null;
        });
        if (repo?.key === repoKey) found.push(agent);
      }
      if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
      cursor = page.pageInfo.nextCursor;
    }
    return found;
  };
  handleOn(knowledgeAgentsNowRpc, async ({ repoKey }, { paseo }) => {
    remember(paseo);
    const repo = await project(repoKey);
    let agents: LiveAgent[];
    try {
      agents = await liveAgentsIn(paseo, repo.key);
    } catch (error) {
      return { available: false, problem: `Could not read Paseo's agents: ${error instanceof Error ? error.message : String(error)}`, running: 0, needsYou: 0, finished: 0, waiting: [] };
    }
    const reasons = agents.map(needsYou);
    return {
      available: true,
      problem: null,
      running: agents.filter((agent) => agent.status === "running").length,
      needsYou: reasons.filter((reason) => reason === "permission" || reason === "error").length,
      finished: reasons.filter((reason) => reason === "finished").length,
      waiting: waitingAgents(agents),
    };
  });
  handleOn(knowledgePulseRpc, async ({ repoKey, days, utcOffsetMinutes }) => service.pulse(await project(repoKey), days, utcOffsetMinutes));
  handleOn(knowledgeChangesRpc, async ({ repoKey, days, utcOffsetMinutes }) => service.changes(await project(repoKey), days, utcOffsetMinutes));
  handleOn(fileConnectionsRpc, async ({ repoKey, path }) => service.connections(await project(repoKey), path));
  // The same overview as the agent hook's, without its refresh or its count of agents given knowledge.
  handleOn(knowledgeOverviewRpc, async ({ repoKey }, { paseo }) => {
    remember(paseo);
    const repo = await project(repoKey);
    const map = await overviewFor({
      repoKey: repo.key,
      settings: await deps.settings(),
      prefs: await prefs.get(repo.key),
      problem: async () => (await runtime).problem,
      open: async () => ({ store: await base.open(repo), updating: base.isIndexing(repo.key) }),
      memoriseAvailable,
    });
    return { ...map, text: map.text === null ? null : withoutMarkers(map.text) };
  });
  handleOn(describeProjectRpc, async ({ repoKey }, { paseo }) => {
    generator.startDescribe(remember(paseo), await project(repoKey));
    return { started: true };
  });
  handleOn(explainAreaRpc, async ({ repoKey, path }, { paseo }) => {
    const repo = await project(repoKey);
    // Checked here so an unknown area fails the request instead of a background job.
    await service.area(repo, path);
    generator.startExplain(remember(paseo), repo, path);
    return { started: true };
  });
  handleOn(areaRpc, async ({ repoKey, path }) => service.area(await project(repoKey), path));
  handleOn(browseKnowledgeRpc, async ({ repoKey, kind, limit, offset }, { paseo }) => {
    remember(paseo);
    return service.browse(await project(repoKey), kind, limit, offset);
  });
  handleOn(reindexRpc, async ({ repoKey }, { paseo }) => {
    remember(paseo);
    const repo = await project(repoKey);
    base.invalidate(repo.key);
    void base.refresh(repo, 0);
    return { started: true };
  });
  // One whole-project row: the project's own writing in one attachment, built from its index.
  const projectItem = (found: { repoKey: string; name: string; top: string }, store: KnowledgeStore, updating: boolean, pickerTitleMaxChars: number, label: (word: string) => string) => {
    const pack = projectPack(store, found);
    return {
      id: `${found.repoKey}|project`,
      identifier: label("Whole project"),
      title: capTitle(found.name, pickerTitleMaxChars),
      subtitle: `${updating ? "Updating · " : ""}${pack.documents === 0 ? "No design documents, rules, or decisions" : pack.included === pack.documents ? `${pack.documents} document${pack.documents === 1 ? "" : "s"}` : `${pack.included} of ${pack.documents} documents`} · about ${pack.tokens.toLocaleString("en-US")} tokens · ${found.top}`.slice(0, 200),
      url: DOCS_URL,
      text: pack.text,
      resourceType: "knowledge",
    };
  };

  // Every project's check for changed files starts at once, and the picker waits at most ATTACH_WAIT_MS
  // for them: a project still updating after that answers from its index as it is, says so, and
  // carries on in the background. With no words it offers each whole project; with words, the projects
  // whose name has them, then matching entries.
  server.handle(searchKnowledgeAttachmentsRpc, async ({ query }, { paseo }) => {
    remember(paseo);
    if (!(await knowledgeOn())) return { items: [] };
    const { pickerTitleMaxChars, pickerPrefix } = await deps.settings();
    // Rows start with their title unless the "Label before each title" setting asks for a word.
    const label = (word: string) => (pickerPrefix === "none" ? "" : word);
    const words = query.trim().toLowerCase();
    const projects = await Promise.all(
      (await base.projects()).map(async (found) => {
        const repo = projectRoot(found.repoKey, found.top);
        const state = await base.refresh(repo, ATTACH_WAIT_MS).catch(() => "failed" as const);
        return { found, repo, updating: state === "updating" };
      }),
    );
    const wholes = await Promise.all(
      projects.filter(({ found }) => words === "" || found.name.toLowerCase().includes(words)).map(async ({ found, repo, updating }) => projectItem(found, await base.open(repo), updating, pickerTitleMaxChars, label)),
    );
    if (words === "") return { items: wholes };
    const entries = await Promise.all(
      projects.map(async ({ found, repo, updating }) => {
        const hits = await service.search(repo, query, [], ATTACH_RESULTS, [], 0);
        const bodies = await service.bodies(repo, hits.map((hit) => hit.id), 0);
        return hits
          .filter((hit) => bodies.has(hit.id))
          .map((hit) => ({
            id: `${found.repoKey}|${hit.id}`,
            identifier: label(KIND_LABELS[hit.kind]),
            title: capTitle(hit.title, pickerTitleMaxChars),
            // The snippet shows why the row matched, and Paseo's picker filters rows by their own text.
            subtitle: `${found.name} · ${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}${hit.needsCheck ? " · needs check" : ""}${updating ? " · updating" : ""} · ${hit.snippet.replace(/\s+/g, " ").trim()}`.slice(0, 200),
            url: DOCS_URL,
            text: `Project knowledge from ${found.repoKey} (${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}), quoted from the repository:\n\n${bodies.get(hit.id)}`,
            resourceType: "knowledge",
          }));
      }),
    );
    // Every project's results are kept; Paseo's picker scrolls.
    return { items: [...wholes, ...entries.flat()] };
  });

  let titles: { at: number; map: Promise<Map<string, string>> } | null = null;
  const generatedTitles = async (): Promise<ReadonlyMap<string, string>> => {
    if (!(await knowledgeOn())) return new Map();
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
