import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotSettingsSchema, type SnapshotSettings } from "../../shared/contracts";
import { KNOWLEDGE_SERVER } from "./mcp";
import { contributeKnowledge } from "./plugin";
import { SECTION_START } from "./section";
import { KnowledgeStore } from "./store";

type Handler = (...args: never[]) => unknown;

describe("contributeKnowledge", () => {
  let home: string;
  let top: string;
  let values: SnapshotSettings;
  let settingsProblem: Error | null;
  let stop: () => Promise<void>;
  let plugins: Record<string, unknown>;
  const before = new Map<string, Handler>();
  const rpcs = new Map<string, Handler>();
  const on = new Map<string, Handler[]>();
  const respondToPermission = vi.fn(async () => {});
  const timeline = [
    { item: { type: "user_message", text: "Document the queue" }, timestamp: "2026-10-29T10:00:00.000Z" },
    { item: { type: "tool_call", name: "edit", status: "completed", detail: { type: "edit", filePath: "README.md" } }, timestamp: "2026-10-29T10:01:00.000Z" },
  ];
  const paseo = {
    config: { get: async () => ({ requestId: "r", config: { plugins } }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) },
    agents: { ref: () => ({ respondToPermission, timeline: { refetch: async () => ({ entries: timeline, hasOlder: false, startCursor: null }) } }) },
  };
  const create = (cwd: string, config: Record<string, unknown> = {}) =>
    (before.get("agent.create") as (input: unknown, context: unknown) => Promise<{ config: { systemPrompt?: string; mcpServers: Record<string, unknown> } }>)({ request: { config: { provider: "claude", cwd, ...config } } }, { paseo });
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
    const server = {
      before: (name: string, handler: Handler) => before.set(name, handler),
      on: (name: string, handler: Handler) => on.set(name, [...(on.get(name) ?? []), handler]),
      handle: (contract: { name: string }, handler: Handler) => rpcs.set(contract.name, handler),
    };
    stop = contributeKnowledge(server as never, {
      resolveRoot: async () => join(home, "plugin-data", "contextualise"),
      settings: async () => {
        if (settingsProblem) throw settingsProblem;
        return values;
      },
    }).stop;
  });
  afterEach(async () => {
    await stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(top, { recursive: true, force: true });
  });

  it("gives an agent in a git repository the project map and the knowledge tools, keeping everything else", async () => {
    const { config } = await create(top, { systemPrompt: "Be brief.", mcpServers: { "paseo-memorise": { type: "http", url: "x" } } });
    expect(config.systemPrompt).toMatch(/^Be brief\.\n\n<!-- contextualise:knowledge -->/);
    expect(config.systemPrompt).toContain('- ARCHITECTURE.md "Overview"');
    expect(Object.keys(config.mcpServers).sort()).toEqual([KNOWLEDGE_SERVER, "paseo-memorise"]);
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

  it("offers matching entries to Attach, with the snippet that matched and the full text", async () => {
    await create(top);
    const { items } = (await (rpcs.get("knowledge.attach-search") as (input: unknown, context: unknown) => Promise<{ items: { title: string; subtitle: string; text: string; identifier: string }[] }>)({ query: "daemon" }, { paseo })) ?? { items: [] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ identifier: "Design", title: "Overview" });
    expect(items[0].subtitle).toMatch(/· ARCHITECTURE\.md:1 · One daemon\.$/);
    expect(items[0].text).toContain("quoted from the repository:\n\nOne daemon.");
  });

  it("offers each project's essentials in Attach when nothing is typed", async () => {
    await create(top);
    await emit("agent.turn_ended", { agent: { id: "a1", provider: "codex", cwd: top, title: null }, outcome: { kind: "completed" } });
    const { items } = (await (rpcs.get("knowledge.attach-search") as (input: unknown, context: unknown) => Promise<{ items: { identifier: string; title: string }[] }>)({ query: "" }, { paseo }))!;
    expect(items.map((item) => [item.identifier, item.title])).toEqual([
      ["Design", "Overview"],
      ["Past work", "Document the queue"],
    ]);
  });

  it("offers the project description first in Attach, not an area explanation", async () => {
    await create(top);
    const dir = join(home, "plugin-data", "contextualise", "knowledge");
    const store = new KnowledgeStore(join(dir, readdirSync(dir).find((name) => name.endsWith(".sqlite")) as string));
    store.replaceSource({ path: "(area)/api", kind: "brief", blob: "g", chunks: [{ title: "About api", body: "Serves requests.", line: 1 }] });
    store.replaceSource({ path: "(brief)", kind: "brief", blob: "g", chunks: [{ title: "About this project", body: "An API.", line: 1 }] });
    store.close();
    const { items } = (await (rpcs.get("knowledge.attach-search") as (input: unknown, context: unknown) => Promise<{ items: { identifier: string; title: string }[] }>)({ query: "" }, { paseo }))!;
    expect(items.map((item) => item.title)).toEqual(["About this project", "Overview"]);
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
    await vi.waitFor(async () => expect((await projects({}, { paseo })).projects[0].generation).toMatchObject({ state: "done", message: "summaries are off (Settings > Contextualise > Conversation summaries)" }));
  });

  it("records a task when an agent's turn ends, shown to the next agent", async () => {
    await emit("agent.turn_ended", { agent: { id: "a1", provider: "codex", cwd: top, title: null }, outcome: { kind: "completed" } });
    expect((await create(top)).config.systemPrompt).toContain('"Document the queue" (completed; README.md)');
  });
});
