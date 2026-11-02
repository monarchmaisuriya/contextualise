import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotSettingsSchema, type SnapshotSettings } from "../../shared/contracts";
import { KnowledgeBase } from "./base";
import { KNOWLEDGE_SERVER } from "./mcp";
import { contributeKnowledge, type KnowledgeContribution } from "./plugin";
import { SECTION_END, SECTION_START } from "./section";
import { KnowledgeStore } from "./store";

type Handler = (...args: never[]) => unknown;

describe("contributeKnowledge", () => {
  let home: string;
  let top: string;
  let values: SnapshotSettings;
  let settingsProblem: Error | null;
  let contribution: KnowledgeContribution;
  let plugins: Record<string, unknown>;
  const before = new Map<string, Handler>();
  const rpcs = new Map<string, Handler>();
  const on = new Map<string, Handler[]>();
  const respondToPermission = vi.fn(async () => {});
  const workspaceEntries: { id: string; workspaceDirectory: string; background?: boolean; projectId?: string }[] = [];
  const projectEntries: { projectId: string; projectDisplayName: string; projectCustomName?: string | null; projectRootPath: string }[] = [];
  const agentEntries: { agent: Record<string, unknown> }[] = [];
  let agentsDown = false;
  const timeline = [
    { item: { type: "user_message", text: "Document the queue" }, timestamp: "2026-10-29T10:00:00.000Z" },
    { item: { type: "tool_call", name: "edit", status: "completed", detail: { type: "edit", filePath: "README.md" } }, timestamp: "2026-10-29T10:01:00.000Z" },
  ];
  const paseo = {
    config: { get: async () => ({ requestId: "r", config: { plugins } }) },
    // Like Paseo, background workspaces are listed only when asked for.
    projects: { list: async () => ({ requestId: "r", projects: projectEntries }) },
    workspaces: { list: async (options?: { includeBackground?: boolean }) => ({ entries: workspaceEntries.filter((entry) => options?.includeBackground || !entry.background), pageInfo: { hasMore: false, nextCursor: null } }) },
    agents: {
      list: async () => {
        if (agentsDown) throw new Error("daemon busy");
        return { entries: agentEntries, pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref: () => ({ respondToPermission, timeline: { refetch: async () => ({ entries: timeline, hasOlder: false, startCursor: null }) } }),
    },
  };
  const create = (cwd: string, config: Record<string, unknown> = {}) =>
    (before.get("agent.create") as (input: unknown, context: unknown) => Promise<{ config: { systemPrompt?: string; mcpServers: Record<string, unknown> } }>)({ request: { config: { provider: "claude", cwd, ...config } } }, { paseo });
  const attach = (query: string) => (rpcs.get("knowledge.attach-search") as (input: unknown, context: unknown) => Promise<{ items: { identifier: string; title: string; subtitle: string; text: string }[] } | undefined>)({ query }, { paseo });
  const call = (name: string, input: unknown) => (rpcs.get(name) as (input: unknown, context: unknown) => Promise<unknown>)(input, { paseo });
  const emit = async (name: string, event: unknown) => {
    for (const handler of on.get(name) ?? []) await (handler as (event: unknown, context: unknown) => Promise<void>)(event, { paseo });
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "contextualise-plugin-home-"));
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-plugin-repo-")));
    execFileSync("git", ["init", "-q", top]);
    for (const [path, text] of [
      ["ARCHITECTURE.md", "# Overview\nOne daemon.\n"],
      ["README.md", "# Api\n"],
    ]) {
      mkdirSync(dirname(join(top, path)), { recursive: true });
      writeFileSync(join(top, path), text);
    }
    execFileSync("git", ["-C", top, "add", "-A"]);
    values = snapshotSettingsSchema.parse({ knowledgePort: 46_000 + Math.floor(Math.random() * 1_000) });
    plugins = { contextualise: { source: "directory", path: process.cwd(), enabled: true } };
    settingsProblem = null;
    before.clear();
    rpcs.clear();
    on.clear();
    respondToPermission.mockClear();
    // Paseo knows the test repository as a project with one workspace.
    workspaceEntries.length = 0;
    workspaceEntries.push({ id: "w-top", workspaceDirectory: top, projectId: "p-top" });
    projectEntries.length = 0;
    projectEntries.push({ projectId: "p-top", projectDisplayName: basename(top), projectRootPath: top });
    const server = {
      before: (name: string, handler: Handler) => before.set(name, handler),
      on: (name: string, handler: Handler) => on.set(name, [...(on.get(name) ?? []), handler]),
      handle: (contract: { name: string }, handler: Handler) => rpcs.set(contract.name, handler),
    };
    contribution = contributeKnowledge(server as never, {
      resolveRoot: async () => join(home, "plugin-data", "contextualise"),
      settings: async () => {
        if (settingsProblem) throw settingsProblem;
        return values;
      },
    });
  });
  afterEach(async () => {
    await contribution.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(top, { recursive: true, force: true });
  });

  it("gives an agent in a git repository the project map and the knowledge tools, keeping everything else", async () => {
    const { config } = await create(top, { systemPrompt: "Be brief.", mcpServers: { "paseo-memorise": { type: "http", url: "x" } } });
    expect(config.systemPrompt).toMatch(/^Be brief\.\n\n<!-- contextualise:knowledge -->/);
    expect(config.systemPrompt).toContain('- ARCHITECTURE.md "Overview"');
    expect(Object.keys(config.mcpServers).sort()).toEqual([KNOWLEDGE_SERVER, "paseo-memorise"]);
  });

  it("counts each agent given the knowledge tools, and answers the project's use over the last 7 days", async () => {
    await create(top);
    await create(top);
    const call = (name: string, input: unknown) => (rpcs.get(name) as (input: unknown, context: unknown) => Promise<unknown>)(input, { paseo });
    const { projects } = (await call("knowledge.projects", {})) as { projects: { repoKey: string }[] };
    expect(await call("knowledge.usage", { repoKey: projects[0].repoKey })).toMatchObject({ days: 7, agentsGiven: 2, agentsUsed: 0 });
  });

  it("names the project a workspace's folder belongs to, and says when Paseo has no such workspace", async () => {
    await create(top);
    workspaceEntries.splice(0, workspaceEntries.length, { id: "w1", workspaceDirectory: top });
    const call = (name: string, input: unknown) => (rpcs.get(name) as (input: unknown, context: unknown) => Promise<unknown>)(input, { paseo });
    const { projects } = (await call("knowledge.projects", {})) as { projects: { repoKey: string }[] };
    expect(await call("knowledge.project-for", { workspaceId: "w1" })).toEqual({ repoKey: projects[0].repoKey });
    await expect(call("knowledge.project-for", { workspaceId: "gone" })).rejects.toThrow(/no workspace gone/);
  });

  it("answers a project's pulse: its live agents and what waits for M, and its commits in the viewer's days", async () => {
    await create(top);
    execFileSync("git", ["-C", top, "-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-q", "-m", "Start"]);
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-plugin-other-")));
    agentEntries.splice(
      0,
      agentEntries.length,
      { agent: { id: "a1", title: "Asks", cwd: top, status: "running", pendingPermissions: [{ id: "p" }] } },
      { agent: { id: "a2", title: "Works", cwd: top, status: "running", pendingPermissions: [] } },
      { agent: { id: "a3", title: "Elsewhere", cwd: elsewhere, status: "error", pendingPermissions: [] } },
      { agent: { id: "a4", title: "Paseo's own", cwd: top, status: "error", internal: true } },
    );
    try {
      const call = (name: string, input: unknown) => (rpcs.get(name) as (input: unknown, context: unknown) => Promise<unknown>)(input, { paseo });
      const { projects } = (await call("knowledge.projects", {})) as { projects: { repoKey: string }[] };
      const input = { repoKey: projects[0].repoKey, days: 7, utcOffsetMinutes: 330 };
      expect(await call("knowledge.agents-now", { repoKey: projects[0].repoKey })).toMatchObject({ available: true, running: 2, needsYou: 1, finished: 0, waiting: [{ kind: "agent", agentId: "a1", reason: "permission" }] });
      expect(await call("knowledge.pulse", input)).toMatchObject({ failures: [], agentWork: { done: 0, failed: 0, perDay: { counts: [0, 0, 0, 0, 0, 0, 0] } }, readme: "README.md" });
      expect(await call("knowledge.changes", input)).toMatchObject({ available: true, commits: 1, commitsTruncated: false, filesChanged: 2, perDay: { counts: [0, 0, 0, 0, 0, 0, 1] } });
      // The agent list failing says so in the agents part; the rest of the pulse still answers.
      agentsDown = true;
      expect(await call("knowledge.agents-now", { repoKey: projects[0].repoKey })).toMatchObject({ available: false, problem: "Could not read Paseo's agents: daemon busy", waiting: [] });
      expect(await call("knowledge.pulse", input)).toMatchObject({ readme: "README.md" });
    } finally {
      agentsDown = false;
      agentEntries.splice(0);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("asks for the knowledge tools to load upfront, so agents need no tool search before the first call", async () => {
    const { config } = await create(top);
    expect(config.mcpServers[KNOWLEDGE_SERVER]).toMatchObject({ type: "http", alwaysLoad: true });
  });

  it("replaces what a parent agent passed down instead of adding a second copy", async () => {
    const first = await create(top);
    const child = await create(top, first.config);
    expect(child.config.systemPrompt?.split(SECTION_START)).toHaveLength(2);
  });

  it("gives a folder outside git knowledge too, but never plugin data, and nothing when knowledge is off", async () => {
    const folder = join(home, "notes");
    mkdirSync(folder);
    writeFileSync(join(folder, "ARCHITECTURE.md"), "# Notes layout\nOne file per topic.\n");
    expect((await create(folder)).config.systemPrompt).toContain('- ARCHITECTURE.md "Notes layout"');
    const worker = join(home, "plugin-data", "contextualise", "workers");
    mkdirSync(worker, { recursive: true });
    expect((await create(worker, { systemPrompt: "x" })).config).toMatchObject({ systemPrompt: "x", mcpServers: {} });
    values = { ...values, knowledgeEnabled: false };
    expect((await create(top, { systemPrompt: "x" })).config).toMatchObject({ systemPrompt: "x", mcpServers: {} });
  });

  it("points agents to Memorise only when its heartbeat is fresh", async () => {
    expect((await create(top)).config.systemPrompt).not.toContain("Memorise");
  });

  it("points agents to Memorise when it is available", async () => {
    const interop = join(home, "plugin-data", "memorise", "interop", "v1");
    mkdirSync(interop, { recursive: true });
    writeFileSync(join(interop, "status.json"), JSON.stringify({ version: 1, plugin: "memorise", writtenAt: new Date().toISOString() }));
    expect((await create(top)).config.systemPrompt).toContain("known pitfalls are kept in Memorise");
  });

  it("still creates the agent when knowledge fails, saying why", async () => {
    settingsProblem = new Error("Contextualise settings are invalid");
    const broken = await create(top, { systemPrompt: "x" });
    expect(broken.config.systemPrompt).toBe("x\n\n<!-- contextualise:knowledge -->\nProject knowledge (Contextualise) is unavailable for this agent: Contextualise settings are invalid\n<!-- /contextualise:knowledge -->");
    expect(broken.config.mcpServers).toEqual({});
  });

  it("still maps documents when code symbols cannot be read", async () => {
    plugins = {};
    expect((await create(top)).config.systemPrompt).toContain('- ARCHITECTURE.md "Overview"');
  });

  it("gives a switched-off project nothing, and puts pinned entries in the map", async () => {
    await create(top);
    const call = (name: string, input: unknown) => (rpcs.get(name) as (input: unknown, context: unknown) => Promise<unknown>)(input, { paseo });
    const { projects } = (await call("knowledge.projects", {})) as { projects: { repoKey: string; enabled: boolean }[] };
    const repoKey = projects[0].repoKey;
    await call("knowledge.pin", { repoKey, id: "architecture:ARCHITECTURE.md:1", pinned: true });
    expect((await create(top)).config.systemPrompt).toContain('Pinned:\n- ARCHITECTURE.md:1 "Overview"');
    await call("knowledge.project-enabled", { repoKey, enabled: false });
    expect((await create(top, { systemPrompt: "x" })).config).toMatchObject({ systemPrompt: "x", mcpServers: {} });
    await emit("agent.turn_ended", { agent: { id: "a2", provider: "codex", cwd: top, title: null }, outcome: { kind: "completed" } });
    await call("knowledge.project-enabled", { repoKey, enabled: true });
    expect((await create(top)).config.systemPrompt).not.toContain("Document the queue");
  });

  it("leaves knowledge tool requests to the user when automatic approval is off", async () => {
    values = { ...values, knowledgeAutoApproveTools: false };
    await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "p1", name: `mcp__${KNOWLEDGE_SERVER}__knowledge_search` } });
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("approves the knowledge tools and nothing else", async () => {
    await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "p1", name: `mcp__${KNOWLEDGE_SERVER}__knowledge_search` } });
    await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "p2", name: "Bash" } });
    expect(respondToPermission).toHaveBeenCalledTimes(1);
    expect(respondToPermission).toHaveBeenCalledWith({ requestId: "p1", response: { behavior: "allow" } });
  });

  it("approves only the knowledge tools by exact name, not other tools on a server with a similar name", async () => {
    const ask = (id: string, request: Record<string, unknown>) => emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id, ...request } });
    await ask("p1", { name: `mcp__${KNOWLEDGE_SERVER}__x__write_file` });
    await ask("p2", { name: `mcp__${KNOWLEDGE_SERVER}__delete_everything` });
    await ask("p3", { name: "CodexMcpElicitation", metadata: { serverName: KNOWLEDGE_SERVER }, description: 'Allow the paseo-contextualise MCP server to run tool "drop_table"?' });
    await ask("p4", { name: "CodexMcpElicitation", metadata: { serverName: KNOWLEDGE_SERVER }, description: 'Allow the paseo-contextualise MCP server to run tool "knowledge_read"?' });
    await ask("p5", { name: `mcp__${KNOWLEDGE_SERVER}__knowledge_history` });
    await ask("p6", { name: `mcp__${KNOWLEDGE_SERVER}__knowledge_impact` });
    // Reading another agent's conversation is left to M every time.
    await ask("p7", { name: `mcp__${KNOWLEDGE_SERVER}__conversation_read` });
    expect(respondToPermission.mock.calls.map((call) => (call as unknown as [{ requestId: string }])[0].requestId)).toEqual(["p4", "p5", "p6"]);
  });

  it("offers matching entries to Attach, with the snippet that matched and the full text", async () => {
    await create(top);
    const { items } = (await (rpcs.get("knowledge.attach-search") as (input: unknown, context: unknown) => Promise<{ items: { title: string; subtitle: string; text: string; identifier: string }[] }>)({ query: "daemon" }, { paseo })) ?? { items: [] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ identifier: "", title: "Overview" });
    expect(items[0].subtitle).toMatch(/· ARCHITECTURE\.md:1 · One daemon\.$/);
    expect(items[0].text).toContain("quoted from the repository:\n\nOne daemon.");
  });

  it("offers each whole project in Attach when nothing is typed, after checking it for changes", async () => {
    await create(top);
    await emit("agent.turn_ended", { agent: { id: "a1", provider: "codex", cwd: top, title: null }, outcome: { kind: "completed" } });
    const dir = join(home, "plugin-data", "contextualise", "knowledge");
    const store = new KnowledgeStore(join(dir, readdirSync(dir).find((name) => name.endsWith(".sqlite")) as string));
    store.replaceSource({ path: "(area)/api", kind: "brief", blob: "g", chunks: [{ title: "About api", body: "Serves requests.", line: 1 }] });
    store.replaceSource({ path: "(brief)", kind: "brief", blob: "g", chunks: [{ title: "About this project", body: "An API.", line: 1 }] });
    store.close();
    const refresh = vi.spyOn(KnowledgeBase.prototype, "refresh");
    const { items } = (await attach(""))!;
    expect(refresh.mock.calls.map(([, maxWaitMs]) => maxWaitMs)).toEqual([300]);
    refresh.mockRestore();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ identifier: "", title: expect.stringMatching(/^contextualise-plugin-repo-/) });
    expect(items[0].subtitle).toMatch(/^1 document · about \d+ tokens · /);
    expect(items[0].text).toContain("An API.");
    expect(items[0].text).not.toContain("Serves requests.");
    expect(items[0].text).toContain("### ARCHITECTURE.md\n#### Overview\nOne daemon.");
    expect(items[0].text).toContain("Document the queue (completed)");
  });

  it("offers every Paseo project with a visible workspace in Attach, also one no agent has run in, but not one whose workspaces were all archived", async () => {
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-plugin-fresh-")));
    const old = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-plugin-old-")));
    try {
      for (const folder of [fresh, old]) execFileSync("git", ["init", "-q", folder]);
      projectEntries.push({ projectId: "p-fresh", projectDisplayName: "fresh", projectCustomName: "Backend", projectRootPath: fresh }, { projectId: "p-old", projectDisplayName: "old", projectRootPath: old });
      workspaceEntries.push({ id: "w-fresh", workspaceDirectory: fresh, projectId: "p-fresh" });
      const titles = (await attach(""))!.items.map((item) => item.title);
      expect(titles).toEqual(expect.arrayContaining([basename(top), "Backend"]));
      expect(titles).not.toContain("old");
      expect(titles).toHaveLength(2);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
      rmSync(old, { recursive: true, force: true });
    }
  });

  it("shows an edit made since the last check, once the check is due", async () => {
    await create(top);
    writeFileSync(join(top, "ARCHITECTURE.md"), "# Overview\nTwo daemons.\n");
    execFileSync("git", ["-C", top, "add", "-A"]);
    await call("knowledge.reindex", { repoKey: ((await call("knowledge.projects", {})) as { projects: { repoKey: string }[] }).projects[0].repoKey });
    expect((await attach("daemons"))!.items.map((item) => item.text)).toEqual([expect.stringContaining("Two daemons.")]);
  });

  it("waits at most 300 ms for a project's check, then answers from its index and says it is updating", async () => {
    await create(top);
    const refresh = vi.spyOn(KnowledgeBase.prototype, "refresh").mockImplementation((_repo, maxWaitMs) => new Promise((done) => setTimeout(() => done("updating"), maxWaitMs)));
    try {
      const started = Date.now();
      const { items } = (await attach("daemon"))!;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(refresh.mock.calls.map(([, maxWaitMs]) => maxWaitMs)).toEqual([300, 0, 0]);
      expect(items.map((item) => item.title)).toEqual(["Overview"]);
      expect(items[0].subtitle).toContain(" · updating · ");
      expect((await attach(""))!.items[0].subtitle).toMatch(/^Updating · /);
    } finally {
      refresh.mockRestore();
    }
    expect((await attach("plugin-repo"))!.items[0].title).toMatch(/^contextualise-plugin-repo-/);
  });

  it("puts a word before knowledge rows in Attach only when the label setting asks for one", async () => {
    await create(top);
    values = { ...values, pickerPrefix: "word" };
    expect((await attach(""))!.items.map((item) => item.identifier)).toEqual(["Whole project"]);
    expect((await attach("daemon"))!.items.map((item) => item.identifier)).toEqual(["Design"]);
  });

  it("does nothing while knowledge is off: no RPC answers, Attach offers nothing, no folder is recorded, and no titles are read", async () => {
    await create(top);
    values = { ...values, knowledgeEnabled: false };
    for (const [name, handler] of rpcs) {
      // Linked projects are folder access, not knowledge, so they keep working while it is off.
      if (name === "knowledge.attach-search" || name === "knowledge.memorise-status" || name.startsWith("links.")) continue;
      await expect((handler as (input: unknown, context: unknown) => Promise<unknown>)({}, { paseo }), name).rejects.toThrow("Project knowledge is off. Turn it on in Settings > Contextualise.");
    }
    expect(await attach("")).toEqual({ items: [] });
    const folders = join(home, "plugin-data", "contextualise", "knowledge", "folders.json");
    const folder = join(home, "notes");
    mkdirSync(folder);
    await emit("workspace.created", { workspace: { cwd: folder } });
    expect(existsSync(folders)).toBe(false);
    expect(await contribution.generatedTitles()).toEqual(new Map());
  });

  it("keeps the tool server listening while knowledge is off, so agents given its address still load", async () => {
    await create(top);
    values = { ...values, knowledgeEnabled: false };
    const listening = await new Promise<boolean>((done) => connect(values.knowledgePort, "127.0.0.1").on("connect", function (this: Socket) { this.destroy(); done(true); }).on("error", () => done(false)));
    expect(listening).toBe(true);
  });

  it("refuses to explain an unknown area before starting anything, and starts writing a description", async () => {
    await create(top);
    const explain = rpcs.get("knowledge.explain-area") as (input: unknown, context: unknown) => Promise<{ started: boolean }>;
    const describe = rpcs.get("knowledge.describe") as (input: unknown, context: unknown) => Promise<{ started: boolean }>;
    const projects = rpcs.get("knowledge.projects") as (input: unknown, context: unknown) => Promise<{ projects: { repoKey: string; generation: unknown }[] }>;
    const [found] = (await projects({}, { paseo })).projects;
    await expect(explain({ repoKey: found.repoKey, path: "nowhere" }, { paseo })).rejects.toThrow('Unknown area "nowhere"');
    expect((await projects({}, { paseo })).projects[0].generation).toBeNull();
    expect(await describe({ repoKey: found.repoKey }, { paseo })).toEqual({ started: true });
    // Summaries are off in this test, so the job ends at once and says so.
    await vi.waitFor(async () => expect((await projects({}, { paseo })).projects[0].generation).toMatchObject({ state: "done", message: "summaries are off (Settings > Contextualise > Project knowledge > Write summaries of finished conversations)" }));
  });

  it("previews exactly the section an agent is given, without markers, refreshing and counting nothing", async () => {
    const injected = (await create(top, { systemPrompt: "x" })).config.systemPrompt as string;
    const call = (name: string, input: unknown) => (rpcs.get(name) as (input: unknown, context: unknown) => Promise<unknown>)(input, { paseo });
    const { projects } = (await call("knowledge.projects", {})) as { projects: { repoKey: string }[] };
    const repoKey = projects[0].repoKey;
    const section = injected.slice(injected.indexOf(SECTION_START) + SECTION_START.length + 1, injected.indexOf(SECTION_END) - 1);
    const refresh = vi.spyOn(KnowledgeBase.prototype, "refresh");
    expect(await call("knowledge.overview", { repoKey })).toEqual({ state: "given", text: section, lines: section.split("\n").length });
    expect(refresh).not.toHaveBeenCalled();
    refresh.mockRestore();
    expect(await call("knowledge.usage", { repoKey })).toMatchObject({ agentsGiven: 1 });
  });

  it("previews off when the project is off, and no text at 0 lines", async () => {
    await create(top);
    const call = (name: string, input: unknown) => (rpcs.get(name) as (input: unknown, context: unknown) => Promise<unknown>)(input, { paseo });
    const { projects } = (await call("knowledge.projects", {})) as { projects: { repoKey: string }[] };
    const repoKey = projects[0].repoKey;
    values = { ...values, knowledgeMapLines: 0 };
    expect(await call("knowledge.overview", { repoKey })).toEqual({ state: "given", text: null, lines: 0 });
    await call("knowledge.project-enabled", { repoKey, enabled: false });
    expect(await call("knowledge.overview", { repoKey })).toEqual({ state: "off", text: null, lines: 0 });
  });

  it("records a task when an agent's turn ends, shown to the next agent", async () => {
    await emit("agent.turn_ended", { agent: { id: "a1", provider: "codex", cwd: top, title: null }, outcome: { kind: "completed" } });
    expect((await create(top)).config.systemPrompt).toContain('"Document the queue" (completed; README.md)');
  });

  describe("linked projects", () => {
    let api: string;
    let web2: string;
    type Created = { config: { systemPrompt?: string; providerOptions?: Record<string, unknown> }; env?: Record<string, string> };
    const createIn = (cwd: string, config: Record<string, unknown> = {}, env?: Record<string, string>) =>
      (before.get("agent.create") as (input: unknown, context: unknown) => Promise<Created>)({ request: { config: { provider: "claude", cwd, ...config }, ...(env ? { env } : {}) } }, { paseo });
    beforeEach(() => {
      api = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-linked-api-")));
      web2 = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-linked-web2-")));
      workspaceEntries.length = 0;
      workspaceEntries.push({ id: "w1", workspaceDirectory: top, projectId: "p-web" }, { id: "w2", workspaceDirectory: web2, projectId: "p-web2" });
      projectEntries.length = 0;
    });
    afterEach(() => {
      rmSync(api, { recursive: true, force: true });
      rmSync(web2, { recursive: true, force: true });
    });

    it("gives every new Claude or Codex chat in the linked workspace the folder, and no chat in another workspace", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      const claude = await createIn(top);
      expect(claude.config.providerOptions).toEqual({ additionalDirectories: [api] });
      expect(claude.env).toEqual({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
      expect(claude.config.systemPrompt).toContain(`## Linked projects (Contextualise)`);
      expect(claude.config.systemPrompt).toContain(`: ${api}`);
      expect((await createIn(top, { provider: "codex" })).config.providerOptions).toEqual({ sandbox_workspace_write: { writable_roots: [api] } });
      const other = await createIn(web2);
      expect(other.config.providerOptions).toBeUndefined();
      expect(other.config.systemPrompt ?? "").not.toContain("Linked projects");
    });

    it("gives a provider other than Claude or Codex no folder options, and says why", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      const created = await createIn(top, { provider: "opencode" });
      expect(created.config.providerOptions).toBeUndefined();
      expect(created.config.systemPrompt).toContain("only to Claude and Codex chats, not opencode");
    });

    it("adds no folder when several workspaces share the chat's folder, background ones included, unless Contextualise created the chat", async () => {
      workspaceEntries.push({ id: "w3", workspaceDirectory: top, background: true });
      await call("links.add", { workspaceId: "w1", path: api });
      const shared = await createIn(top);
      expect(shared.config.providerOptions).toBeUndefined();
      expect(shared.config.systemPrompt).toContain("shared by several Paseo workspaces");
      expect((await createIn(top, {}, { CONTEXTUALISE_LINK_WORKSPACE: "w1" })).config.providerOptions).toEqual({ additionalDirectories: [api] });
      // A marker naming a workspace in another folder is not trusted.
      expect((await createIn(top, {}, { CONTEXTUALISE_LINK_WORKSPACE: "w2" })).config.providerOptions).toBeUndefined();
    });

    it("stops giving a folder once it is removed, or once it is replaced by a symlink", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      await call("links.remove", { workspaceId: "w1", path: api });
      expect((await createIn(top)).config.providerOptions).toBeUndefined();
      await call("links.add", { workspaceId: "w1", path: api });
      const moved = `${api}-moved`;
      renameSync(api, moved);
      symlinkSync(web2, api);
      expect((await createIn(top)).config.providerOptions).toBeUndefined();
      rmSync(api);
      renameSync(moved, api);
    });

    it("refuses to link Paseo's own data folder", async () => {
      mkdirSync(join(home, "plugin-data"), { recursive: true });
      await expect(call("links.add", { workspaceId: "w1", path: join(home, "plugin-data") })).rejects.toThrow("Paseo's own data folder");
    });

    it("keeps an existing folder option and adds the link once", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      expect((await createIn(top, { providerOptions: { additionalDirectories: ["/elsewhere", api] } })).config.providerOptions).toEqual({ additionalDirectories: ["/elsewhere", api] });
    });

    it("starts a linked chat in the workspace like the one it was asked from, marked so the hook knows its workspace", async () => {
      const created: unknown[] = [];
      const api = paseo as unknown as Record<string, Record<string, unknown>>;
      const ref = api.agents.ref;
      api.agents.ref = () => ({ refresh: async () => null, current: () => ({ id: "a1", provider: "claude", model: "opus", currentModeId: "default", thinkingOptionId: null, title: "Fix login" }), timeline: { refetch: async () => ({ entries: timeline, hasOlder: false, startCursor: null }) } });
      api.workspaces.ref = (workspaceId: string) => ({ agents: { create: async (options: unknown) => (created.push({ workspaceId, ...(options as object) }), { id: "a2" }) } });
      try {
        expect(await call("links.new-chat", { workspaceId: "w1", fromAgentId: "a1", carryConversation: false })).toEqual({ agentId: "a2" });
        expect(created[0]).toEqual({ workspaceId: "w1", config: { provider: "claude/opus", modeId: "default" }, env: { CONTEXTUALISE_LINK_WORKSPACE: "w1" } });
        await call("links.new-chat", { workspaceId: "w1", fromAgentId: "a1", carryConversation: true });
        expect((created[1] as { prompt: string }).prompt).toMatch(/^Carry on from the chat "Fix login"[\s\S]*Document the queue/);
      } finally {
        api.agents.ref = ref;
        delete api.workspaces.ref;
      }
    });

    it("suggests every Paseo project that has a visible workspace, indexed or not and with knowledge off, except this workspace's own and those it cannot link", async () => {
      values = { ...values, knowledgeEnabled: false };
      const old = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-linked-old-")));
      const worker = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-linked-worker-")));
      try {
        workspaceEntries.push({ id: "wa", workspaceDirectory: api, projectId: "p-api" }, { id: "wb", workspaceDirectory: worker, projectId: "p-worker", background: true }, { id: "wg", workspaceDirectory: join(api, "gone"), projectId: "p-gone" });
        projectEntries.push(
          { projectId: "p-web", projectDisplayName: "web", projectRootPath: top },
          { projectId: "p-api", projectDisplayName: "api", projectCustomName: "Backend", projectRootPath: api },
          { projectId: "p-web2", projectDisplayName: "web2", projectRootPath: web2 },
          // No workspace left, only a background one, a folder that is gone, and one holding this workspace.
          { projectId: "p-old", projectDisplayName: "old", projectRootPath: old },
          { projectId: "p-worker", projectDisplayName: "worker", projectRootPath: worker },
          { projectId: "p-gone", projectDisplayName: "gone", projectRootPath: join(api, "gone") },
          { projectId: "p-parent", projectDisplayName: "parent", projectRootPath: dirname(top) },
        );
        workspaceEntries.push({ id: "wp", workspaceDirectory: dirname(top), projectId: "p-parent" });
        const suggested = async () => ((await call("links.list", { workspaceId: "w1" })) as { suggestions: { name: string; path: string }[] }).suggestions;
        expect(await suggested()).toEqual([{ name: "Backend", path: api }, { name: "web2", path: web2 }]);
        await call("links.add", { workspaceId: "w1", path: api });
        expect(await suggested()).toEqual([{ name: "web2", path: web2 }]);
      } finally {
        rmSync(old, { recursive: true, force: true });
        rmSync(worker, { recursive: true, force: true });
      }
    });

    it("lists a workspace's links with whether its folder is shared, and works while knowledge is off", async () => {
      values = { ...values, knowledgeEnabled: false };
      const listed = (await call("links.add", { workspaceId: "w1", path: api })) as { links: { path: string; name: string; repoKey: string | null }[]; sharedFolder: boolean; suggestions: unknown[] };
      expect(listed).toMatchObject({ links: [{ path: api, name: basename(api), repoKey: null }], sharedFolder: false });
      workspaceEntries.push({ id: "w4", workspaceDirectory: top });
      expect(((await call("links.list", { workspaceId: "w1" })) as { sharedFolder: boolean }).sharedFolder).toBe(true);
    });
  });
});
