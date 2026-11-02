import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { areaLabel } from "../../shared/diagram";
import { type FileConnections, KNOWLEDGE_KINDS, KNOWLEDGE_TOOLS, type KnowledgeEntry, type KnowledgeTool, type SearchHit } from "../../shared/knowledge";
import type { AgentScope, TokenAuthority } from "./auth";
import { projectRoot } from "./git";
import type { Impact, KnowledgeService } from "./service";
import type { UsageLog } from "./usage";

// A distinctive name: permission requests are recognised by it, so a user's own server must not share it.
export const KNOWLEDGE_SERVER = "paseo-contextualise";
// Every tool the server offers. All of them only read the agent's own project, which is why the
// permission hook may approve them, and only them, by exact name.
export { KNOWLEDGE_TOOLS };

// Shown to the agent while the tools are still deferred behind tool search, so it knows when to load
// them. Kept short: Claude Code cuts server instructions at 4,096 characters.
// When to use the tools, said the same way in the project map and in the server's instructions.
export function whenToUseKnowledge(server: string): string {
  return `At the start of a task, search with knowledge_search (MCP server ${server}) for docs, decisions, and earlier work on the same area. Do this before reading docs or changing code. Open hits with knowledge_read; knowledge_outline and knowledge_history show a file's parts and past changes. Before changing code, knowledge_impact lists what uses those files and the tests to run. Use grep for exact code.`;
}
const INSTRUCTIONS = `This server holds this repository's own knowledge: architecture docs, conventions, ADRs (decisions, with status), other docs, code symbols, and what agents did here before (request, files, outcome). ${whenToUseKnowledge(KNOWLEDGE_SERVER)}`;
const tool = (name: KnowledgeTool) => name;
const PATH = "/mcp/knowledge";
const MAX_REQUEST_BYTES = 64 * 1024;

// `alwaysLoad` keeps Claude Code from deferring these tools behind tool search, so an agent can call
// them on its first turn. Paseo passes it to Claude only; its other providers drop the field.
export function knowledgeServerEntry(port: number, token: string) {
  return { [KNOWLEDGE_SERVER]: { type: "http" as const, url: `http://127.0.0.1:${port}${PATH}`, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } };
}

function describeHit(hit: SearchHit): string {
  const where = hit.kind === "task" ? (hit.path ? `touched ${hit.path}` : "") : `${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}`;
  return [
    `[${hit.id}] ${hit.kind}: ${hit.title}${where ? ` (${where})` : ""}${hit.needsCheck ? " [needs check: its source changed]" : ""}`,
    ...(hit.snippet ? [`  ${hit.snippet.replace(/\s+/g, " ").trim()}`] : []),
    ...(hit.relatedMemories.length > 0 ? [`  Memorise memories about this file (read with memory_read): ${hit.relatedMemories.map((memory) => `${memory.id} "${memory.subject}"`).join("; ")}`] : []),
  ].join("\n");
}

// Said with every list of linked files: what the links can and cannot see.
const LINKS_COVER = "(From imports the index resolves in TypeScript, JavaScript, Python, and Go; dynamic imports and path aliases are not seen, so check with grep before relying on \"none\".)";

const filesCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
const someFiles = (files: { paths: string[]; total: number }) => (files.total === 0 ? "none found" : `${files.paths.join(", ")}${files.total > files.paths.length ? `, and ${files.total - files.paths.length} more` : ""}`);

const NOT_FRESH = "The index is still being refreshed, or the last refresh failed, so these links may be incomplete.";

function describeConnections(connections: FileConnections): string[] {
  return [...(connections.fresh ? [] : [NOT_FRESH]), `Imports (in this project): ${someFiles(connections.imports)}`, `Used by: ${someFiles(connections.usedBy)}`, `Tests: ${someFiles(connections.tests)}`, LINKS_COVER];
}

function describeImpact(impact: Impact): string {
  if (!impact.codeIndexed) return "No code is indexed in this project, so there are no links to follow. Code indexing may be off (Contextualise settings > Include code).";
  return [
    ...(impact.fresh ? [] : [NOT_FRESH]),
    impact.changed.length > 0 ? `Changing ${filesCount(impact.changed.length)} of code: ${impact.changed.slice(0, 30).join(", ")}${impact.changed.length > 30 ? `, and ${impact.changed.length - 30} more` : ""}` : "None of these paths is an indexed code file.",
    ...(impact.unknown.length > 0 ? [`Not indexed (not code, ignored, or new since the last refresh): ${impact.unknown.join(", ")}`] : []),
    ...(impact.changed.length > 0
      ? [
          `Used directly by ${filesCount(impact.direct.total)}: ${someFiles(impact.direct)}`,
          `Used through those by ${filesCount(impact.further)} more.`,
          `Areas: ${impact.areas.length > 0 ? impact.areas.map(areaLabel).join(", ") : "none"}`,
          `Tests to run: ${someFiles(impact.tests)}`,
          LINKS_COVER,
        ]
      : []),
  ].join("\n");
}

