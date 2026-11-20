import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginOpenSupport, PluginPriorContribution, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { snapshotSettingsSchema, type SnapshotSettings } from "../../shared/contracts";
import { KnowledgeBase } from "./base";
import { TokenAuthority } from "./auth";
import { KNOWLEDGE_SERVER } from "./mcp";
import { contributeKnowledge, type KnowledgeContribution } from "./plugin";
import { SECTION_END, SECTION_START } from "./section";
import { KnowledgeStore } from "./store";

type Handler = (...args: never[]) => unknown;
interface TestLaunch {
  id: string;
  dispose: ((outcome: { installed: boolean }) => void | Promise<void>)[];
  installedCallbacks: (() => void | Promise<void>)[];
  installed: boolean;
  released: boolean;
  refs: number;
  previous?: TestLaunch;
  snapshot?: PluginPriorContribution;
  controller: AbortController;
}

function knowledgeAuthorization(opened: Pick<PluginSessionOpenRequest, "mcpServers">): string {
  const binding = opened.mcpServers[KNOWLEDGE_SERVER];
  if (binding?.type !== "http") throw new Error("Expected the knowledge binding to use HTTP");
  const authorization = binding.headers?.Authorization;
  if (!authorization) throw new Error("Expected the knowledge HTTP binding to include Authorization");
  return authorization;
}

