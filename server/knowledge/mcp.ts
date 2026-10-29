import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { areaLabel } from "../../shared/diagram";
import { KNOWLEDGE_KINDS, type KnowledgeEntry, type SearchHit } from "../../shared/knowledge";
import type { AgentScope, TokenAuthority } from "./auth";
import { projectRoot } from "./git";
import type { KnowledgeService } from "./service";

// A distinctive name: permission requests are recognised by it, so a user's own server must not share it.
export const KNOWLEDGE_SERVER = "paseo-contextualise";
const PATH = "/mcp/knowledge";
const MAX_REQUEST_BYTES = 64 * 1024;

export function knowledgeServerEntry(port: number, token: string) {
  return { [KNOWLEDGE_SERVER]: { type: "http" as const, url: `http://127.0.0.1:${port}${PATH}`, headers: { Authorization: `Bearer ${token}` } } };
}

function describeHit(hit: SearchHit): string {
  const where = hit.kind === "task" ? (hit.path ? `touched ${hit.path}` : "") : `${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}`;
  return [
    `[${hit.id}] ${hit.kind}: ${hit.title}${where ? ` (${where})` : ""}${hit.needsCheck ? " [needs check: its source changed]" : ""}`,
    ...(hit.snippet ? [`  ${hit.snippet.replace(/\s+/g, " ").trim()}`] : []),
    ...(hit.relatedMemories.length > 0 ? [`  Memorise memories about this file (read with memory_read): ${hit.relatedMemories.map((memory) => `${memory.id} "${memory.subject}"`).join("; ")}`] : []),
  ].join("\n");
}

function describeEntry(entry: KnowledgeEntry): string {
  return [
    `[${entry.id}] ${entry.kind}: ${entry.title}${entry.path ? ` (${entry.path}${entry.line > 0 ? `:${entry.line}` : ""})` : ""}`,
    ...(entry.needsCheck ? ["Needs check: its source changed since this was recorded."] : []),
    "Quoted from the repository; verify before relying on it:",
    entry.body,
    ...(entry.relatedMemories.length > 0 ? [`Memorise memories about this file (read with memory_read): ${entry.relatedMemories.map((memory) => `${memory.id} "${memory.subject}"`).join("; ")}`] : []),
  ].join("\n");
}

// The agents' read-only tools over their own repository's knowledge. Stateless, like Memorise's: a
// fresh MCP server per request, scoped by the agent's token.
// An area as an agent reads it: its written line, size, links, key names with places, and main files.
function describeArea(found: Awaited<ReturnType<KnowledgeService["area"]>>): string {
  const { area } = found;
  return [
    `Area ${areaLabel(area.path)}: ${area.files} code files, ${area.tests} test files${found.line ? `. ${found.line}` : ""}`,
    ...(found.dependsOn.length > 0 ? [`Uses: ${found.dependsOn.map((link) => `${areaLabel(link.to)} (${link.count} files)`).join(", ")}`] : []),
    ...(found.usedBy.length > 0 ? [`Used by: ${found.usedBy.map((link) => `${areaLabel(link.from)} (${link.count} files)`).join(", ")}`] : []),
    ...(area.keyNames.length > 0 ? ["Key names:", ...area.keyNames.map((key) => `- ${key.name} (${key.kind}) ${key.path}:${key.line}${key.uses > 0 ? `, used in ${key.uses} files elsewhere` : ""}`)] : []),
    ...(area.mainFiles.length > 0 ? ["Main files:", ...area.mainFiles.map((file) => `- ${file.path} (imported by ${file.usedBy} files)`)] : []),
    ...(found.explanation ? ["Explanation (written by an agent; verify):", found.explanation.body] : []),
  ].join("\n");
}

export class KnowledgeMcp {
  constructor(
    private readonly tokens: TokenAuthority,
    private readonly service: KnowledgeService,
  ) {}

