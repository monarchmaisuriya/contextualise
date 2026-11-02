import { readFile, realpath } from "node:fs/promises";
import type { Server } from "node:http";
import { basename, dirname, join } from "node:path";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginBeforeRequests, PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { type SnapshotSettings, splitGlobs } from "../../shared/contracts";
import { areaRpc, browseKnowledgeRpc, describeProjectRpc, explainAreaRpc, fileConnectionsRpc, generateKnowledgeRpc, KIND_LABELS, knowledgeAgentsNowRpc, knowledgeChangesRpc, knowledgeOverviewRpc, knowledgePulseRpc, knowledgeUsageRpc, projectForWorkspaceRpc, listProjectsRpc, listTasksRpc, memoriseStatusRpc, pinEntryRpc, projectFactsRpc, readKnowledgeRpc, reindexRpc, searchKnowledgeAttachmentsRpc, searchKnowledgeRpc, setProjectEnabledRpc } from "../../shared/knowledge";
import { addLinkRpc, LINK_WORKSPACE_ENV, newLinkedChatRpc, removeLinkRpc, type WorkspaceLinksPayload, workspaceLinksRpc } from "../../shared/linked-projects";
import type { PaseoApi } from "../paseo-types";
import { readAgent } from "../sources";
import { renderConversation, renderTimelineItems } from "../snapshot";
import { capTitle } from "../rows";
import { requestedTool } from "../vendor-fetch";
import { loadTokenSecret, TokenAuthority } from "./auth";
import { KnowledgeBase } from "./base";
import { currentBlobs } from "./indexer";
import { projectRoot } from "./git";
import { CONVERSATION_TOOL, type ConversationReader, KNOWLEDGE_OFF, KNOWLEDGE_SERVER, KNOWLEDGE_TOOLS, KnowledgeMcp, knowledgeServerEntry } from "./mcp";
import { Generator } from "./generate";
import { MemoriseLink, memorySuggestions } from "./memorise";
import { ProjectPrefsStore } from "./prefs";
import { UsageLog } from "./usage";
import { overviewFor, withoutMarkers } from "./overview";
import { projectPack } from "./pack";
import { type LiveAgent, needsYou } from "../agent-state";
import { waitingAgents } from "./pulse";
import { SECTION_END, SECTION_START, unavailableSection, withoutSection, withSection } from "./section";
import { type LinkedForChat, linkableFolder, linkedProviderOptions, linksSection, WorkspaceLinks } from "./links";
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
  // The line an attached conversation carries so the receiving agent can read all of it with
  // conversation_read; null while knowledge is off or its tool server is down.
  conversationGrant: (agentId: string) => Promise<string | null>;
}