function describeEntry(entry: KnowledgeEntry): string {
  return [
    `[${entry.id}] ${entry.kind}: ${entry.title}${entry.path ? ` (${entry.path}${entry.line > 0 ? `:${entry.line}` : ""})` : ""}`,
    ...(entry.needsCheck ? ["Needs check: its source changed since this was recorded."] : []),
    "Quoted from the repository; verify before relying on it:",
    entry.body,
    ...(entry.relatedMemories.length > 0 ? [`Memorise memories about this file (read with memory_read): ${entry.relatedMemories.map((memory) => `${memory.id} "${memory.subject}"`).join("; ")}`] : []),
    ...(entry.connections ? [`In ${entry.path}:`, ...describeConnections(entry.connections)] : []),
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

export const KNOWLEDGE_OFF = "Project knowledge is off. Turn it on in Settings > Contextualise.";

export class KnowledgeMcp {
  constructor(
    private readonly tokens: TokenAuthority,
    private readonly service: KnowledgeService,
    private readonly usage: Pick<UsageLog, "recordCall">,
    // While off, every tool answers that it is off, reading and counting nothing.
    private readonly knowledgeOn: () => Promise<boolean> = async () => true,
  ) {}

  private build(scope: AgentScope, agent: string): McpServer {
    const repo = projectRoot(scope.repoKey, scope.top);
    // Counting is advisory: it never delays or fails the call, and a failed count is logged.
    const count = (name: KnowledgeTool) =>
      this.usage.recordCall(scope.repoKey, name, agent).catch((error: unknown) => console.error(`[contextualise] could not count a ${name} call for ${scope.repoKey}: ${String(error)}`));
    const mcp = new McpServer({ name: KNOWLEDGE_SERVER, version: "1.0.0" }, { instructions: INSTRUCTIONS });
    const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
    const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });
    mcp.registerTool(
      tool("knowledge_search"),
      {
        description:
          "Search what this repository knows about itself: why things were decided (ADRs, with status), its conventions and architecture docs, other docs, and what agents did here before (request, files, outcome). Code symbols (functions, classes, types) are included but rank below the project's own writing; symbols in test files appear only when you ask for kinds [\"code\"] or pass paths. Use grep for exact code text. Returns ids for knowledge_read.",
        inputSchema: {
          query: z.string().min(1).max(200),
          kinds: z.array(z.enum(KNOWLEDGE_KINDS)).max(KNOWLEDGE_KINDS.length).optional().describe("Limit to these kinds; all kinds when left out (test-file symbols only with code)"),
          paths: z.array(z.string().min(1).max(300)).max(20).optional().describe("Limit to these files, folders, or globs (src/api/**), relative to the project root"),
          limit: z.number().int().min(1).max(20).optional(),
        },
      },
      async ({ query, kinds, paths, limit }) => {
        if (!(await this.knowledgeOn())) return failure(KNOWLEDGE_OFF);
        void count("knowledge_search");
        try {
          const hits = await this.service.search(repo, query, kinds ?? [], limit ?? 8, paths ?? []);
          return text(hits.length > 0 ? hits.map(describeHit).join("\n") : `Nothing in ${scope.repoKey} matches "${query}". Try other words, or fewer.`);
        } catch (error) {
          return failure(error);
        }
      },
    );
    mcp.registerTool(
      tool("knowledge_read"),
      {
        description: "Read one entry found by knowledge_search: a document section, a code symbol's signature, or a finished task's request, files, commands, and outcome.",
        inputSchema: { id: z.string().min(1).max(600) },
      },
      async ({ id }) => {
        if (!(await this.knowledgeOn())) return failure(KNOWLEDGE_OFF);
        void count("knowledge_read");
        try {
          return text(describeEntry(await this.service.read(repo, id, { connections: true })));
        } catch (error) {
          return failure(error);
        }
      },
    );
    mcp.registerTool(
      tool("knowledge_outline"),
      {
        description: "List one file's sections (documents) or functions, classes, methods, and types (code), with line numbers, to see what it holds before reading it. Given a main area's folder (from the project map), describe that area instead: what it uses, what uses it, its key names, and its main files.",
        inputSchema: { path: z.string().min(1).max(300).describe("A file path, or a main area's folder, relative to the project root") },
      },
      async ({ path }) => {
        if (!(await this.knowledgeOn())) return failure(KNOWLEDGE_OFF);
        void count("knowledge_outline");
        try {
          const folder = path.replace(/^\.?\//, "").replace(/\/+$/, "");
          const facts = await this.service.structure(repo);
          if (facts.areas.some((area) => area.path === folder && folder !== "")) return text(describeArea(await this.service.area(repo, folder)));
          const outline = await this.service.outline(repo, path);
          if (outline.length === 0) return text(`Nothing indexed for ${path}. It may be outside the index, too large, or not a document or code file.`);
          const parts = outline.map((entry) => `${entry.line}: ${entry.kind === "code" ? "" : "§ "}${entry.title}  [${entry.id}]`);
          return text([...parts, ...(outline.some((entry) => entry.kind === "code") ? ["", ...describeConnections(await this.service.connections(repo, path))] : [])].join("\n"));
        } catch (error) {
          return failure(error);
        }
      },
    );
    mcp.registerTool(
      tool("knowledge_history"),
      {
        description: "List the finished tasks that changed a file or any file in a folder, newest first: what was asked, the outcome, and when.",
        inputSchema: { path: z.string().min(1).max(300).describe("A file or folder relative to the project root"), limit: z.number().int().min(1).max(20).optional() },
      },
      async ({ path, limit }) => {
        if (!(await this.knowledgeOn())) return failure(KNOWLEDGE_OFF);
        void count("knowledge_history");
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
    mcp.registerTool(
      tool("knowledge_impact"),
      {
        description: "Before or after changing code: given files or folders, list the files that use them directly, how many more depend on those, the areas touched, and the test files to run.",
        inputSchema: { paths: z.array(z.string().min(1).max(300)).min(1).max(50).describe("Files or folders relative to the project root") },
      },
      async ({ paths }) => {
        if (!(await this.knowledgeOn())) return failure(KNOWLEDGE_OFF);
        void count("knowledge_impact");
        try {
          return text(describeImpact(await this.service.impact(repo, paths)));
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
    // Counted per agent: by the token's own agent id, or by the whole token for one minted before ids.
    const mcp = this.build(scope, scope.agent ?? req.headers.authorization ?? "");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