  private build(scope: AgentScope): McpServer {
    const repo = projectRoot(scope.repoKey, scope.top);
    const mcp = new McpServer({ name: KNOWLEDGE_SERVER, version: "1.0.0" });
    const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
    const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });
    mcp.registerTool(
      "knowledge_search",
      {
        description:
          "Search this repository's own knowledge: architecture docs, conventions, ADRs (decision records), other docs, code symbols (functions, classes, methods, types), and summaries of tasks agents finished here. Ranked by relevance. Returns ids for knowledge_read.",
        inputSchema: {
          query: z.string().min(1).max(200),
          kinds: z.array(z.enum(KNOWLEDGE_KINDS)).max(KNOWLEDGE_KINDS.length).optional().describe("Limit to these kinds; all kinds when left out"),
          paths: z.array(z.string().min(1).max(300)).max(20).optional().describe("Limit to these files, folders, or globs (src/api/**), relative to the project root"),
          limit: z.number().int().min(1).max(20).optional(),
        },
      },
      async ({ query, kinds, paths, limit }) => {
        try {
          const hits = await this.service.search(repo, query, kinds ?? [], limit ?? 8, paths ?? []);
          return text(hits.length > 0 ? hits.map(describeHit).join("\n") : `Nothing in ${scope.repoKey} matches "${query}". Try other words, or fewer.`);
        } catch (error) {
          return failure(error);
        }
      },
    );
    mcp.registerTool(
      "knowledge_read",
      {
        description: "Read one entry found by knowledge_search: a document section, a code symbol's signature, or a finished task's request, files, commands, and outcome.",
        inputSchema: { id: z.string().min(1).max(600) },
      },
      async ({ id }) => {
        try {
          return text(describeEntry(await this.service.read(repo, id)));
        } catch (error) {
          return failure(error);
        }
      },
    );
    mcp.registerTool(
      "knowledge_outline",
      {
        description: "List one file's sections (documents) or functions, classes, methods, and types (code), with line numbers, to see what it holds before reading it. Given a main area's folder (from the project map), describe that area instead: what it uses, what uses it, its key names, and its main files.",
        inputSchema: { path: z.string().min(1).max(300).describe("A file path, or a main area's folder, relative to the project root") },
      },
      async ({ path }) => {
        try {
          const folder = path.replace(/^\.?\//, "").replace(/\/+$/, "");
          const facts = await this.service.structure(repo);
          if (facts.areas.some((area) => area.path === folder && folder !== "")) return text(describeArea(await this.service.area(repo, folder)));
          const outline = await this.service.outline(repo, path);
          return text(outline.length > 0 ? outline.map((entry) => `${entry.line}: ${entry.kind === "code" ? "" : "§ "}${entry.title}  [${entry.id}]`).join("\n") : `Nothing indexed for ${path}. It may be outside the index, too large, or not a document or code file.`);
        } catch (error) {
          return failure(error);
        }
      },
    );
    mcp.registerTool(
      "knowledge_history",
      {
        description: "List the finished tasks that changed a file or any file in a folder, newest first: what was asked, the outcome, and when.",
        inputSchema: { path: z.string().min(1).max(300).describe("A file or folder relative to the project root"), limit: z.number().int().min(1).max(20).optional() },
      },
      async ({ path, limit }) => {
        try {
          const tasks = await this.service.history(repo, path, limit ?? 8);
          return text(
            tasks.length > 0
              ? tasks.map((task) => `[${task.id}] ${task.endedAt.slice(0, 10)} ${task.generatedTitle ?? task.title} (${task.outcome})${task.needsCheck ? " [needs check: its files changed since]" : ""}${task.summary ? `\n  ${task.summary}` : ""}`).join("\n")
              : `No finished task changed ${path}.`,
          );
        } catch (error) {
          return failure(error);
        }
      },
    );
    return mcp;
  }

  listen(port: number): Promise<Server> {
    const http = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        console.error(`[contextualise] knowledge tool request failed: ${String(error)}`);
        if (!res.headersSent) res.writeHead(500).end("Internal error");
      });
    });
    return new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => {
        http.off("error", reject);
        resolve(http);
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== PATH) {
      res.writeHead(404).end(`Expected ${PATH}`);
      return;
    }
    // This server never pushes messages, so it refuses the long-lived GET event stream (allowed by
    // the MCP spec). An open stream would also keep the plugin from shutting down.
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end("Only POST is supported");
      return;
    }
    const scope = this.tokens.verify(req.headers.authorization);
    if (!scope) {
      res.writeHead(401).end("Knowledge token missing or not valid. Recreate the agent to get a new one.");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_REQUEST_BYTES) {
        res.writeHead(413).end(`Request larger than ${MAX_REQUEST_BYTES} bytes`);
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400).end("Expected a JSON-RPC request body");
      return;
    }
    const mcp = this.build(scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