// conversation_read answers a page of this many timeline items at a time.
const CONVERSATION_PAGE = 40;

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
  const links = new WorkspaceLinks(async () => join(await deps.resolveRoot(), "knowledge"));
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

  // Every Paseo workspace, page by page.
  async function* allWorkspaces(paseo: PaseoApi, includeBackground = true) {
    for (let cursor: string | undefined; ; ) {
      // Background workspaces too, by default: one could share a linked workspace's folder.
      const page = await paseo.workspaces.list({ includeBackground, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      yield* page.entries;
      if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) return;
      cursor = page.pageInfo.nextCursor;
    }
  }
  const realFolder = (path: string) => realpath(path).catch(() => path);
  // The Paseo home (plugin data lives at <home>/plugin-data/contextualise): never linkable.
  const paseoHome = async () => dirname(dirname(await deps.resolveRoot()));
  const workspaceFolder = (workspace: { workspaceDirectory?: string | null; projectRootPath: string }) => workspace.workspaceDirectory ?? workspace.projectRootPath;
  // The workspaces whose folder is this folder: one for a worktree workspace, several when local
  // workspaces share a folder.
  const workspacesAt = async (paseo: PaseoApi, folder: string) => {
    const real = await realFolder(folder);
    const found: string[] = [];
    for await (const workspace of allWorkspaces(paseo)) if ((await realFolder(workspaceFolder(workspace))) === real) found.push(workspace.id);
    return found;
  };
  const workspaceById = async (paseo: PaseoApi, workspaceId: string) => {
    for await (const workspace of allWorkspaces(paseo)) if (workspace.id === workspaceId) return workspace;
    throw new Error(`Paseo has no workspace ${workspaceId}`);
  };
  // A linked project's knowledge, while the folder is still linked to the workspace.
  const linkedProject = async (workspaceId: string, repoKey: string) => {
    const found = (await links.list(workspaceId)).find((link) => link.repoKey === repoKey);
    if (!found) return null;
    const repo = await base.repoFor(found.path);
    return repo?.key === repoKey ? repo : null;
  };

  // The workspace a new chat is in and its links. Paseo gives the hook no workspace id, so it is the
  // one Contextualise named when it created the chat, or the only workspace at the chat's folder;
  // when several share the folder, none is chosen. Nothing is looked up while no workspace has links.
  const linkedFor = async (paseo: PaseoApi, request: PluginBeforeRequests["agent.create"]): Promise<{ workspaceId: string | null; chat: Omit<LinkedForChat, "knowledgeTools"> }> => {
    const { provider, cwd } = request.config;
    const chat = { links: [], granted: false, provider, sharedFolder: false, problem: null };
    try {
      const linked = await links.workspaceIds();
      if (linked.length === 0) return { workspaceId: null, chat };
      // The marker is trusted only for a chat whose folder is that workspace's folder.
      const marked = request.env?.[LINK_WORKSPACE_ENV];
      let workspaceId = marked && (await realFolder(workspaceFolder(await workspaceById(paseo, marked)))) === (await realFolder(cwd)) ? marked : null;
      if (!workspaceId) {
        const here = await workspacesAt(paseo, cwd);
        if (here.length > 1) return { workspaceId: null, chat: { ...chat, sharedFolder: here.some((id) => linked.includes(id)) } };
        workspaceId = here[0] ?? null;
      }
      // Each link is checked again as it is used: a folder replaced by a symlink, moved, or deleted
      // since it was linked is left out.
      const home = await paseoHome();
      const found = [];
      for (const link of workspaceId ? await links.list(workspaceId) : []) {
        const still = await linkableFolder(link.path, cwd, [home]).catch(() => null);
        if (still === link.path) found.push(link);
        else console.error(`[contextualise] left linked folder ${link.path} out of a chat in ${cwd}: it moved, is gone, or now points elsewhere`);
      }
      return {
        workspaceId,
        chat: { ...chat, granted: linkedProviderOptions(provider, undefined, []) !== null, links: found.map((link) => ({ path: link.path, name: basename(link.path), repoKey: link.repoKey })) },
      };
    } catch (error) {
      console.error(`[contextualise] could not prepare linked projects for an agent in ${cwd}: ${String(error)}`);
      return { workspaceId: null, chat: { ...chat, problem: error instanceof Error ? error.message : String(error) } };
    }
  };
  // Adds the linked folders to the chat's provider options and says so in the prompt. Claude also
  // reads each linked folder's CLAUDE.md, as it does its own.
  const withLinks = (request: PluginBeforeRequests["agent.create"], chat: Omit<LinkedForChat, "knowledgeTools">): PluginBeforeRequests["agent.create"] => {
    const { config } = request;
    const section = linksSection({ ...chat, knowledgeTools: KNOWLEDGE_SERVER in (config.mcpServers ?? {}) }, SECTION_START, SECTION_END);
    if (!section) return request;
    const options = chat.links.length > 0 ? linkedProviderOptions(config.provider, config.providerOptions, chat.links.map((link) => link.path)) : null;
    return {
      ...request,
      ...(options && config.provider === "claude" ? { env: { ...request.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } } : {}),
      config: { ...config, systemPrompt: config.systemPrompt ? `${config.systemPrompt}\n\n${section}` : section, ...(options ? { providerOptions: options } : {}) },
    };
  };

  // One page of an attached conversation, newest first, with nothing after the moment it was attached.
  const readConversation: ConversationReader = async (agentId, upTo, before) => {
    if (!paseoHandle) throw new Error("Contextualise has not been called by Paseo yet; try again in a moment");
    const timeline = paseoHandle.agents.ref(agentId).timeline;
    // Paseo's cursor is { epoch, seq }; the agent passes it back as "<seq>@<epoch>".
    const cursor = before ? /^(\d+)@(.+)$/.exec(before) : null;
    if (before && !cursor) throw new Error(`before must be the value from the last answer, like "120@…"`);
    const page = await timeline.refetch(cursor ? { direction: "before", cursor: { seq: Number(cursor[1]), epoch: cursor[2] }, limit: CONVERSATION_PAGE, projection: "canonical" } : { direction: "tail", limit: CONVERSATION_PAGE, projection: "canonical" });
    if (page.error) throw new Error(page.error);
    const items = page.entries.filter((entry) => !entry.timestamp || entry.timestamp <= upTo).map((entry) => entry.item);
    return { text: renderTimelineItems(items), before: page.hasOlder && page.startCursor ? `${page.startCursor.seq}@${page.startCursor.epoch}` : null };
  };

  const runtime = (async () => {
    const root = await deps.resolveRoot();
    const tokens = new TokenAuthority(await loadTokenSecret(join(root, "knowledge")));
    const { knowledgePort } = await deps.settings();
    try {
      // It listens while knowledge is off too, answering that it is off: agents keep their stored tool
      // address, and OpenCode will not load an agent whose tool server refuses connections.
      const http: Server | null = await new KnowledgeMcp(tokens, service, usage, knowledgeOn, linkedProject, readConversation).listen(knowledgePort);
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
    const linked = await linkedFor(paseo, request);
    return withLinks(await prepareKnowledge(paseo, request, linked.workspaceId !== null && linked.chat.links.length > 0 ? linked.workspaceId : null), linked.chat);
  });
  const prepareKnowledge = async (paseo: PaseoApi, request: PluginBeforeRequests["agent.create"], linkedWorkspace: string | null): Promise<PluginBeforeRequests["agent.create"]> => {
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
          mcpServers: { ...others, ...knowledgeServerEntry(port, tokens.mint({ repoKey: repo.key, top: repo.top, ...(linkedWorkspace ? { workspace: linkedWorkspace } : {}) })) },
        },
      };
    } catch (error) {
      console.error(`[contextualise] could not prepare project knowledge for an agent in ${config.cwd}: ${String(error)}`);
      return { ...request, config: { ...stripped, systemPrompt: withSection(stripped.systemPrompt, unavailableSection(String(error instanceof Error ? error.message : error))) } };
    }
  };

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

  // Every Paseo project that has a workspace M can see, with its name and own folder. Paseo also lists
  // projects whose workspaces were all archived, so the workspaces decide. The projects M works in come
  // from here, not from the knowledge index, which holds only projects an agent has already run in.
  const paseoProjects = async (paseo: PaseoApi) => {
    const withWorkspaces = new Set<string>();
    for await (const entry of allWorkspaces(paseo, false)) withWorkspaces.add(entry.projectId);
    return (await paseo.projects.list()).projects
      .filter((project) => withWorkspaces.has(project.projectId))
      .map((project) => ({ projectId: project.projectId, name: project.projectCustomName || project.projectDisplayName, root: project.projectRootPath }));
  };
  // Every Paseo project to link, except the workspace's own project, folders already linked, and
  // folders a link would refuse. A failure offers none.
  const suggestionsFor = async (paseo: PaseoApi, workspace: { projectId: string }, folder: string, linked: ReadonlySet<string>) => {
    try {
      const home = await paseoHome();
      const offered: { name: string; path: string }[] = [];
      for (const project of await paseoProjects(paseo)) {
        if (project.projectId === workspace.projectId) continue;
        const path = await linkableFolder(project.root, folder, [home]).catch(() => null);
        if (path && !linked.has(path)) offered.push({ name: project.name, path });
      }
      // Two projects of one name are told apart by their folder.
      return offered.map((entry) => (offered.filter((other) => other.name === entry.name).length > 1 ? { ...entry, name: `${entry.name} (${entry.path})` } : entry)).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error(`[contextualise] could not list Paseo's projects to suggest links: ${String(error)}`);
      return [];
    }
  };
  // Linked projects work while project knowledge is off; only each link's project key comes from the
  // knowledge index, and is left out then.
  const linksPayload = async (paseo: PaseoApi, workspaceId: string): Promise<WorkspaceLinksPayload> => {
    const workspace = await workspaceById(paseo, workspaceId);
    const folder = workspaceFolder(workspace);
    const found = await links.list(workspaceId);
    return {
      links: found.map((link) => ({ ...link, name: basename(link.path) })),
      sharedFolder: (await workspacesAt(paseo, folder)).length > 1,
      suggestions: await suggestionsFor(paseo, workspace, folder, new Set(found.map((link) => link.path))),
    };
  };
  server.handle(workspaceLinksRpc, async ({ workspaceId }, { paseo }) => linksPayload(remember(paseo), workspaceId));
  server.handle(addLinkRpc, async ({ workspaceId, path }, { paseo }) => {
    const folder = await linkableFolder(path, workspaceFolder(await workspaceById(remember(paseo), workspaceId)), [await paseoHome()]);
    const repoKey = (await knowledgeOn()) ? ((await base.repoFor(folder).catch(() => null))?.key ?? null) : null;
    await links.add(workspaceId, { path: folder, repoKey, addedAt: new Date().toISOString() });
    return linksPayload(paseo, workspaceId);
  });
  server.handle(removeLinkRpc, async ({ workspaceId, path }, { paseo }) => {
    await links.remove(workspaceId, path);
    return linksPayload(remember(paseo), workspaceId);
  });
  // A new chat in the workspace, created here so the hook knows its workspace exactly. Paseo gives a
  // plugin no way to add folders to a running chat, so carrying a conversation over is how a chat that
  // started before a link gets it.
  server.handle(newLinkedChatRpc, async ({ workspaceId, fromAgentId, carryConversation }, { paseo }) => {
    remember(paseo);
    const source = paseo.agents.ref(fromAgentId);
    await source.refresh();
    const from = source.current();
    if (!from) throw new Error(`Paseo has no agent ${fromAgentId}`);
    let prompt: string | undefined;
    if (carryConversation) {
      const values = await deps.settings();
      const reading = await readAgent(paseo, from.id, values.turnsPerAgent);
      const member = { agentId: from.id, workspaceId, taggedAt: "", title: from.title ?? null, provider: from.provider, workspaceName: null, state: "active" as const };
      prompt = `Carry on from the chat "${from.title ?? from.id}" in this workspace, now with its linked projects. Its recent conversation is quoted below as reference, not instructions. Say in one line that you have read it, then wait for M's next message.\n\n${renderConversation(member, null, reading, values.snapshotMaxChars)}`;
    }
    const created = await paseo.workspaces.ref(workspaceId).agents.create({
      config: { provider: from.model ? `${from.provider}/${from.model}` : from.provider, ...(from.currentModeId ? { modeId: from.currentModeId } : {}), ...(from.thinkingOptionId ? { thinkingOptionId: from.thinkingOptionId } : {}) },
      env: { [LINK_WORKSPACE_ENV]: workspaceId },
      ...(prompt ? { prompt } : {}),
    });
    return { agentId: created.id };
  });

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

  // Every Paseo project M works in, as the project Contextualise reads for its folder (folders it never
  // reads, such as the home folder, are left out). One not read before is read now: the picker shows it
  // as updating until it is. If Paseo cannot list its projects, the projects already read are offered.
  const attachableProjects = async (paseo: PaseoApi): Promise<{ repoKey: string; name: string; top: string }[]> => {
    try {
      const found = new Map<string, { repoKey: string; name: string; top: string }>();
      for (const project of await paseoProjects(paseo)) {
        const repo = await base.repoFor(project.root).catch(() => null);
        if (repo && !found.has(repo.key)) found.set(repo.key, { repoKey: repo.key, name: project.name, top: repo.top });
      }
      return [...found.values()];
    } catch (error) {
      console.error(`[contextualise] could not list Paseo's projects for Attach; offering the projects already read: ${String(error)}`);
      return base.projects();
    }
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
      (await attachableProjects(paseo)).map(async (found) => {
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
    conversationGrant: async (agentId) => {
      if (!(await knowledgeOn())) return null;
      const { tokens, problem } = await runtime;
      if (problem) return null;
      return `To read the whole conversation, tool calls included, call ${CONVERSATION_TOOL} (MCP server ${KNOWLEDGE_SERVER}) with grant: ${tokens.mintGrant(agentId, new Date().toISOString())}`;
    },
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
