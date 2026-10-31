import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTokenSecret, TokenAuthority } from "./auth";
import { KnowledgeBase } from "./base";
import { projectRoot } from "./git";
import { KNOWLEDGE_SERVER, KnowledgeMcp, knowledgeServerEntry } from "./mcp";
import { KnowledgeService } from "./service";
import { SymbolReader } from "./symbols";

describe("knowledge tools", () => {
  let top: string;
  let root: string;
  let http: Server;
  let base: KnowledgeBase;
  let tokens: TokenAuthority;
  let related: ((repoKey: string, path: string) => Promise<{ id: string; subject: string }[]>) | null;
  const calls: [string, string, string][] = [];
  const clients: Client[] = [];

  const connect = async (token: string) => {
    const { url, headers } = knowledgeServerEntry((http.address() as AddressInfo).port, token)[KNOWLEDGE_SERVER];
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    clients.push(client);
    return client;
  };
  const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");

  beforeEach(async () => {
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-mcp-repo-")));
    root = mkdtempSync(join(tmpdir(), "contextualise-mcp-data-"));
    execFileSync("git", ["init", "-q", top]);
    for (const [path, text] of [
      ["docs/adr/0001-use-sqlite.md", "# Use SQLite\n\nStatus: accepted\n\nWe keep the index in SQLite.\n"],
      ["shared/contracts.ts", "export function parseItemRef(ref: string) { return ref.trim(); }\n"],
    ]) {
      mkdirSync(dirname(join(top, path)), { recursive: true });
      writeFileSync(join(top, path), text);
    }
    execFileSync("git", ["-C", top, "add", "-A"]);
    base = new KnowledgeBase({ root: async () => root, symbols: new SymbolReader(async () => process.cwd()), indexOptions: async () => ({ codeSymbols: true }) });
    related = null;
    tokens = new TokenAuthority(await loadTokenSecret(root));
    calls.length = 0;
    http = await new KnowledgeMcp(tokens, new KnowledgeService(base, async () => related), { recordCall: async (repoKey, tool, token) => void calls.push([repoKey, tool, token]) }).listen(0);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
    base.close();
    rmSync(top, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("offers only read tools", async () => {
    const client = await connect(tokens.mint({ repoKey: "local/abc", top }));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["knowledge_search", "knowledge_read", "knowledge_outline", "knowledge_history"]);
  });

  it("tells the agent when to use its tools, so it can find them while they are deferred", async () => {
    const client = await connect(tokens.mint({ repoKey: "local/abc", top }));
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("At the start of a task, search with knowledge_search");
    expect(instructions.length).toBeLessThan(1_000);
  });

  it("counts each tool call for its project and agent, and two agents in one checkout as two", async () => {
    const first = await connect(tokens.mint({ repoKey: "local/abc", top }));
    const second = await connect(tokens.mint({ repoKey: "local/abc", top }));
    await first.callTool({ name: "knowledge_search", arguments: { query: "sqlite" } });
    await first.callTool({ name: "knowledge_history", arguments: { path: "docs" } });
    await second.callTool({ name: "knowledge_search", arguments: { query: "sqlite" } });
    expect(calls.map(([repoKey, tool]) => [repoKey, tool])).toEqual([["local/abc", "knowledge_search"], ["local/abc", "knowledge_history"], ["local/abc", "knowledge_search"]]);
    expect(calls[0][2]).toBe(calls[1][2]);
    expect(calls[2][2]).not.toBe(calls[0][2]);
  });

  it("describes a main area when given its folder", async () => {
    for (const [path, text] of [
      ["core/a.ts", "export class Store {}\n"],
      ["core/b.ts", "export const b = 1;\n"],
      ["core/c.ts", "export const c = 1;\n"],
      ["api/x.ts", 'import { Store } from "../core/a";\n'],
      ["api/y.ts", "export const y = 1;\n"],
      ["api/z.ts", "export const z = 1;\n"],
    ]) {
      mkdirSync(dirname(join(top, path)), { recursive: true });
      writeFileSync(join(top, path), text);
    }
    execFileSync("git", ["-C", top, "add", "-A"]);
    const client = await connect(tokens.mint({ repoKey: "local/abc", top }));
    expect(textOf(await client.callTool({ name: "knowledge_outline", arguments: { path: "core/" } }))).toBe(
      ["Area core: 3 code files, 0 test files", "Used by: api (1 files)", "Key names:", "- Store (class) core/a.ts:1, used in 1 files elsewhere", "Main files:", "- core/a.ts (imported by 1 files)"].join("\n"),
    );
  });

  it("outlines a file, lists the tasks that changed it, and narrows search to paths", async () => {
    const client = await connect(tokens.mint({ repoKey: "local/abc", top }));
    expect(textOf(await client.callTool({ name: "knowledge_outline", arguments: { path: "shared/contracts.ts" } }))).toBe("1: parseItemRef  [code:shared/contracts.ts:1:parseItemRef]");
    expect(textOf(await client.callTool({ name: "knowledge_outline", arguments: { path: "docs/adr/0001-use-sqlite.md" } }))).toBe("1: § Use SQLite  [adr:docs/adr/0001-use-sqlite.md:1]");
    await base.recordTask(projectRoot("local/abc", top), { id: "task:a1", agentId: "a1", provider: "claude", title: "Trim refs", request: "Trim item refs", outcome: "completed", files: ["shared/contracts.ts"], commands: [], startedAt: "2026-10-29T10:00:00.000Z", endedAt: "2026-10-29T11:00:00.000Z", citations: [{ path: "shared/contracts.ts", blob: "old" }], summary: "Made parseItemRef trim spaces." });
    expect(textOf(await client.callTool({ name: "knowledge_history", arguments: { path: "shared" } }))).toBe("[task:a1] 2026-10-29 Trim refs (completed) [needs check: its files changed since]\n  Made parseItemRef trim spaces.");
    expect(textOf(await client.callTool({ name: "knowledge_history", arguments: { path: "docs" } }))).toBe("No finished task changed docs.");
    const narrowed = textOf(await client.callTool({ name: "knowledge_search", arguments: { query: "sqlite parse", paths: ["docs/**"] } }));
    expect(narrowed).toContain("adr:docs/adr/0001-use-sqlite.md:1");
    expect(narrowed).not.toContain("shared/contracts.ts");
  });

  it("finds an ADR and a code symbol, and reads them quoted", async () => {
    const client = await connect(tokens.mint({ repoKey: "local/abc", top }));
    const found = textOf(await client.callTool({ name: "knowledge_search", arguments: { query: "sqlite" } }));
    expect(found).toContain("[adr:docs/adr/0001-use-sqlite.md:1] adr: Use SQLite (docs/adr/0001-use-sqlite.md:1)");
    const symbol = textOf(await client.callTool({ name: "knowledge_search", arguments: { query: "parse item", kinds: ["code"] } }));
    expect(symbol).toContain("[code:shared/contracts.ts:1:parseItemRef] code: parseItemRef (shared/contracts.ts:1)");
    const read = textOf(await client.callTool({ name: "knowledge_read", arguments: { id: "code:shared/contracts.ts:1:parseItemRef" } }));
    expect(read).toContain("Quoted from the repository; verify before relying on it:\nfunction parseItemRef");
  });

  it("names related Memorise memories only when Memorise is available", async () => {
    const client = await connect(tokens.mint({ repoKey: "local/abc", top }));
    expect(textOf(await client.callTool({ name: "knowledge_search", arguments: { query: "parseItemRef" } }))).not.toContain("Memorise");
    related = async (_repoKey, path) => (path === "shared/contracts.ts" ? [{ id: "01JB8Z6X3T5Q9V2M4N7P8R1S0W", subject: "item refs" }] : []);
    expect(textOf(await client.callTool({ name: "knowledge_search", arguments: { query: "parseItemRef" } }))).toContain('Memorise memories about this file (read with memory_read): 01JB8Z6X3T5Q9V2M4N7P8R1S0W "item refs"');
  });

  it("says plainly when nothing matches or an id is unknown", async () => {
    const client = await connect(tokens.mint({ repoKey: "local/abc", top }));
    expect(textOf(await client.callTool({ name: "knowledge_search", arguments: { query: "kubernetes" } }))).toBe('Nothing in local/abc matches "kubernetes". Try other words, or fewer.');
    const missing = await client.callTool({ name: "knowledge_read", arguments: { id: "doc:nope.md:1" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("No entry doc:nope.md:1 in local/abc");
  });

  it("refuses requests without a valid token", async () => {
    const port = (http.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp/knowledge`, { method: "POST", headers: { Authorization: "Bearer forged.token", "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/mcp/knowledge`)).status).toBe(405);
  });
});