describe("contributeKnowledge", () => {
  let home: string;
  let top: string;
  let values: SnapshotSettings;
  let settingsProblem: Error | null;
  let contribution: KnowledgeContribution;
  let authority: TokenAuthority;
  let plugins: Record<string, unknown>;
  let recipe: Parameters<PluginServerContext["registerLegacyAgentConfig"]>[0];
  const launches: TestLaunch[] = [];
  const release = async (launch: TestLaunch): Promise<void> => {
    launch.refs -= 1;
    if (launch.refs > 0) return;
    launch.controller.abort();
    for (const cleanup of launch.dispose) await cleanup({ installed: launch.installed });
    if (launch.previous) await release(launch.previous);
  };
  const closeLaunch = async (launch: TestLaunch) => {
    if (launch.released) return;
    launch.released = true;
    await release(launch);
  };
  const before = new Map<string, Handler>();
  const rpcs = new Map<string, Handler>();
  const on = new Map<string, Handler[]>();
  const respondToPermission = vi.fn(async () => {});
  const workspaceEntries: { id: string; workspaceDirectory: string; background?: boolean; projectId?: string; name?: string; projectDisplayName?: string; workspaceKind?: string; gitRuntime?: { currentBranch: string } }[] = [];
  const projectEntries: { projectId: string; projectDisplayName: string; projectCustomName?: string | null; projectRootPath: string }[] = [];
  const agentEntries: { agent: Record<string, unknown> }[] = [];
  let agentsDown = false;
  let tagSummaries: unknown[] = [];
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
  const supportFor = (provider = "claude"): PluginOpenSupport => ({
    adapter: { kind: "builtin", id: provider }, instructions: "supported", mcpHttp: "supported", exactMcpPreapproval: "supported",
    attachedTools: { delivery: "mcp", enabled: true, disabledTools: [] },
    restrictions: { mcpConfiguration: "mutable", processEnvironment: "mutable" },
    providerOptions: ["additionalDirectories", "sandbox_workspace_write", "permission"],
  });
  const open = async (cwd: string, config: Record<string, unknown> = {}, env: Record<string, string> = {}, overrides: Partial<PluginSessionOpenRequest> = {}, install = true) => {
    const provider = typeof config.provider === "string" ? config.provider : "claude";
    const controller = new AbortController();
    const state: TestLaunch = { id: `launch-${launches.length + 1}`, controller, dispose: [], installedCallbacks: [], installed: false, released: false, refs: 1 };
    launches.push(state);
    const prompt = typeof config.systemPrompt === "string" ? config.systemPrompt : "";
    const selectors = Object.fromEntries(recipe.selectors.map((selector) => [selector.id, selector.kind === "prompt-section" && (prompt.includes(selector.start) || prompt.includes(selector.end)) ? "present" : "absent"]));
    const request = { agentId: "a1", workspaceId: null, provider, cwd, reason: "create", purpose: "interactive", title: null, background: false, labels: {}, metadata: {}, env, tools: [], mcpServers: {}, openSupport: supportFor(provider), baseConfig: { provider, cwd, ...config }, legacyConfigState: { selectors }, ...overrides } as PluginSessionOpenRequest;
    const result = await (before.get("agent.open.before") as (input: unknown, context: unknown) => Promise<PluginSessionOpenRequest>)({ request }, { paseo, signal: controller.signal, launch: {
      id: state.id, signal: controller.signal,
      onDispose: (cleanup: TestLaunch["dispose"][number]) => state.dispose.push(cleanup),
      onInstalled: (callback: TestLaunch["installedCallbacks"][number]) => state.installedCallbacks.push(callback),
      retainPrevious: () => {
        const previous = launches.find((entry) => entry.id === request.previousContribution?.launchId);
        if (!previous?.installed || previous.controller.signal.aborted || !previous.snapshot) throw new Error("No live installed previous launch");
        if (!state.previous) { previous.refs += 1; state.previous = previous; }
        return previous.snapshot;
      },
    } });
    state.snapshot = { launchId: state.id, mcpServers: result.mcpServers, env: result.env, appendSystemPrompt: result.appendSystemPrompt, toolPolicy: result.toolPolicy, providerOptions: result.providerOptions };
    if (install) {
      state.installed = true;
      for (const installed of state.installedCallbacks) await installed();
    }
    return result;
  };
  const create = async (cwd: string, config: Record<string, unknown> = {}, env?: Record<string, string>): Promise<{ config: { systemPrompt?: string; mcpServers: PluginSessionOpenRequest["mcpServers"]; providerOptions?: Record<string, unknown>; toolPolicy?: PluginSessionOpenRequest["toolPolicy"] }; env?: Record<string, string> }> => {
    const opened = await open(cwd, config, env);
    const prompt = [config.systemPrompt, ...(opened.appendSystemPrompt ?? [])].filter(Boolean).join("\n\n");
    return { config: { systemPrompt: prompt || undefined, mcpServers: { ...(config.mcpServers as PluginSessionOpenRequest["mcpServers"] ?? {}), ...opened.mcpServers }, providerOptions: (config.providerOptions as Record<string, unknown> | undefined) ?? opened.providerOptions, toolPolicy: (config.toolPolicy as PluginSessionOpenRequest["toolPolicy"]) ?? opened.toolPolicy }, env: Object.keys(opened.env).length ? opened.env : undefined };
  };
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
    // Chat history is covered by its own tests; off here, so prompts compare exactly.
    values = snapshotSettingsSchema.parse({ knowledgePort: 46_000 + Math.floor(Math.random() * 1_000), historyTools: false });
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
      registerLegacyAgentConfig: (value: typeof recipe) => { recipe = value; },
      addHook: (name: string, handler: Handler) => before.set(name, handler),
      before: (name: string, handler: Handler) => before.set(name, handler),
      on: (name: string, handler: Handler) => on.set(name, [...(on.get(name) ?? []), handler]),
      handle: (contract: { name: string }, handler: Handler) => rpcs.set(contract.name, handler),
    };
    tagSummaries = [];
    contribution = contributeKnowledge(server as never, {
      resolveRoot: async () => join(home, "plugin-data", "contextualise"),
      createTokenAuthority: (secret) => (authority = new TokenAuthority(secret)),
      settings: async () => {
        if (settingsProblem) throw settingsProblem;
        return values;
      },
      listTags: async () => tagSummaries as never,
    });
  });
  afterEach(async () => {
    for (const launch of launches) await closeLaunch(launch);
    launches.splice(0);
    await contribution.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(top, { recursive: true, force: true });
  });

  it("derives independent contributions again after a limited opening without saving a create hook", async () => {
    values = { ...values, historyTools: true };
    const original = JSON.stringify(values);
    const supported = await open(top);
    const limited = await open(top, {}, {}, { provider: "alias", openSupport: { ...supportFor(), mcpHttp: "unsupported", exactMcpPreapproval: "unknown", attachedTools: { delivery: "native", enabled: true, disabledTools: [] } } });
    const restored = await open(top);
    expect(before.has("agent.create")).toBe(false);
    expect(supported.mcpServers[KNOWLEDGE_SERVER]).toBeDefined();
    expect(limited.mcpServers).toEqual({});
    expect(limited.appendSystemPrompt?.join("\n")).toContain('- ARCHITECTURE.md "Overview"');
    expect(limited.appendSystemPrompt?.join("\n")).not.toContain("knowledge_search");
    expect(limited.tools.map((tool) => tool.name)).toContain("history_search");
    expect(limited.toolPolicy).toBeUndefined();
    expect(restored.mcpServers[KNOWLEDGE_SERVER]).toBeDefined();
    expect(JSON.stringify(values)).toBe(original);
  });

  it("does not read eager workspace summaries when attached delivery is unavailable", async () => {
    values = { ...values, historyTools: true, workspaceSummaries: true };
    agentsDown = true;
    try {
      const opened = await open(top, {}, {}, { openSupport: { ...supportFor(), attachedTools: { delivery: "unknown", enabled: true, disabledTools: [] } } });
      expect(opened.tools).toEqual([]);
      expect(opened.appendSystemPrompt?.join("\n")).not.toMatch(/workspace_history_|history_search|could not list this workspace/);
    } finally {
      agentsDown = false;
    }
  });

  it("suppresses an occupied knowledge group before minting while retaining independent attached tools", async () => {
    values = { ...values, historyTools: true };
    const mint = vi.spyOn(TokenAuthority.prototype, "mint");
    try {
      const saved = { type: "http", url: "http://caller.invalid" };
      const baseConfig = { provider: "claude", cwd: top, systemPrompt: "Caller text", mcpServers: { [KNOWLEDGE_SERVER]: saved } };
      const opened = await open(top, baseConfig);
      expect(opened.mcpServers).toEqual({});
      expect(opened.toolPolicy).toBeUndefined();
      expect(opened.appendSystemPrompt?.join("\n")).not.toContain("knowledge_search");
      expect(opened.tools.map((tool) => tool.name)).toContain("history_search");
      expect(baseConfig.mcpServers[KNOWLEDGE_SERVER]).toBe(saved);
      expect(baseConfig.systemPrompt).toBe("Caller text");
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });

  it("preserves an empty knowledge binding when Off stays Off on a fixed opening", async () => {
    values = { ...values, knowledgeEnabled: false, historyTools: true };
    const mint = vi.spyOn(TokenAuthority.prototype, "mint");
    try {
      const first = await open(top);
      const previous = launches[0].snapshot!;
      const saved = JSON.stringify(previous);
      const fixed = await open(top, {}, {}, { reason: "refresh", previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } });
      expect(first.mcpServers).toEqual({});
      expect(fixed.mcpServers).toEqual({});
      expect(fixed.toolPolicy).toBeUndefined();
      expect(fixed.appendSystemPrompt?.join("\n")).not.toContain("Project knowledge");
      expect(fixed.appendSystemPrompt?.join("\n")).toContain("## Chat history");
      expect(fixed.tools.map((tool) => tool.name)).toContain("history_search");
      expect(JSON.stringify(previous)).toBe(saved);
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });

  it("preserves an empty knowledge binding after unsupported HTTP on a fixed opening", async () => {
    values = { ...values, historyTools: true };
    const mint = vi.spyOn(TokenAuthority.prototype, "mint");
    try {
      const first = await open(top, {}, {}, { openSupport: { ...supportFor(), mcpHttp: "unsupported" } });
      const previous = launches[0].snapshot!;
      const saved = JSON.stringify(previous);
      const fixed = await open(top, {}, {}, { reason: "refresh", previousContribution: previous, openSupport: { ...supportFor(), mcpHttp: "unsupported", restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } });
      expect(first.mcpServers).toEqual({});
      expect(fixed.mcpServers).toEqual({});
      expect(fixed.toolPolicy).toBeUndefined();
      expect(fixed.appendSystemPrompt?.join("\n")).toContain('- ARCHITECTURE.md "Overview"');
      expect(fixed.appendSystemPrompt?.join("\n")).not.toContain("knowledge_search");
      expect(fixed.tools.map((tool) => tool.name)).toContain("history_search");
      expect(JSON.stringify(previous)).toBe(saved);
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });

  it("suppresses a caller-owned saved knowledge binding before allocation on a fixed opening", async () => {
    values = { ...values, historyTools: true };
    const mint = vi.spyOn(TokenAuthority.prototype, "mint");
    try {
      const baseConfig = { provider: "claude", cwd: top, systemPrompt: "Caller text", mcpServers: { [KNOWLEDGE_SERVER]: { type: "http", url: "http://caller.invalid" } }, toolPolicy: { preapproved: [{ kind: "mcp", server: KNOWLEDGE_SERVER, tool: "conversation_read" }] } };
      const saved = JSON.stringify(baseConfig);
      await open(top, baseConfig);
      const previous = launches[0].snapshot!;
      const fixed = await open(top, baseConfig, {}, { reason: "refresh", previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } });
      expect(fixed.mcpServers).toEqual({});
      expect(fixed.toolPolicy).toBeUndefined();
      expect(fixed.providerOptions).toBeUndefined();
      expect(fixed.env).toEqual({});
      expect(fixed.appendSystemPrompt?.join("\n")).not.toContain("knowledge_search");
      expect(fixed.appendSystemPrompt?.join("\n")).not.toContain("Project knowledge");
      expect(fixed.tools.map((tool) => tool.name)).toContain("history_search");
      expect(JSON.stringify(baseConfig)).toBe(saved);
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });

  it("derives instruction-only context without a prior knowledge contribution on a fixed opening", async () => {
    values = { ...values, historyTools: true };
    const mint = vi.spyOn(TokenAuthority.prototype, "mint");
    try {
      const fixed = await open(top, {}, {}, { reason: "refresh", openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } });
      expect(fixed.mcpServers).toEqual({});
      expect(fixed.toolPolicy).toBeUndefined();
      expect(fixed.appendSystemPrompt?.join("\n")).toContain('- ARCHITECTURE.md "Overview"');
      expect(fixed.appendSystemPrompt?.join("\n")).not.toContain("knowledge_search");
      expect(fixed.tools.map((tool) => tool.name)).toContain("history_search");
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });

  it("reuses the exact knowledge binding and holds its original lifetime through replacement", async () => {
    values = { ...values, historyTools: true };
    const mint = vi.spyOn(TokenAuthority.prototype, "mintForLaunch");
    try {
      const first = await open(top, {}, { CALLER_ONLY: "not-a-plugin-secret" }, { workspaceId: "w-top" });
      const original = launches[0];
      const previous = original.snapshot!;
      writeFileSync(join(top, "ARCHITECTURE.md"), "# Overview\nUpdated daemon.\n");
      const second = await open(top, {}, {}, { workspaceId: "w-top", reason: "refresh", previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } });
      const replacement = launches[1];
      const authorization = knowledgeAuthorization(first);
      expect(second.mcpServers).toEqual(first.mcpServers);
      expect(second.toolPolicy).toEqual(first.toolPolicy);
      expect(second.env).toEqual({});
      expect(second.appendSystemPrompt?.join("\n").split("## Project knowledge")).toHaveLength(2);
      expect(second.appendSystemPrompt?.join("\n").split("## Chat history")).toHaveLength(2);
      expect(second.tools.map((tool) => tool.name)).toContain("history_search");
      expect(mint).toHaveBeenCalledTimes(1);
      await closeLaunch(original);
      expect(original.controller.signal.aborted).toBe(false);
      expect(authority.verify(authorization)).not.toBeNull();
      await closeLaunch(replacement);
      expect(original.controller.signal.aborted).toBe(true);
      expect(authority.verify(authorization)).toBeNull();
    } finally {
      mint.mockRestore();
    }
  });

  it("rejects fixed knowledge reuse after settings change without allocating another credential", async () => {
    const mint = vi.spyOn(TokenAuthority.prototype, "mintForLaunch");
    try {
      await open(top);
      const previous = launches[0].snapshot!;
      values = { ...values, knowledgeAutoApproveTools: false };
      await expect(open(top, {}, {}, { previousContribution: previous, reason: "refresh", openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } })).rejects.toThrow(/Full close and reopen/);
      expect(mint).toHaveBeenCalledTimes(1);
      expect(launches[0].controller.signal.aborted).toBe(false);
    } finally {
      mint.mockRestore();
    }
  });

  it("keeps the installed credential when a retained provisional replacement fails", async () => {
    const mint = vi.spyOn(TokenAuthority.prototype, "mintForLaunch");
    try {
      const first = await open(top);
      const original = launches[0];
      await open(top, {}, {}, { previousContribution: original.snapshot!, reason: "refresh", openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } }, false);
      await closeLaunch(launches[1]);
      const authorization = knowledgeAuthorization(first);
      expect(original.controller.signal.aborted).toBe(false);
      expect(authority.verify(authorization)).not.toBeNull();
      expect(mint).toHaveBeenCalledTimes(1);
    } finally {
      mint.mockRestore();
    }
  });

  it("does not retain a credential from a launch that never installed", async () => {
    await open(top, {}, {}, {}, false);
    await expect(open(top, {}, {}, { previousContribution: launches[0].snapshot!, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } })).rejects.toThrow(/retained snapshot/);
  });

  it("rejects fixed knowledge reuse while Off instead of silently omitting its binding", async () => {
    const first = await open(top);
    const previous = launches[0].snapshot!;
    const saved = JSON.stringify(previous);
    values = { ...values, knowledgeEnabled: false };
    const mint = vi.spyOn(TokenAuthority.prototype, "mint");
    try {
      await expect(open(top, {}, {}, { previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } })).rejects.toThrow(/Full close and reopen/);
      expect(JSON.stringify(previous)).toBe(saved);
      expect(launches[0].controller.signal.aborted).toBe(false);
      expect(authority.verify(knowledgeAuthorization(first))).not.toBeNull();
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });

  it("rejects fixed knowledge reuse for another workspace without widening its token scope", async () => {
    await open(top, {}, {}, { workspaceId: "w-top" });
    const previous = launches[0].snapshot!;
    await expect(open(top, {}, {}, { workspaceId: "w-other", previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } })).rejects.toThrow(/workspace scope.*incompatible/);
  });

  it("rejects an unknown prior launch even when its endpoint name matches", async () => {
    await open(top);
    const previous = { ...launches[0].snapshot!, launchId: "another-plugin-instance" };
    await expect(open(top, {}, {}, { previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } })).rejects.toThrow(/retained snapshot/);
  });

  it("rejects changed prior grants instead of adopting a foreign exact approval", async () => {
    await open(top);
    const previous = { ...launches[0].snapshot!, toolPolicy: { preapproved: [{ kind: "mcp" as const, server: KNOWLEDGE_SERVER, tool: "conversation_read" }] } };
    await expect(open(top, {}, {}, { previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } })).rejects.toThrow(/Full close and reopen/);
  });

  it("rejects fixed reuse after the prior credential lifetime has been disposed", async () => {
    await open(top);
    const previous = launches[0].snapshot!;
    await closeLaunch(launches[0]);
    await expect(open(top, {}, {}, { previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } })).rejects.toThrow(/retained snapshot/);
  });

  it("rejects fixed reuse when chat visibility changes", async () => {
    await open(top);
    const previous = launches[0].snapshot!;
    await expect(open(top, {}, {}, { background: true, previousContribution: previous, openSupport: { ...supportFor(), restrictions: { mcpConfiguration: "fixed", processEnvironment: "fixed" } } })).rejects.toThrow(/Full close and reopen/);
  });

  it("gives an agent in a git repository the project map and the knowledge tools, keeping everything else", async () => {
    const { config } = await create(top, { systemPrompt: "Be brief.", mcpServers: { "paseo-memorise": { type: "http", url: "x" } } });
    expect(config.systemPrompt).toMatch(/^Be brief\.\n\n<!-- contextualise:knowledge -->/);
    expect(config.systemPrompt).toContain('- ARCHITECTURE.md "Overview"');
    expect(Object.keys(config.mcpServers).sort()).toEqual([KNOWLEDGE_SERVER, "paseo-memorise"]);
  });

  it("keeps exact approvals optional when HTTP works but approval support is unknown", async () => {
    const opened = await open(top, {}, {}, { openSupport: { ...supportFor(), exactMcpPreapproval: "unknown" } });
    expect(opened.mcpServers[KNOWLEDGE_SERVER]).toBeDefined();
    expect(opened.toolPolicy).toBeUndefined();
    await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "p1", name: `mcp__${KNOWLEDGE_SERVER}__knowledge_search` } });
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("uses host workspace and actual agent scope across resume and refresh", async () => {
    const first = await open(top, {}, {}, { agentId: "owner", workspaceId: "w-top" });
    const again = await open(top, {}, {}, { agentId: "owner", workspaceId: "w-top", reason: "resume" });
    const outsider = await open(top, {}, {}, { agentId: "outsider", workspaceId: "w-other", reason: "refresh" });
    const scope = (opened: PluginSessionOpenRequest) => {
      return JSON.parse(Buffer.from(knowledgeAuthorization(opened).split(" ")[1].split(".")[0], "base64url").toString("utf8"));
    };
    expect(scope(first)).toMatchObject({ agent: "owner", workspace: "w-top" });
    expect(scope(again)).toMatchObject({ agent: "owner", workspace: "w-top" });
    expect(scope(again).launch).not.toBe(scope(first).launch);
    expect(scope(outsider)).toMatchObject({ agent: "outsider", workspace: "w-other" });
  });

  it("preserves saved knowledge text while deriving a free endpoint", async () => {
    const text = `Caller prefix\n${SECTION_START}\nSaved guidance\n${SECTION_END}\nCaller suffix`;
    const opened = await open(top, { systemPrompt: text });
    expect(opened.baseConfig?.systemPrompt).toBe(text);
    expect(opened.appendSystemPrompt).toBeUndefined();
    expect(opened.mcpServers[KNOWLEDGE_SERVER]).toBeDefined();
  });

  it("limits absent support without admitting tools by actual provider name", async () => {
    values = { ...values, historyTools: true };
    const opened = await open(top, {}, {}, { openSupport: undefined });
    expect(opened.mcpServers).toEqual({});
    expect(opened.tools).toEqual([]);
    expect(opened.providerOptions).toBeUndefined();
    expect(opened.appendSystemPrompt).toBeUndefined();
  });

  it("keeps HTTP and native attached tools when instruction delivery is unavailable", async () => {
    values = { ...values, historyTools: true };
    const opened = await open(top, {}, {}, { reason: "import", openSupport: { ...supportFor(), instructions: "unsupported", attachedTools: { delivery: "native", enabled: true, disabledTools: [] } } });
    expect(opened.mcpServers[KNOWLEDGE_SERVER]).toBeDefined();
    expect(opened.tools.map((tool) => tool.name)).toContain("history_search");
    expect(opened.appendSystemPrompt).toBeUndefined();
  });

  it("keeps independent knowledge when saved history guidance is ambiguous", async () => {
    values = { ...values, historyTools: true };
    const opened = await open(top, {}, {}, { legacyConfigState: { selectors: { "knowledge-prompt": "absent", "history-prompt": "ambiguous", "workspace-prompt": "present" } } });
    expect(opened.mcpServers[KNOWLEDGE_SERVER]).toBeDefined();
    expect(opened.tools.map((tool) => tool.name)).toContain("history_search");
    expect(opened.appendSystemPrompt?.join("\n")).toContain("Project knowledge");
    expect(opened.appendSystemPrompt?.join("\n")).not.toContain("## Chat history");
    expect(opened.appendSystemPrompt?.join("\n")).not.toContain("Workspace chat context");
  });

  it("preserves an occupied binding and required policy while knowledge is Off", async () => {
    values = { ...values, knowledgeEnabled: false };
    const required = { provider: "claude", cwd: top, mcpServers: { [KNOWLEDGE_SERVER]: { type: "http", url: "http://caller.invalid" } }, toolPolicy: { preapproved: [{ kind: "mcp", server: KNOWLEDGE_SERVER, tool: "conversation_read" }] } };
    const original = JSON.stringify(required);
    const opened = await open(top, required);
    expect(opened.mcpServers).toEqual({});
    expect(opened.toolPolicy).toBeUndefined();
    expect(opened.appendSystemPrompt).toBeUndefined();
    expect(JSON.stringify(required)).toBe(original);
  });

  it("revokes a failed launch credential without revoking a concurrent opening", async () => {
    const mint = vi.spyOn(TokenAuthority.prototype, "mintForLaunch");
    try {
      const first = await open(top);
      const second = await open(top, {}, {}, { agentId: "outsider" });
      expect(authority.verify(knowledgeAuthorization(first))).not.toBeNull();
      await closeLaunch(launches[0]);
      expect(authority.verify(knowledgeAuthorization(first))).toBeNull();
      expect(authority.verify(knowledgeAuthorization(second))).toMatchObject({ agent: "outsider" });
    } finally {
      mint.mockRestore();
    }
  });

  it("allocates no per-open credentials for history inspection or cancellation", async () => {
    const mint = vi.spyOn(TokenAuthority.prototype, "mint");
    try {
      const inspected = await open(top, {}, {}, { purpose: "history" });
      expect(inspected.mcpServers).toEqual({});
      expect(inspected.tools).toEqual([]);
      const controller = new AbortController();
      controller.abort();
      const handler = before.get("agent.open.before") as (input: unknown, context: unknown) => Promise<unknown>;
      await expect(handler({ request: { agentId: "cancelled", provider: "claude", cwd: top, purpose: "interactive" } }, { paseo, launch: { id: "cancelled", signal: controller.signal, onDispose: () => {} } })).rejects.toThrow();
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });

  it("counts each agent given the knowledge tools, and answers the project's use over the last 7 days", async () => {
    await create(top);
    await create(top);
    const call = (name: string, input: unknown) => (rpcs.get(name) as (input: unknown, context: unknown) => Promise<unknown>)(input, { paseo });
    const { projects } = (await call("knowledge.projects", {})) as { projects: { repoKey: string }[] };
    expect(await call("knowledge.usage", { repoKey: projects[0].repoKey })).toMatchObject({ days: 7, agentsGiven: 2, agentsUsed: 0 });
  });

  it("lists documents by file, reads one file's sections in order, and picks the README's first prose as its intro", async () => {
    writeFileSync(join(top, "README.md"), '<img src="logo.png" alt="Api logo">\n\n# Api\n\nThe api serves orders to the shop front.\n\n## Install\n\nRun it.\n');
    execFileSync("git", ["-C", top, "add", "-A"]);
    await create(top);
    const { projects } = (await call("knowledge.projects", {})) as { projects: { repoKey: string }[] };
    const repoKey = projects[0].repoKey;
    expect(await call("knowledge.files", { repoKey, kind: "doc" })).toEqual({ total: 1, files: [{ path: "README.md", count: 3 }] });
    const { hits } = (await call("knowledge.file-entries", { repoKey, path: "README.md", kind: "doc" })) as { hits: { title: string; line: number }[] };
    expect(hits.map((hit) => [hit.line, hit.title])).toEqual([[1, "README.md"], [3, "Api"], [7, "Api > Install"]]);
    expect(await call("knowledge.intro", { repoKey })).toEqual({ intro: { id: "doc:README.md:3", title: "Api" } });
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

  it("preserves unadopted parent configuration without adding a second copy", async () => {
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

  it("never answers external knowledge permission events and supplies exact optional grants instead", async () => {
    const opened = await open(top);
    await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "p1", name: `mcp__${KNOWLEDGE_SERVER}__knowledge_search` } });
    await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "p2", name: "Bash" } });
    expect(respondToPermission).not.toHaveBeenCalled();
    expect(opened.toolPolicy?.preapproved).toContainEqual({ kind: "mcp", server: KNOWLEDGE_SERVER, tool: "knowledge_search" });
    expect(opened.toolPolicy?.preapproved.some((grant) => grant.server === "paseo" || grant.tool === "conversation_read" || grant.tool === "project_attach")).toBe(false);
  });

  it("never answers knowledge or conversation events by server or tool name", async () => {
    const ask = (id: string, request: Record<string, unknown>) => emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id, ...request } });
    await ask("p1", { name: `mcp__${KNOWLEDGE_SERVER}__x__write_file` });
    await ask("p2", { name: `mcp__${KNOWLEDGE_SERVER}__delete_everything` });
    await ask("p3", { name: "CodexMcpElicitation", metadata: { serverName: KNOWLEDGE_SERVER }, description: 'Allow the paseo-contextualise MCP server to run tool "drop_table"?' });
    await ask("p4", { name: "CodexMcpElicitation", metadata: { serverName: KNOWLEDGE_SERVER }, description: 'Allow the paseo-contextualise MCP server to run tool "knowledge_read"?' });
    await ask("p5", { name: `mcp__${KNOWLEDGE_SERVER}__knowledge_history` });
    await ask("p6", { name: `mcp__${KNOWLEDGE_SERVER}__knowledge_impact` });
    // Reading another agent's conversation is left to M every time.
    await ask("p7", { name: `mcp__${KNOWLEDGE_SERVER}__conversation_read` });
    expect(respondToPermission).not.toHaveBeenCalled();
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
    // With a chat in the project, the row leads with when it was last active, as Attach > Chat does.
    agentEntries.push({ agent: { id: "a-recent", workspaceId: "w-top", cwd: top, provider: "claude", updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() } });
    try {
      expect((await attach(""))!.items[0].subtitle).toMatch(/^3h · 1 document · about \d+ tokens · /);
      // "Show when it was last used" off: no age, as in Attach > Chat.
      values = { ...values, agentShowActivity: false };
      expect((await attach(""))!.items[0].subtitle).toMatch(/^1 document · about \d+ tokens · /);
    } finally {
      agentEntries.splice(agentEntries.findIndex((entry) => entry.agent.id === "a-recent"), 1);
    }
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
      // Linked projects and chat history are not knowledge, so they keep working while it is off.
      if (name === "knowledge.attach-search" || name === "knowledge.memorise-status" || name.startsWith("links.") || name.startsWith("history.")) continue;
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

  describe("summaries of the workspace's other chats", () => {
    const createWith = (config: Record<string, unknown>, env?: Record<string, string>) => create(top, config, env);
    const summary = (goal: string, updatedAt: string) => ({ summary: { goal, done: [], decisions: [], open: [], facts: [] }, anchor: { units: 2, tail: "x" }, messages: 2, coveredTo: "2026-11-11T09:00:00.000Z", updatedAt, complete: true });
    beforeEach(() => {
      values = { ...values, workspaceSummaries: true };
      const root = join(home, "plugin-data", "contextualise");
      workspaceEntries.push({ id: "w-bg", workspaceDirectory: join(home, "bg"), background: true });
      agentEntries.push(
        { agent: { id: "a-old", workspaceId: "w-top", cwd: top, provider: "claude", title: "Old work", updatedAt: "2026-11-11T08:00:00.000Z", status: "idle" } },
        { agent: { id: "a-new", workspaceId: "w-top", cwd: top, provider: "codex", title: "New work", updatedAt: "2026-11-11T11:00:00.000Z", status: "running" } },
        { agent: { id: "a-archived", workspaceId: "w-top", cwd: top, provider: "claude", title: "Archived", updatedAt: "2026-11-11T11:30:00.000Z", archivedAt: "2026-11-11T11:31:00.000Z" } },
        { agent: { id: "a-internal", workspaceId: "w-top", cwd: top, provider: "claude", title: "Helper", updatedAt: "2026-11-11T11:30:00.000Z", internal: true } },
        { agent: { id: "a-worker", workspaceId: "w-top", cwd: join(root, "workers", "x"), provider: "claude", title: "contextualise: summarise chat a-old", updatedAt: "2026-11-11T11:30:00.000Z" } },
        { agent: { id: "a-bg", workspaceId: "w-bg", cwd: join(home, "bg"), provider: "claude", title: "Background", updatedAt: "2026-11-11T11:30:00.000Z" } },
        { agent: { id: "a-elsewhere", workspaceId: "w-other", cwd: "/elsewhere", provider: "claude", title: "Other workspace", updatedAt: "2026-11-11T11:30:00.000Z" } },
      );
      mkdirSync(join(root, "knowledge"), { recursive: true });
      writeFileSync(join(root, "knowledge", "chat-summaries.json"), JSON.stringify({ version: 1, chats: { "a-old": summary("Ship the import", "2026-11-11T09:05:00.000Z"), "a-new": summary("Write the docs", "2026-11-11T10:00:00.000Z") } }));
    });
    afterEach(() => {
      agentEntries.splice(0);
    });

    it("gives a new chat every other chat of its workspace, newest first, with its summary, and none of the others", async () => {
      const prompt = (await createWith({ systemPrompt: "Be brief." })).config.systemPrompt!;
      expect(prompt).toContain("## Other chats in this workspace (Contextualise)");
      expect(prompt.indexOf('"New work"')).toBeLessThan(prompt.indexOf('"Old work"'));
      expect(prompt).toContain("Goal: Ship the import");
      // Active after its summary was written: the entry says its newest messages are missing.
      expect(prompt).toContain("Summary of its first 2 messages, up to 2026-11-11 09:00 UTC; the chat was active after that");
      for (const left of ["Archived", "Helper", "summarise chat", "Background", "Other workspace"]) expect(prompt).not.toContain(left);
    });

    it("leaves out a chat whose history M turned off, and adds nothing while the setting is off", async () => {
      const stored = () => Object.keys(JSON.parse(readFileSync(join(home, "plugin-data", "contextualise", "knowledge", "chat-summaries.json"), "utf8")).chats);
      await call("history.command", { agentId: "a-old", action: "off" });
      expect(stored()).toEqual(["a-new"]);
      await emit("agent.archived", { agent: { id: "a-new" }, archivedAt: "2026-11-11T12:00:00.000Z" });
      expect(stored()).toEqual([]);
      const prompt = (await createWith({})).config.systemPrompt!;
      expect(prompt).toContain('"New work"');
      expect(prompt).not.toContain('"Old work"');
      values = { ...values, workspaceSummaries: false };
      expect((await createWith({})).config.systemPrompt ?? "").not.toContain("Other chats in this workspace");
    });

    it("still creates the chat when Paseo cannot list chats, saying why, and keeps one section in a fork", async () => {
      agentsDown = true;
      try {
        expect((await createWith({})).config.systemPrompt).toContain("Contextualise could not list this workspace's other chats: daemon busy");
      } finally {
        agentsDown = false;
      }
      const first = (await createWith({ systemPrompt: "Be brief." })).config.systemPrompt!;
      const fork = (await createWith({ systemPrompt: first })).config.systemPrompt!;
      expect(fork.split("## Other chats in this workspace").length).toBe(2);
    });

    it("lets a chat search its workspace's other chats word for word, never approving it, and never its own or a worker's", async () => {
      type Tool = { name: string; execute(input: unknown, context: unknown): Promise<{ text: string; isError?: boolean }> };
      values = { ...values, historyTools: true };
      const agents = paseo.agents as Record<string, unknown>;
      const original = agents.ref;
      agents.ref = (agentId: string) => ({
        respondToPermission,
        timeline: { refetch: async () => ({ epoch: "e1", reset: false, entries: [{ item: { type: "user_message", text: `the list import in ${agentId}` }, timestamp: "2026-11-11T09:00:00.000Z", seqStart: 1 }], hasOlder: false, hasNewer: false, startCursor: null, endCursor: null, error: null }) },
      });
      try {
        const opened = await open(top, {}, {}, { agentId: "a-new", workspaceId: "w-top" }) as unknown as { tools: Tool[] };
        expect(opened.tools.map((entry) => entry.name).filter((name) => name.startsWith("workspace_history_"))).toEqual(["workspace_history_chats", "workspace_history_search", "workspace_history_load", "workspace_history_read"]);
        const found = (await opened.tools.find((entry) => entry.name === "workspace_history_search")!.execute({ query: "list import" }, { agent: { id: "a-new", workspaceId: "w-top" }, paseo })).text;
        expect(found).toContain("Quoted from M's other chats in this workspace.");
        // Archived chats are searched; the caller, workers, helpers and other workspaces are not.
        expect(found).toContain("the list import in a-old");
        expect(found).toContain("the list import in a-archived");
        for (const left of ["a-new", "a-worker", "a-internal", "a-bg", "a-elsewhere"]) expect(found).not.toContain(`the list import in ${left}`);
        respondToPermission.mockClear();
        await emit("agent.permission_requested", { agent: { id: "a-new", cwd: top }, request: { id: "p-ws", name: "mcp__paseo__workspace_history_search" } });
        expect(respondToPermission).not.toHaveBeenCalled();
      } finally {
        agents.ref = original;
      }
    });

    it("creates the chat within the listing deadline when Paseo is slow, saying why", async () => {
      const agents = paseo.agents as Record<string, unknown>;
      const original = agents.list;
      agents.list = () => new Promise(() => undefined);
      try {
        const started = Date.now();
        expect((await createWith({})).config.systemPrompt).toContain("Contextualise could not list this workspace's other chats: Paseo took longer than 5 seconds to list them.");
        expect(Date.now() - started).toBeLessThan(8_000);
      } finally {
        agents.list = original;
      }
    }, 10_000);

    it("says so when it cannot tell the chat's workspace because the lookup failed", async () => {
      const workspaces = paseo.workspaces as Record<string, unknown>;
      const original = workspaces.list;
      workspaces.list = async () => {
        throw new Error("daemon restarting");
      };
      try {
        expect((await createWith({})).config.systemPrompt).toContain("Contextualise could not list this workspace's other chats: daemon restarting");
      } finally {
        workspaces.list = original;
      }
    });

    it("gives a chat in a shared folder the summaries on its first attachment_updates call, for its own workspace only", async () => {
      type Tool = { name: string; execute(input: unknown, context: unknown): Promise<{ text: string; isError?: boolean }> };
      values = { ...values, historyTools: true };
      workspaceEntries.push({ id: "w-twin", workspaceDirectory: top });
      const note = (await createWith({})).config.systemPrompt!;
      expect(note).toContain("workspace_history_chats");
      expect(note).not.toContain('"New work"');
      const agents = paseo.agents as Record<string, unknown>;
      const original = agents.ref;
      agents.ref = () => ({ respondToPermission, refresh: async () => {}, current: () => ({ createdAt: "2026-11-11T11:50:00.000Z" }), timeline: { refetch: async () => ({ epoch: "e1", reset: false, entries: [], hasOlder: false, hasNewer: false, startCursor: null, endCursor: null, error: null }) } });
      try {
        const opened = await open(top, {}, {}, { agentId: "a-new", workspaceId: "w-top" }) as unknown as { tools: Tool[] };
        const updates = opened.tools.find((entry) => entry.name === "attachment_updates")!;
        // The caller is a-new: it is left out; the other chat of its workspace is given with its summary.
        const grant = (await contribution.attachmentGrant({ kind: "tag", key: "auth", upTo: "2026-11-11T11:00:00.000Z" }))!.split(" ").at(-1)!;
        const given = (await updates.execute({ workspaceChats: true, grants: [grant] }, { agent: { id: "a-new", workspaceId: "w-top" }, paseo })).text;
        const delivery = JSON.parse(readFileSync(join(home, "plugin-data", "contextualise", "knowledge", "attachment-seen.json"), "utf8")).chats["a-new"];
        expect(delivery.grants).toEqual([grant]);
        expect(delivery.seen).toEqual({});
        expect(given).toContain("## Other chats in this workspace (Contextualise)");
        expect(given).toContain('"Old work"');
        expect(given).toContain("Goal: Ship the import");
        expect(given).not.toContain('"New work"');
        for (const left of ["Archived", "Helper", "summarise chat", "Background", "Other workspace"]) expect(given).not.toContain(left);
        expect(given).not.toContain("<!-- contextualise:workspace-chats -->");
        expect(given).toContain("attachment_updates");
        // Asked again: each chat is given once.
        expect((await updates.execute({ workspaceChats: true }, { agent: { id: "a-new", workspaceId: "w-top" }, paseo })).text).toContain("were already given to this chat");
        // No workspace in Paseo's context: nothing to give.
        expect((await updates.execute({ workspaceChats: true }, { agent: { id: "a-new", workspaceId: null }, paseo })).text).toContain("Paseo has no workspace for this chat");
        // Without the flag, only the updates.
        expect((await updates.execute({}, { agent: { id: "a-new", workspaceId: "w-top" }, paseo })).text).not.toContain("Other chats in this workspace");
        // With the summaries off, it says so.
        values = { ...values, workspaceSummaries: false };
        expect((await updates.execute({ workspaceChats: true }, { agent: { id: "a-new", workspaceId: "w-top" }, paseo })).text).toContain("Summaries of the workspace's other chats are off");
      } finally {
        agents.ref = original;
      }
    });

    it("follows an attached tag in attachment_updates only while tags are on", async () => {
      type Tool = { name: string; execute(input: unknown, context: unknown): Promise<{ text: string; isError?: boolean }> };
      values = { ...values, historyTools: true, workspaceSummaries: false };
      tagSummaries = [{ key: "auth", name: "auth", hasWorkspaceLabel: false, workspaces: [], agents: [], links: [], notes: [] }];
      const agents = paseo.agents as Record<string, unknown>;
      const original = agents.ref;
      agents.ref = () => ({ respondToPermission, refresh: async () => {}, current: () => ({ createdAt: "2026-11-11T11:50:00.000Z" }) });
      try {
        const opened = await open(top, {}, {}, { agentId: "a-new", workspaceId: "w-top" }) as unknown as { tools: Tool[] };
        const updates = opened.tools.find((entry) => entry.name === "attachment_updates")!;
        // A grant is redeemed once, so each ask gets its own.
        const ask = async (agentId: string) => {
          const grant = (await contribution.attachmentGrant({ kind: "tag", key: "auth", upTo: "2026-11-11T11:00:00.000Z" }))!.split(" ").at(-1)!;
          return (await updates.execute({ grants: [grant] }, { agent: { id: agentId, workspaceId: "w-top" }, paseo })).text;
        };
        expect(await ask("a-on")).toContain("Nothing new in this chat's 1 attachment since you last asked.");
        values = { ...values, tagsEnabled: false };
        expect(await ask("a-off")).toContain("Nothing new in this chat's 0 attachments since you last asked.");
      } finally {
        agents.ref = original;
      }
    });

    it("says why in a folder several workspaces share, and gives the summaries to a chat started with New Chat there", async () => {
      workspaceEntries.push({ id: "w-twin", workspaceDirectory: top });
      const shared = (await createWith({})).config.systemPrompt!;
      expect(shared).toContain("This chat's folder is shared by several Paseo workspaces");
      expect(shared).not.toContain('"New work"');
      const marked = (await createWith({}, { CONTEXTUALISE_LINK_WORKSPACE: "w-top" })).config.systemPrompt!;
      expect(marked).toContain('"New work"');
    });
  });

  describe("chat history", () => {
    type Tool = { name: string; execute(input: unknown, context: unknown): Promise<{ text: string; isError?: boolean }> };
    const appended: { agentId: string; row: { id: string; kind: string; data: { title: string; lines: string[] } } }[] = [];
    let items: Record<string, unknown>[];
    let epoch: string;
    let originalRef: unknown;
    // A chat's projected timeline, paged like Paseo's refetch.
    const page = ({ direction, cursor, limit }: { direction: string; cursor?: { seq: number; epoch: string }; limit: number }) => {
      const rows = items.map((item, index) => ({ item, timestamp: "2026-11-08T05:00:00.000Z", seqStart: index + 1 }));
      const stale = cursor !== undefined && cursor.epoch !== epoch;
      const selected = direction === "after" && !stale ? rows.filter((row) => row.seqStart > cursor!.seq).slice(0, limit) : direction === "before" && !stale ? rows.filter((row) => row.seqStart < cursor!.seq).slice(-limit) : rows.slice(-limit);
      const first = selected[0]?.seqStart ?? 0;
      const last = selected.at(-1)?.seqStart ?? 0;
      return { epoch, reset: stale, entries: selected, hasOlder: first > 1, hasNewer: last < rows.length, startCursor: selected.length ? { epoch, seq: first } : null, endCursor: selected.length ? { epoch, seq: last } : null, error: null };
    };
    beforeEach(() => {
      values = { ...values, historyTools: true };
      items = [{ type: "user_message", text: "Run the tests" }, { type: "tool_call", name: "Bash", status: "failed", error: "exit 1", detail: { type: "shell", command: "npm test", output: "ECONNRESET at api.ts:12", exitCode: 1 } }, { type: "compaction", status: "completed", trigger: "auto", preTokens: 150_000 }, { type: "user_message", text: "Now fix it" }];
      epoch = "e1";
      appended.length = 0;
      const agents = paseo.agents as Record<string, unknown>;
      originalRef = agents.ref;
      agents.ref = (agentId: string) => ({ respondToPermission, refresh: async () => {}, lastUsage: { contextWindowUsedTokens: 50_000, contextWindowMaxTokens: 200_000 }, timeline: { refetch: async (options: Parameters<typeof page>[0]) => page(options), append: async (row: (typeof appended)[number]["row"]) => void appended.push({ agentId, row }) } });
    });
    afterEach(() => {
      (paseo.agents as Record<string, unknown>).ref = originalRef;
    });
    const toolsOf = async () => (await open(top, {}, {}, { workspaceId: "w-top" })).tools as unknown as Tool[];
    const tool = async (name: string) => (await toolsOf()).find((entry) => entry.name === name)!;
    const asChat = { agent: { id: "a1", workspaceId: "w1" }, paseo };

    it("gives every chat the four history tools, reading its own history word for word, and none while the setting is off", async () => {
      expect((await toolsOf()).map((entry) => entry.name).filter((name) => name.startsWith("history_"))).toEqual(["history_search", "history_browse", "history_load", "history_read"]);
      const found = await (await tool("history_search")).execute({ query: "econnreset", load: true }, asChat);
      expect(found.text).toContain("2@e1 · tool Bash, failed");
      expect(found.text).toContain("ECONNRESET at api.ts:12");
      expect((await (await tool("history_load")).execute({ ids: ["1@e1"] }, asChat)).text).toContain("You: Run the tests");
      expect((await (await tool("history_search")).execute({}, { agent: { id: null }, paseo })).isError).toBe(true);
      values = { ...values, historyTools: false };
      expect((await toolsOf()).some((entry) => entry.name.startsWith("history_"))).toBe(false);
    });

    it("gives fixed workspace retrieval guidance without eager summaries or inventory reads", async () => {
      values = { ...values, workspaceSummaries: true };
      agentsDown = true;
      const made = await create(top);
      agentsDown = false;
      expect(made.config.systemPrompt).toContain("workspace_history_chats");
      expect(made.config.systemPrompt).not.toContain("could not list this workspace's other chats");
      expect(made.config.systemPrompt).not.toContain("No summary yet");
    });

    it("leaves this plugin's worker tools and instructions untouched", async () => {
      const cwd = join(home, "plugin-data", "contextualise", "workers");
      const made = await create(cwd, { systemPrompt: "Worker task only" });
      expect(made.config.systemPrompt).toBe("Worker task only");
      const inherited = { name: "vendor_read" };
      const opened = await open(cwd, {}, {}, { agentId: "worker", tools: [inherited] as never });
      expect(opened.tools).toEqual([inherited]);
    });

    it("tells a chat about delivered history without adding internal-server policy grants", async () => {
      const made = (await create(top, { systemPrompt: "Be brief." })).config;
      expect(made.systemPrompt).toContain("Be brief.");
      expect(made.systemPrompt).toContain("If the `history_search` tool is available");
      expect(made.toolPolicy?.preapproved.every((grant) => grant.server === KNOWLEDGE_SERVER)).toBe(true);
      // Unadopted saved guidance is preserved, not replaced or repeated.
      const again = (await create(top, { systemPrompt: made.systemPrompt })).config;
      expect(again.systemPrompt?.split("## Chat history (Contextualise)").length).toBe(2);
    });

    it("leaves attached history permission events to ordinary provider prompts", async () => {
      respondToPermission.mockClear();
      await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "h1", name: "mcp__paseo__history_search" } });
      await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "h2", name: "mcp__paseo__spawn_agent" } });
      expect(respondToPermission).not.toHaveBeenCalled();
    });

    it("adds one row for each compaction, however many turns end", async () => {
      await emit("agent.turn_ended", { agent: { id: "a1", provider: "claude", cwd: top, title: null }, outcome: { kind: "completed" } });
      expect(appended.map(({ row }) => row.id)).toEqual(["compaction-e1-3"]);
      expect(appended[0].row.data.title).toBe("Context compacted automatically (about 150,000 tokens before)");
      await emit("agent.turn_ended", { agent: { id: "a1", provider: "claude", cwd: top, title: null }, outcome: { kind: "completed" } });
      // After a restart Paseo rebuilds the timeline with new ids, and the compaction is still noted.
      epoch = "e2";
      await emit("agent.turn_ended", { agent: { id: "a1", provider: "claude", cwd: top, title: null }, outcome: { kind: "completed" } });
      expect(appended).toHaveLength(1);
      // A chat with its history tools off gets no rows.
      await call("history.command", { agentId: "a2", action: "off" });
      await emit("agent.turn_ended", { agent: { id: "a2", provider: "claude", cwd: top, title: null }, outcome: { kind: "completed" } });
      expect(appended.filter(({ agentId, row }) => agentId === "a2" && row.id.startsWith("compaction-"))).toEqual([]);
    });

    it("tells a chat what changed in an attached chat since it was attached, every turn, without asking M", async () => {
      const grantLine = (await contribution.conversationGrant("a2"))!;
      expect(grantLine).toContain("Contextualise attachment grant: ");
      const grant = grantLine.split("Contextualise attachment grant: ")[1].trim();
      // The attached chat gains a message after it was attached.
      const later = new Date(Date.now() + 60_000).toISOString();
      const agents = paseo.agents as Record<string, unknown>;
      agents.ref = (agentId: string) => ({
        respondToPermission,
        refresh: async () => {},
        current: () => ({ createdAt: "2026-11-08T00:00:00.000Z" }),
        timeline: { refetch: async () => ({ epoch: "e1", reset: false, entries: agentId === "a2" ? [{ item: { type: "user_message", text: "before the attachment" }, timestamp: "2026-11-08T05:00:00.000Z", seqStart: 1 }, { item: { type: "assistant_message", text: "Found the cause in api.ts" }, timestamp: later, seqStart: 2 }] : [], hasOlder: false, hasNewer: false, startCursor: null, endCursor: null, error: null }) },
      });
      const updates = await tool("attachment_updates");
      const first = (await updates.execute({ grants: [grant] }, asChat)).text;
      expect(first).toContain("agent: Found the cause in api.ts");
      expect(first).not.toContain("before the attachment");
      // Remembered: the next turn needs no grant, and has nothing new.
      expect((await updates.execute({}, asChat)).text).toContain("Nothing new in this chat's 1 attachment");
      expect((await updates.execute({ grants: [`${grant.slice(0, -2)}xx`] }, asChat)).text).toContain("1 grant refused");
      // Attached a second time: still followed once.
      const again = (await contribution.conversationGrant("a2"))!.split("Contextualise attachment grant: ")[1].trim();
      expect(again).not.toBe(grant);
      expect((await updates.execute({ grants: [again] }, asChat)).text).toContain("Nothing new in this chat's 1 attachment");
      // A conversation_read grant (older attachments carry only that) is not a feed of the chat's future.
      values = { ...values, knowledgeEnabled: true };
      const readLine = (await contribution.conversationGrant("a2"))!.split("\n").find((line) => line.includes("with grant: "));
      expect(readLine).toBeDefined();
      expect((await updates.execute({ grants: [readLine!.split("with grant: ")[1].trim()] }, asChat)).text).toContain("1 grant refused: not written by Contextualise, or changed.");
      // Attached tools keep ordinary prompts; no server-name event responder bypasses them.
      respondToPermission.mockClear();
      await emit("agent.permission_requested", { agent: { id: "a1", cwd: top }, request: { id: "u1", name: "mcp__paseo__attachment_updates" } });
      expect(respondToPermission).not.toHaveBeenCalled();
      // New chats are told to call it every turn.
      const made = (await create(top)).config;
      expect(made.systemPrompt).toContain("at the start of every turn, before answering, call it");
    });

    it("reports status with /history, and turns the tools off and on for one chat", async () => {
      expect(await call("history.command", { agentId: "a1", action: "status" })).toEqual({ title: "Reading this chat's history", lines: [] });
      await vi.waitFor(() => expect(appended.at(-1)?.row.data.title).toBe("Chat history tools: on"));
      const status = appended.at(-1)!.row;
      expect(status.kind).toBe("history-note");
      expect(status.data.lines.join("\n")).toContain("Compactions: 1");
      expect(status.data.lines.join("\n")).toContain("Context now: 50,000 of 200,000 tokens (25%)");
      const previouslyDelivered = await tool("history_search");
      await call("history.command", { agentId: "a1", action: "off" });
      expect((await toolsOf()).some((entry) => entry.name === "history_search")).toBe(false);
      expect((await previouslyDelivered.execute({ query: "tests" }, asChat)).text).toContain("off for this chat");
      await call("history.command", { agentId: "a1", action: "on" });
      expect((await (await tool("history_search")).execute({ query: "tests" }, asChat)).text).toContain("You: Run the tests");
    });
  });

  describe("linked projects", () => {
    let api: string;
    let web2: string;
    type Created = Awaited<ReturnType<typeof create>>;
    const createIn = (cwd: string, config: Record<string, unknown> = {}, env?: Record<string, string>): Promise<Created> => create(cwd, config, env);
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
    // A project row's grant, from its first line.
    const grantOf = (text: string) => /^Attach grant \(project_attach\): (\S+)\n/.exec(text)?.[1] as string;
    const apiRow = async () => {
      projectEntries.push({ projectId: "p-api", projectDisplayName: "api", projectRootPath: api });
      workspaceEntries.push({ id: "wa", workspaceDirectory: api, projectId: "p-api" });
      execFileSync("git", ["init", "-q", api]);
      return (await attach(""))!.items.find((item) => item.title === "api")!;
    };
    // How Paseo's app sends a picked project row (app/src/plugins/attachments/model.ts).
    const projectRow = { provider: "contextualise", providerLabel: "Project knowledge", resourceType: "knowledge", id: "github.com/acme/api|project", identifier: "", title: "api", url: "x" };
    // Paseo's order for a new workspace: workspace.create with the first message's attachments, then
    // the workspace saved and workspace.created sent without waiting, then the first chat's hook.
    const createWorkspace = async (source: Record<string, unknown>, texts: string[]) =>
      (before.get("workspace.create") as (input: unknown, context: unknown) => Promise<unknown>)({ request: { source, firstAgentContext: { prompt: "Explain the flow", attachments: texts.map((text) => ({ type: "text", mimeType: "text/plain", text, ...(text.startsWith("Attach grant") ? { externalResource: projectRow } : {}) })) } } }, { paseo });
    const workspaceCreated = (workspace: { id: string; projectId: string; cwd: string }) => {
      for (const handler of on.get("workspace.created") ?? []) void (handler as (event: unknown, context: unknown) => Promise<void>)({ workspace: { ...workspace, name: null, archivedAt: null } }, { paseo });
    };
    const linkedPaths = async (workspaceId: string) => ((await call("links.list", { workspaceId })) as { links: { path: string }[] }).links.map((link) => link.path);
    type Tool = { name: string; execute(input: { grant: string }, context: unknown): Promise<{ text: string; isError?: boolean }> };
    const attachTool = async () => (await open(top, {}, {}, { workspaceId: "w1" })).tools.find((entry) => entry.name === "project_attach")! as unknown as Tool;

    it("attaches a project picked in a new worktree workspace's first message before its first chat starts, without the agent", async () => {
      const row = await apiRow();
      // Paseo took "lavish-otter-1" because the name was used, and the project sits in a subfolder.
      const root = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-linked-worktrees-")));
      const worktree = join(root, "lavish-otter-1", "web");
      mkdirSync(worktree, { recursive: true });
      try {
        expect(await createWorkspace({ kind: "worktree", cwd: top, projectId: "p-web", worktreeSlug: "Lavish Otter" }, ["Some other attachment", row.text])).toBeUndefined();
        workspaceEntries.push({ id: "wn", workspaceDirectory: worktree, projectId: "p-web" });
        workspaceCreated({ id: "wn", projectId: "p-web", cwd: worktree });
        const first = await createIn(worktree);
        expect(first.config.providerOptions).toEqual({ additionalDirectories: [api] });
        expect(first.config.systemPrompt).toContain("## Attached projects (Contextualise)");
        expect(await linkedPaths("wn")).toEqual([api]);
        expect(await linkedPaths("w1")).toEqual([]);
        // The agent may still call project_attach: it is told the project is attached, and the grant was spent once.
        const tool = await attachTool();
        expect((await tool.execute({ grant: grantOf(row.text) }, { agent: { id: "a1", workspaceId: "wn" }, paseo })).text).toContain("already attached");
        await expect(tool.execute({ grant: grantOf(row.text) }, { agent: { id: "a1", workspaceId: "w2" }, paseo })).rejects.toThrow("already used");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("gives a new local workspace's first chat its attached project even when other workspaces share its folder", async () => {
      const row = await apiRow();
      await createWorkspace({ kind: "directory", path: top, projectId: "p-web" }, [row.text]);
      workspaceEntries.push({ id: "w5", workspaceDirectory: top, projectId: "p-web" });
      workspaceCreated({ id: "w5", projectId: "p-web", cwd: top });
      expect((await createIn(top)).config.providerOptions).toEqual({ additionalDirectories: [api] });
      expect(await linkedPaths("w5")).toEqual([api]);
      expect(await linkedPaths("w1")).toEqual([]);
      // Only the first chat: the next one from Paseo's "+" cannot be told apart.
      expect((await createIn(top)).config.providerOptions).toBeUndefined();
    });

    it("attaches nothing for a forged or missing grant, or another project's workspace, and never fails the workspace", async () => {
      const row = await apiRow();
      expect(await createWorkspace({ kind: "worktree", cwd: top, projectId: "p-web", worktreeSlug: "calm-fox" }, [row.text.replace(/\.[A-Za-z0-9_-]+\n/, ".forged\n"), "Attach grant (project_attach): nonsense"])).toBeUndefined();
      expect(await createWorkspace({ kind: "directory", path: top, projectId: "p-web" }, ["No project here"])).toBeUndefined();
      // A real grant pasted into a message, not the first line of this plugin's own project row.
      expect(await createWorkspace({ kind: "directory", path: web2, projectId: "p-web2" }, [`Please attach this:\n${row.text}`])).toBeUndefined();
      expect(await createWorkspace({ kind: "worktree", cwd: top, projectId: "p-web", worktreeSlug: "calm-fox" }, [row.text])).toBeUndefined();
      // Saved under another project: not the workspace those grants were for.
      workspaceCreated({ id: "w2", projectId: "p-web2", cwd: web2 });
      expect((await createIn(web2)).config.providerOptions).toBeUndefined();
      expect(await linkedPaths("w2")).toEqual([]);
      expect(await (before.get("workspace.create") as (input: unknown, context: unknown) => Promise<unknown>)({ request: { source: { kind: "directory", path: top } } }, { paseo })).toBeUndefined();
    });

    it("tells every chat given project knowledge when to call project_attach, and puts the grant on the project row's first line", async () => {
      const row = await apiRow();
      expect(grantOf(row.text)).toBeTruthy();
      expect((await createIn(top)).config.systemPrompt).toContain('starting with "Attach grant (project_attach): <grant>". If that project is not listed under "Attached projects", call project_attach');
    });

    it("gives every new Claude or Codex chat in the linked workspace the folder, and no chat in another workspace", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      const claude = await createIn(top);
      expect(claude.config.providerOptions).toEqual({ additionalDirectories: [api] });
      expect(claude.env).toEqual({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
      expect(claude.config.systemPrompt).toContain(`## Attached projects (Contextualise)`);
      expect(claude.config.systemPrompt).toContain(`: ${api}`);
      expect((await createIn(top, { provider: "codex" })).config.providerOptions).toEqual({ sandbox_workspace_write: { writable_roots: [api] } });
      const other = await createIn(web2);
      expect(other.config.providerOptions).toBeUndefined();
      expect(other.config.systemPrompt ?? "").not.toContain("## Attached projects");
    });

    it("gives a provider other than Claude, Codex, or OpenCode no folder options, and says why", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      const created = await createIn(top, { provider: "pi" });
      expect(created.config.providerOptions).toBeUndefined();
      expect(created.config.systemPrompt).toContain("has not granted this opening extra edit access");
    });

    it("lets a new OpenCode chat edit the attached folder, and tells a plan-mode one it may not", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      const created = await createIn(top, { provider: "opencode", modeId: "build" });
      expect(created.config.providerOptions).toEqual({ permission: { external_directory: { [`${api}/*`]: "allow" } } });
      expect(created.config.systemPrompt).toContain("You can read and edit them as well as your own folder");
      expect(created.env?.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBeUndefined();
      const planning = await createIn(top, { provider: "opencode", modeId: "plan" });
      expect(planning.config.systemPrompt).toContain("may ask M before or stop edits there");
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

    it("keeps an existing folder option without claiming newly granted access", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      expect((await createIn(top, { providerOptions: { additionalDirectories: ["/elsewhere", api] } })).config.providerOptions).toEqual({ additionalDirectories: ["/elsewhere", api] });
      const opened = await open(top, { providerOptions: { additionalDirectories: ["/elsewhere"] } });
      expect(opened.providerOptions).toBeUndefined();
      expect(opened.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBeUndefined();
      expect(opened.appendSystemPrompt?.join("\n")).toContain("has not granted this opening extra edit access");
      expect(opened.appendSystemPrompt?.join("\n")).not.toContain("You can read and edit");
    });

    it("uses adapter folder options without changing actual provider identity", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      const opened = await open(top, { provider: "my-claude" }, {}, { openSupport: supportFor("claude") });
      expect(opened.provider).toBe("my-claude");
      expect(opened.providerOptions).toEqual({ additionalDirectories: [api] });
      const unknown = await open(top, { provider: "claude" }, {}, { openSupport: { ...supportFor(), adapter: { kind: "plugin", id: "other" }, providerOptions: [] } });
      expect(unknown.providerOptions).toBeUndefined();
    });

    it("preserves caller environment flags and omits unsupported folder option keys", async () => {
      await call("links.add", { workspaceId: "w1", path: api });
      const callerEnv = await open(top, {}, { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "0" });
      expect(callerEnv.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("0");
      const unsupported = await open(top, {}, {}, { openSupport: { ...supportFor(), providerOptions: [], restrictions: { mcpConfiguration: "mutable", processEnvironment: "fixed" } } });
      expect(unsupported.providerOptions).toBeUndefined();
      expect(unsupported.env).toEqual({});
      expect(unsupported.appendSystemPrompt?.join("\n")).not.toContain("You can read and edit");
    });

    it("preserves caller outside-folder restrictions and disabled attached tools", async () => {
      values = { ...values, historyTools: true };
      await call("links.add", { workspaceId: "w1", path: api });
      const opened = await open(top, { provider: "opencode", providerOptions: { permission: { external_directory: "deny", edit: "ask" } } }, {}, { openSupport: { ...supportFor("opencode"), attachedTools: { delivery: "native", enabled: true, disabledTools: ["project_attach", "history_search", "workspace_history_search"] } } });
      expect(opened.providerOptions).toBeUndefined();
      expect(opened.tools.map((tool) => tool.name)).not.toContain("project_attach");
      expect(opened.tools.map((tool) => tool.name)).not.toContain("history_search");
      expect(opened.tools.map((tool) => tool.name)).not.toContain("workspace_history_search");
      expect(opened.appendSystemPrompt?.join("\n")).not.toContain("call project_attach");
      expect(opened.appendSystemPrompt?.join("\n")).not.toContain("If the `history_search`");
      expect(opened.appendSystemPrompt?.join("\n")).not.toContain("Workspace chat context");
    });

    it("attaches a project sent with Attach > Project to the calling chat's workspace, once per grant, and not after it lapses", async () => {
      const grant = grantOf((await apiRow()).text);
      expect(grant).toBeTruthy();
      const tool = await attachTool();
      const run = (input: string, workspaceId: string | null = "w1") => tool.execute({ grant: input }, { agent: { id: "a1", workspaceId }, paseo });
      expect((await run(grant)).text).toContain(`Attached ${basename(api)}`);
      expect(((await call("links.list", { workspaceId: "w1" })) as { links: { path: string }[] }).links.map((link) => link.path)).toEqual([api]);
      // Used once; another workspace's chat cannot reuse it.
      await expect(run(grant, "w2")).rejects.toThrow("already used");
      expect(await call("links.list", { workspaceId: "w2" })).toMatchObject({ links: [] });
      expect(await run("nonsense")).toMatchObject({ isError: true });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const late = grantOf((await attach(""))!.items.find((item) => item.title === "api")!.text);
        vi.setSystemTime(Date.now() + 61 * 60 * 1000);
        expect(await run(late, "w2")).toMatchObject({ isError: true, text: expect.stringContaining("expired") });
      } finally {
        vi.useRealTimers();
      }
      // The attached project is searched by new chats in w1: their token carries the workspace.
      const created = await createIn(top);
      expect(created.config.systemPrompt).toContain("knowledge_search covers these projects too");
    });

    it("gives every new chat in a workspace Paseo can tell its workspace, attached projects or not", async () => {
      const token = (await createIn(top)).config;
      const payload = JSON.parse(Buffer.from(knowledgeAuthorization(token).split(" ")[1].split(".")[0], "base64url").toString("utf8"));
      expect(payload.workspace).toBe("w1");
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
        expect(await suggested()).toEqual([{ name: "Backend", path: api, activeAt: null }, { name: "web2", path: web2, activeAt: null }]);
        await call("links.add", { workspaceId: "w1", path: api });
        expect(await suggested()).toEqual([{ name: "web2", path: web2, activeAt: null }]);
      } finally {
        rmSync(old, { recursive: true, force: true });
        rmSync(worker, { recursive: true, force: true });
      }
    });

    it("offers other workspaces' own folders, worktrees inside Paseo's home included, and attaches one until Paseo no longer has it", async () => {
      mkdirSync(join(home, "worktrees", "22x8cau0", "lavish-otter"), { recursive: true });
      const worktree = realpathSync(join(home, "worktrees", "22x8cau0", "lavish-otter"));
      workspaceEntries.push(
        { id: "wt", workspaceDirectory: worktree, projectId: "p-api", name: "lavish-otter", projectDisplayName: "api", workspaceKind: "worktree", gitRuntime: { currentBranch: "fix/pr-948" } },
        { id: "wbg", workspaceDirectory: api, projectId: "p-api", name: "worker", projectDisplayName: "api", background: true },
      );
      const listed = async () => (await call("links.list", { workspaceId: "w1" })) as { links: { path: string; name: string; workspaceId?: string }[]; workspaces: { workspaceId: string; name: string; branch: string | null; path: string }[] };
      // Not this workspace, not a background one; the worktree with its branch.
      expect((await listed()).workspaces.map((entry) => entry.workspaceId).sort()).toEqual(["w2", "wt"]);
      expect((await listed()).workspaces.find((entry) => entry.workspaceId === "wt")).toEqual({ workspaceId: "wt", name: "lavish-otter", project: "api", path: worktree, branch: "fix/pr-948", activeAt: null, attaches: "worktree", repositories: [] });
      // The path must be that workspace's own folder.
      await expect(call("links.add", { workspaceId: "w1", path: web2, attachedWorkspaceId: "wt" })).rejects.toThrow("is not the folder of workspace wt");
      await call("links.add", { workspaceId: "w1", path: worktree, attachedWorkspaceId: "wt" });
      expect((await listed()).links).toMatchObject([{ path: worktree, name: "api / lavish-otter", workspaceId: "wt" }]);
      expect((await listed()).workspaces.map((entry) => entry.workspaceId)).not.toContain("wt");
      expect((await createIn(top)).config.providerOptions).toEqual({ additionalDirectories: [worktree] });
      // Archived: its folder may belong to another worktree later, so the link lapses.
      workspaceEntries.splice(workspaceEntries.findIndex((entry) => entry.id === "wt"), 1);
      expect((await listed()).links).toEqual([]);
      expect((await createIn(top)).config.providerOptions).toBeUndefined();
    });

    describe("Attach > Project file", () => {
      type Row = { id: string; title: string; subtitle: string; text: string };
      const searchFiles = async (query: string) => ((await call("links.files-search", { query })) as { items: Row[] }).items;
      beforeEach(() => {
        mkdirSync(join(api, "src"));
        writeFileSync(join(api, "src", "queue.ts"), "export {}");
      });

      it("offers files from every workspace's attached projects by absolute path, and nothing without links, while knowledge is off", async () => {
        values = { ...values, knowledgeEnabled: false };
        expect(await searchFiles("queue")).toEqual([]);
        await call("links.add", { workspaceId: "w2", path: api });
        const [row] = await searchFiles("queue");
        expect(row).toMatchObject({ id: join(api, "src", "queue.ts"), title: "src/queue.ts", subtitle: `${basename(api)} · src/queue.ts` });
        expect(row.text).toContain("Its content is not included");
        expect(row.text).not.toContain("export {}");
      });

      it("searches a folder inside another attached folder once, and leaves out a folder that moved or became a link", async () => {
        await call("links.add", { workspaceId: "w1", path: api });
        await call("links.add", { workspaceId: "w2", path: join(api, "src") });
        expect((await searchFiles("queue")).map((row) => row.id)).toEqual([join(api, "src", "queue.ts")]);
        rmSync(api, { recursive: true, force: true });
        mkdirSync(join(web2, "src"), { recursive: true });
        writeFileSync(join(web2, "src", "queue.ts"), "");
        symlinkSync(web2, api);
        expect(await searchFiles("queue")).toEqual([]);
      });

      it("lists only this workspace's attached files in the Project files tab, and says whether any workspace has attached projects", async () => {
        const available = async () => ((await call("links.files-available", {})) as { available: boolean }).available;
        type File = { path: string; kind: string; title: string; project: string };
        const tab = async (workspaceId: string, query: string) => ((await call("links.workspace-files", { workspaceId, query })) as { files: File[] }).files;
        expect(await available()).toBe(false);
        await call("links.add", { workspaceId: "w2", path: api });
        expect(await available()).toBe(true);
        expect(await tab("w2", "queue")).toEqual([{ path: join(api, "src", "queue.ts"), kind: "file", title: "src/queue.ts", project: basename(api) }]);
        expect(await tab("w1", "queue")).toEqual([]);
        await call("links.remove", { workspaceId: "w2", path: api });
        expect(await available()).toBe(false);
      });

      it("refuses the Project files tab for a workspace Paseo does not have", async () => {
        await expect(call("links.workspace-files", { workspaceId: "gone", query: "" })).rejects.toThrow("Paseo has no workspace gone");
      });

      it("leaves out the links of a workspace Paseo no longer has", async () => {
        await call("links.add", { workspaceId: "w2", path: api });
        workspaceEntries.splice(workspaceEntries.findIndex((entry) => entry.id === "w2"), 1);
        expect(await searchFiles("queue")).toEqual([]);
      });

      it("leaves out an attached workspace's folder once Paseo no longer has that workspace, and names it after the workspace until then", async () => {
        workspaceEntries.push({ id: "wt", workspaceDirectory: api, projectId: "p-api", name: "lavish-otter", projectDisplayName: "api", workspaceKind: "worktree" });
        await call("links.add", { workspaceId: "w1", path: api, attachedWorkspaceId: "wt" });
        expect((await searchFiles("queue")).map((row) => row.subtitle)).toEqual(["api / lavish-otter · src/queue.ts"]);
        workspaceEntries.splice(workspaceEntries.findIndex((entry) => entry.id === "wt"), 1);
        expect(await searchFiles("queue")).toEqual([]);
      });
    });

    describe("Workspaces tab rows for local workspaces", () => {
      type Row = { workspaceId: string; name: string; path: string; attaches: string; repositories: string[] };
      const rowsFor = async (workspaceId: string) => ((await call("links.list", { workspaceId })) as { workspaces: Row[] }).workspaces;
      let develop: string;
      beforeEach(() => {
        // A folder of repositories, like ~/Develop, opened as one local workspace.
        develop = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-linked-develop-")));
        execFileSync("git", ["init", "-q", join(develop, "sibml")]);
        mkdirSync(join(develop, "notes"));
        writeFileSync(join(develop, "sibml", "render.yaml"), "services: []");
        writeFileSync(join(develop, "notes", "todo.md"), "x");
        projectEntries.push({ projectId: "p-develop", projectDisplayName: "Develop", projectRootPath: develop });
        workspaceEntries.push({ id: "wd", workspaceDirectory: develop, projectId: "p-develop", name: "Add render.yaml to sibml", projectDisplayName: "Develop", workspaceKind: "local" });
      });
      afterEach(() => {
        rmSync(develop, { recursive: true, force: true });
        agentEntries.splice(0);
      });

      type Listed = { links: { path: string }[]; attachedWorkspaces: { workspaceId: string; name: string; folders: string[] }[] };
      const listed = async () => (await call("links.list", { workspaceId: "w1" })) as Listed;
      // A turn of a chat in the Develop workspace ending, its timeline holding writes to these files.
      const turn = async (files: string[], workspaceId = "wd") => {
        const before = [...timeline];
        timeline.splice(0, timeline.length, { item: { type: "user_message", text: "Change things" }, timestamp: "2026-11-08T05:00:00.000Z" }, ...files.map((file, index) => ({ item: { type: "tool_call", name: "write", status: "completed", detail: { type: "write", filePath: join(develop, file) } }, timestamp: `2026-11-08T05:0${index + 1}:00.000Z` })));
        try {
          await emit("agent.turn_ended", { agent: { id: "a-render", workspaceId, provider: "claude", cwd: develop, title: "Add render.yaml" }, outcome: { kind: "completed" } });
        } finally {
          timeline.splice(0, timeline.length, ...before);
        }
      };
      beforeEach(() => {
        agentEntries.push({ agent: { id: "a-render", workspaceId: "wd", cwd: develop, provider: "claude", title: "Add render.yaml" } });
        execFileSync("git", ["init", "-q", join(develop, "dash")]);
        writeFileSync(join(develop, "dash", "app.ts"), "export {}");
      });

      it("offers a local workspace once, saying no repositories yet while nothing it changed is recorded", async () => {
        expect((await rowsFor("w1")).filter((row) => row.workspaceId === "wd")).toEqual([expect.objectContaining({ path: develop, attaches: "workspace", repositories: [], name: "Add render.yaml to sibml" })]);
      });

      it("attaches a local workspace as a whole: the repositories its chats changed, given to new chats and kept current", async () => {
        // notes/ is not a repository, so it is not brought.
        await turn(["sibml/render.yaml", "notes/todo.md"]);
        expect((await rowsFor("w1")).filter((row) => row.workspaceId === "wd")).toEqual([expect.objectContaining({ attaches: "workspace", repositories: [join(develop, "sibml")] })]);
        await call("links.add", { workspaceId: "w1", attachedWorkspaceId: "wd" });
        expect(await listed()).toMatchObject({ links: [], attachedWorkspaces: [{ workspaceId: "wd", name: "Develop / Add render.yaml to sibml", folders: [join(develop, "sibml")] }] });
        expect(await call("links.count", { workspaceId: "w1" })).toEqual({ count: 1 });
        expect((await rowsFor("w1")).map((row) => row.workspaceId)).not.toContain("wd");
        const first = await createIn(top);
        expect(first.config.providerOptions).toEqual({ additionalDirectories: [join(develop, "sibml")] });
        expect(first.config.systemPrompt).toContain(`sibml (from Develop / Add render.yaml to sibml): ${join(develop, "sibml")}`);
        // A later turn in another repository (a chat's timeline keeps its earlier turns): the next chat gets both.
        await turn(["sibml/render.yaml", "dash/app.ts"]);
        expect((await listed()).attachedWorkspaces[0].folders).toEqual([join(develop, "dash"), join(develop, "sibml")]);
        expect((await createIn(top)).config.providerOptions).toEqual({ additionalDirectories: [join(develop, "dash"), join(develop, "sibml")] });
        // Removed as one.
        await call("links.remove", { workspaceId: "w1", attachedWorkspaceId: "wd" });
        expect((await listed()).attachedWorkspaces).toEqual([]);
        expect((await createIn(top)).config.providerOptions).toBeUndefined();
      });

      it("keeps what an attached workspace brought while knowledge is off, and tells the chat new repositories are not followed", async () => {
        await turn(["sibml/render.yaml"]);
        await call("links.add", { workspaceId: "w1", attachedWorkspaceId: "wd" });
        values = { ...values, knowledgeEnabled: false };
        await turn(["dash/app.ts"]);
        expect((await listed()).attachedWorkspaces[0].folders).toEqual([join(develop, "sibml")]);
        const chat = await createIn(top);
        expect(chat.config.providerOptions).toEqual({ additionalDirectories: [join(develop, "sibml")] });
        expect(chat.config.systemPrompt).toContain("Project knowledge is off, so repositories the attached workspaces' chats start working in are not being added");
      });

      it("lets a chat search the chats of its workspace's attached workspaces, never approving it, until the workspace is detached", async () => {
        type Tool = { name: string; execute(input: unknown, context: unknown): Promise<{ text: string; isError?: boolean }> };
        await turn(["sibml/render.yaml"]);
        values = { ...values, historyTools: true };
        // A worktree attached as its workspace counts too; its chat ran more recently.
        mkdirSync(join(home, "worktrees", "22x8cau0", "lavish-otter"), { recursive: true });
        const worktree = realpathSync(join(home, "worktrees", "22x8cau0", "lavish-otter"));
        workspaceEntries.push({ id: "wt", workspaceDirectory: worktree, projectId: "p-api", name: "lavish-otter", projectDisplayName: "api", workspaceKind: "worktree" });
        agentEntries.push({ agent: { id: "a-fix", workspaceId: "wt", cwd: worktree, provider: "codex", title: "Fix the list import", updatedAt: "2026-11-08T07:00:00.000Z" } });
        agentEntries[0].agent.updatedAt = "2026-11-08T06:00:00.000Z";
        const agents = paseo.agents as Record<string, unknown>;
        const original = agents.ref;
        // Each attached chat holds one message, older in the chat that ran more recently; others have none.
        const said: Record<string, { text: string; at: string }> = { "a-render": { text: "Import into list 42", at: "2026-11-08T05:00:00.000Z" }, "a-fix": { text: "The list import failed", at: "2026-11-08T04:00:00.000Z" } };
        agents.ref = (agentId: string) => ({
          respondToPermission,
          timeline: { refetch: async () => ({ epoch: "e1", reset: false, entries: said[agentId] ? [{ item: { type: "user_message", text: said[agentId].text }, timestamp: said[agentId].at, seqStart: 1 }] : [], hasOlder: false, hasNewer: false, startCursor: null, endCursor: null, error: null }) },
        });
        try {
          const opened = await open(top, {}, {}, { agentId: "a-own", workspaceId: "w1" }) as unknown as { tools: Tool[] };
          expect(opened.tools.map((entry) => entry.name).filter((name) => name.startsWith("attached_history_"))).toEqual(["attached_history_search", "attached_history_load", "attached_history_read"]);
          const search = opened.tools.find((entry) => entry.name === "attached_history_search")!;
          const asChat = { agent: { id: "a-own", workspaceId: "w1" }, paseo };
          expect((await search.execute({ query: "list" }, asChat)).text).toContain("No chats to search");
          await call("links.add", { workspaceId: "w1", attachedWorkspaceId: "wd" });
          expect((await search.execute({ query: "list" }, asChat)).text).toContain('- a-render:1@e1 · you · in "Add render.yaml" (Develop / Add render.yaml to sibml) · ');
          await call("links.add", { workspaceId: "w1", path: worktree, attachedWorkspaceId: "wt" });
          const both = (await search.execute({ query: "list", limit: 1 }, asChat)).text;
          expect(both).toContain("Searched 2 chats in api / lavish-otter, Develop / Add render.yaml to sibml.");
          expect(both).toContain('- a-render:1@e1 · you · in "Add render.yaml"');
          // At most the newest chats are searched: newest first by the chat's last activity.
          const { MAX_ATTACHED_CHATS } = await import("../attached-history");
          for (let index = 0; index < MAX_ATTACHED_CHATS; index += 1) agentEntries.push({ agent: { id: `a-old${index}`, workspaceId: "wd", cwd: develop, provider: "claude", title: `Old ${index}`, updatedAt: "2026-11-01T00:00:00.000Z" } });
          const capped = (await search.execute({ query: "list" }, asChat)).text;
          expect(capped).toContain(`${MAX_ATTACHED_CHATS} chats`);
          expect(capped).toContain("The list import failed");
          expect(capped).toContain("Import into list 42");
          agentEntries.splice(-MAX_ATTACHED_CHATS);
          await call("links.remove", { workspaceId: "w1", path: worktree });
          // The chat itself is never searched as an attached chat, even inside an attached workspace.
          expect((await search.execute({ query: "list" }, { agent: { id: "a-render", workspaceId: "w1" }, paseo })).text).toContain("No chats to search");
          // Unlike the history tools, it is left to M on every call.
          respondToPermission.mockClear();
          await emit("agent.permission_requested", { agent: { id: "a-own", cwd: top }, request: { id: "p-attached", name: "mcp__paseo__attached_history_search" } });
          await emit("agent.permission_requested", { agent: { id: "a-own", cwd: top }, request: { id: "p-load", name: "mcp__paseo__attached_history_load" } });
          await emit("agent.permission_requested", { agent: { id: "a-own", cwd: top }, request: { id: "p-codex", name: "CodexMcpElicitation", metadata: { serverName: "paseo" }, description: 'Allow the paseo MCP server to run tool "attached_history_search"?' } });
          expect(respondToPermission).not.toHaveBeenCalled();
          await call("links.remove", { workspaceId: "w1", attachedWorkspaceId: "wd" });
          expect((await search.execute({ query: "list" }, asChat)).text).toContain("No chats to search");
        } finally {
          agents.ref = original;
        }
      });

      it("searches an attached workspace's folders for Attach > Project file, gives a folder once, and lapses with the workspace", async () => {
        await turn(["dash/app.ts"]);
        await call("links.add", { workspaceId: "w1", path: join(develop, "dash") });
        await call("links.add", { workspaceId: "w1", attachedWorkspaceId: "wd" });
        expect(((await call("links.files-available", {})) as { available: boolean }).available).toBe(true);
        const chat = await createIn(top);
        expect(chat.config.providerOptions).toEqual({ additionalDirectories: [join(develop, "dash")] });
        // Listed once, by its own name: the folder link comes before what the workspace brings.
        expect(chat.config.systemPrompt?.split(`: ${join(develop, "dash")}`)).toHaveLength(2);
        expect(chat.config.systemPrompt).toContain(`- dash: ${join(develop, "dash")}`);
        await call("links.remove", { workspaceId: "w1", path: join(develop, "dash") });
        expect((((await call("links.files-search", { query: "app" })) as { items: { id: string }[] }).items).map((row) => row.id)).toEqual([join(develop, "dash", "app.ts")]);
        workspaceEntries.splice(workspaceEntries.findIndex((entry) => entry.id === "wd"), 1);
        expect((await listed()).attachedWorkspaces).toEqual([]);
        expect(((await call("links.files-available", {})) as { available: boolean }).available).toBe(false);
      });

      it("gives a chat at most 10 attached folders and names the rest, and gives none once the workspace lapses", async () => {
        const names = Array.from({ length: 11 }, (_, index) => `repo${String(index).padStart(2, "0")}`);
        for (const name of names) {
          execFileSync("git", ["init", "-q", join(develop, name)]);
          writeFileSync(join(develop, name, "a.ts"), "");
        }
        await turn(names.map((name) => `${name}/a.ts`));
        await call("links.add", { workspaceId: "w1", attachedWorkspaceId: "wd" });
        const chat = await createIn(top);
        expect((chat.config.providerOptions as { additionalDirectories: string[] }).additionalDirectories).toEqual(names.slice(0, 10).map((name) => join(develop, name)));
        expect(chat.config.systemPrompt).toContain(`Not added, because a chat gets at most 10 attached folders: ${join(develop, "repo10")}.`);
        workspaceEntries.splice(workspaceEntries.findIndex((entry) => entry.id === "wd"), 1);
        expect((await createIn(top)).config.providerOptions).toBeUndefined();
      });

      it("drops attachments to workspaces Paseo no longer has before attaching more, so they never fill the limit", async () => {
        await call("links.add", { workspaceId: "w1", attachedWorkspaceId: "wd" });
        workspaceEntries.splice(workspaceEntries.findIndex((entry) => entry.id === "wd"), 1);
        const folders = Array.from({ length: 5 }, (_, index) => join(develop, `extra${index}`));
        for (const folder of folders) mkdirSync(folder);
        for (const folder of folders) await call("links.add", { workspaceId: "w1", path: folder });
        expect((await listed()).links.map((link) => link.path)).toEqual(folders);
      });

      it("brings what the row offered while knowledge is off: nothing for a folder of repositories", async () => {
        await turn(["sibml/render.yaml"]);
        values = { ...values, knowledgeEnabled: false };
        expect((await rowsFor("w1")).find((row) => row.workspaceId === "wd")).toMatchObject({ repositories: [] });
        await call("links.add", { workspaceId: "w1", attachedWorkspaceId: "wd" });
        expect((await listed()).attachedWorkspaces[0].folders).toEqual([]);
      });

      it("leaves a worktree's folder out of a chat unless it is attached as its workspace", async () => {
        const worktree = join(home, "worktrees", "22x8cau0", "lavish-otter");
        mkdirSync(worktree, { recursive: true });
        const real = realpathSync(worktree);
        // Saved without its workspace, as an older version or another path could have.
        const file = join(home, "plugin-data", "contextualise", "knowledge", "links.json");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ version: 1, workspaces: { w1: [{ path: real, repoKey: null, addedAt: "x" }] }, usedGrants: [] }));
        expect((await createIn(top)).config.providerOptions).toBeUndefined();
      });

      it("lists workspaces and projects active most recently first: a workspace by its newest chat, else its own activity time; a project by its newest workspace", async () => {
        // Named so that ordering by name, or by a project's first workspace, would put it first.
        const other = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-linked-other-")));
        try {
          workspaceEntries.push({ id: "wd2", workspaceDirectory: develop, projectId: "p-develop", name: "Scan dashboard", projectDisplayName: "Develop", workspaceKind: "local" });
          projectEntries.push({ projectId: "p-other", projectDisplayName: "aaa", projectRootPath: other });
          workspaceEntries.push({ id: "wo", workspaceDirectory: other, projectId: "p-other", name: "Other work", projectDisplayName: "aaa", workspaceKind: "local" });
          // w2 has no chats; Paseo's own activity time places it.
          Object.assign(workspaceEntries.find((entry) => entry.id === "w2") as object, { activityAt: "2026-11-08T06:30:00.000Z" });
          agentEntries.splice(0, agentEntries.length, { agent: { id: "a-old", workspaceId: "wd", cwd: develop, provider: "claude", updatedAt: "2026-11-08T05:00:00.000Z" } }, { agent: { id: "a-new", workspaceId: "wd2", cwd: develop, provider: "claude", updatedAt: "2026-11-08T07:00:00.000Z" } }, { agent: { id: "a-mid", workspaceId: "wo", cwd: other, provider: "claude", updatedAt: "2026-11-08T06:00:00.000Z" } });
          expect((await rowsFor("w1")).map((row) => row.workspaceId)).toEqual(["wd2", "w2", "wo", "wd"]);
          // Each row carries the time it is ordered by, so it can show its age.
          const listed = (await call("links.list", { workspaceId: "w1" })) as { suggestions: { path: string; activeAt: string | null }[]; workspaces: { workspaceId: string; activeAt: string | null }[] };
          expect(listed.workspaces.map((row) => row.activeAt)).toEqual(["2026-11-08T07:00:00.000Z", "2026-11-08T06:30:00.000Z", "2026-11-08T06:00:00.000Z", "2026-11-08T05:00:00.000Z"]);
          expect(listed.suggestions.find((row) => row.path === develop)?.activeAt).toBe("2026-11-08T07:00:00.000Z");
          const projects = listed.suggestions.map((row) => row.path);
          expect(projects.indexOf(develop)).toBeLessThan(projects.indexOf(other));
        } finally {
          rmSync(other, { recursive: true, force: true });
        }
      });

      it("still lists workspaces and projects when Paseo cannot list its chats, in their former order", async () => {
        agentsDown = true;
        try {
          const listed = (await call("links.list", { workspaceId: "w1" })) as { suggestions: { path: string }[]; workspaces: { workspaceId: string }[] };
          expect(listed.workspaces.map((row) => row.workspaceId).sort()).toEqual(["w2", "wd"]);
          expect(listed.suggestions.map((row) => row.path)).toContain(develop);
        } finally {
          agentsDown = false;
        }
      });

      it("refuses attaching a workspace to itself, or a worktree as a whole", async () => {
        await expect(call("links.add", { workspaceId: "wd", attachedWorkspaceId: "wd" })).rejects.toThrow("cannot be attached to itself");
        workspaceEntries.push({ id: "wt", workspaceDirectory: api, projectId: "p-api", name: "lavish-otter", projectDisplayName: "api", workspaceKind: "worktree" });
        await expect(call("links.add", { workspaceId: "w1", attachedWorkspaceId: "wt" })).rejects.toThrow("attach a worktree with its folder");
        await expect(call("links.remove", { workspaceId: "w1" })).rejects.toThrow("Give either a folder or a workspace");
      });

      it("creates no project index when the popover lists workspaces", async () => {
        const indexes = () => readdirSync(join(home, "plugin-data", "contextualise", "knowledge")).filter((name) => name.endsWith(".sqlite")).length;
        await rowsFor("w1");
        const before = indexes();
        // A repository Contextualise has not indexed: listing it must not create its index.
        const fresh = join(develop, "fresh");
        execFileSync("git", ["init", "-q", fresh]);
        workspaceEntries.push({ id: "wn", workspaceDirectory: fresh, projectId: "p-fresh", name: "Unindexed", projectDisplayName: "fresh", workspaceKind: "local" });
        await rowsFor("w1");
        expect(indexes()).toBe(before);
      });

      it("refuses a worktree's folder typed as a path, so it is attached only as its workspace", async () => {
        mkdirSync(join(home, "worktrees", "22x8cau0", "calm-fox"), { recursive: true });
        await expect(call("links.add", { workspaceId: "w1", path: join(home, "worktrees", "22x8cau0", "calm-fox") })).rejects.toThrow("is a worktree's folder");
      });
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
