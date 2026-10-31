import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identifierWords, KnowledgeStore, SEARCH_KIND_WEIGHTS, type TaskRecord } from "./store";

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "task:agent-1",
  agentId: "agent-1",
  provider: "claude",
  title: "Fix item refs",
  request: "Make parseItemRef accept bare Jira keys",
  outcome: "completed",
  files: ["shared/contracts.ts"],
  commands: [{ command: "npm test", exitCode: 0 }],
  startedAt: "2026-10-29T10:00:00.000Z",
  endedAt: "2026-10-29T10:30:00.000Z",
  citations: [{ path: "shared/contracts.ts", blob: "aaa" }],
  ...overrides,
});

describe("KnowledgeStore", () => {
  let dir: string;
  let store: KnowledgeStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "contextualise-store-"));
    store = new KnowledgeStore(join(dir, "index.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds document sections and code symbols, title matches first", () => {
    store.replaceSource({ path: "docs/adr/0001-use-sqlite.md", kind: "adr", blob: "b1", chunks: [{ title: "Use SQLite", body: "We store the index in SQLite.", line: 1 }], adr: { status: "accepted", supersededBy: null } });
    store.replaceSource({ path: "README.md", kind: "doc", blob: "b2", chunks: [{ title: "Setup", body: "Install node. SQLite comes with node.", line: 3 }] });
    store.replaceSource({ path: "shared/contracts.ts", kind: "code", blob: "b3", chunks: [], symbols: [{ name: "parseItemRef", kind: "function", line: 40, signature: "function parseItemRef(ref: string) {", params: 1, shape: "s" }] });
    expect(store.search("sqlite", { kinds: [], limit: 10 }).map((hit) => hit.id)).toEqual(["adr:docs/adr/0001-use-sqlite.md:1", "doc:README.md:3"]);
    expect(store.search("item ref", { kinds: [], limit: 10 })).toMatchObject([{ id: "code:shared/contracts.ts:40:parseItemRef", kind: "code", path: "shared/contracts.ts", line: 40, title: "parseItemRef" }]);
    expect(store.search("sqlite", { kinds: ["doc"], limit: 10 }).map((hit) => hit.kind)).toEqual(["doc"]);
    expect(store.read("code:shared/contracts.ts:40:parseItemRef")?.body).toContain("function parseItemRef(ref: string) {");
  });

  it("ranks the project's documents above code symbols that match the same words", () => {
    store.replaceSource({ path: "docs/retries.md", kind: "doc", blob: "b1", chunks: [{ title: "Retry", body: "How a failed job is retried: once, after a minute.", line: 1 }] });
    store.replaceSource({ path: "jobs/retry.ts", kind: "code", blob: "b2", chunks: [], symbols: [{ name: "retry", kind: "function", line: 3, signature: "function retry(job: Job) {", params: 1, shape: "s" }] });
    expect(store.search("retry", { kinds: [], limit: 5 }).map((hit) => hit.kind)).toEqual(["doc", "code"]);
  });

  it("weighs every kind above zero, so no kind can drop out of search", () => {
    expect(Object.values(SEARCH_KIND_WEIGHTS).every((weight) => weight > 0)).toBe(true);
  });

  it("falls back to any word when no entry has them all, and reads search syntax as words", () => {
    store.replaceSource({ path: "README.md", kind: "doc", blob: "b", chunks: [{ title: "Queues", body: "Workers drain the queue.", line: 1 }] });
    expect(store.search("queue postgres", { kinds: [], limit: 10 })).toHaveLength(1);
    expect(store.search('NEAR( "x" OR) *', { kinds: [], limit: 10 })).toEqual([]);
    expect(store.search("  ", { kinds: [], limit: 10 })).toEqual([]);
  });

  it("replaces a file's chunks and symbols, and removes them with the file", () => {
    store.replaceSource({ path: "a.ts", kind: "code", blob: "1", chunks: [], symbols: [{ name: "oldName", kind: "function", line: 1, signature: "function oldName() {", params: 0, shape: "s" }] });
    store.replaceSource({ path: "a.ts", kind: "code", blob: "2", chunks: [], symbols: [{ name: "newName", kind: "function", line: 1, signature: "function newName() {", params: 0, shape: "s" }] });
    expect(store.symbolsIn("a.ts").map((symbol) => symbol.name)).toEqual(["newName"]);
    expect(store.hasSymbol("oldName")).toBe(false);
    expect(store.indexedSources().get("a.ts")).toEqual({ kind: "code", blob: "2" });
    store.removeSource("a.ts");
    expect(store.search("new name", { kinds: [], limit: 10 })).toEqual([]);
    expect(store.indexedSources().size).toBe(0);
  });

  it("lists ADRs with status and each kind's titles and counts", () => {
    store.replaceSource({ path: "docs/adr/0002-queue.md", kind: "adr", blob: "b", chunks: [{ title: "Use a queue", body: "x", line: 1 }], adr: { status: "superseded", supersededBy: "0004-stream.md" } });
    store.replaceSource({ path: "ARCHITECTURE.md", kind: "architecture", blob: "b", chunks: [{ title: "Overview", body: "x", line: 1 }, { title: "Overview > Storage", body: "y", line: 9 }] });
    expect(store.adrs()).toEqual([{ path: "docs/adr/0002-queue.md", title: "Use a queue", status: "superseded", supersededBy: "0004-stream.md" }]);
    expect(store.titles("architecture")).toEqual([{ path: "ARCHITECTURE.md", title: "Overview" }]);
    expect(store.counts()).toMatchObject({ adr: 1, architecture: 2, task: 0 });
  });

  it("keeps tasks newest first, updates them in place, and finds them by request and file", () => {
    store.upsertTask(task());
    store.upsertTask(task({ id: "task:agent-2", agentId: "agent-2", title: "Queue docs", request: "Document the queue", files: ["docs/queue.md"], endedAt: "2026-10-29T11:00:00.000Z" }));
    store.upsertTask(task({ outcome: "failed" }));
    expect(store.tasks(10).map((record) => record.id)).toEqual(["task:agent-2", "task:agent-1"]);
    expect(store.task("task:agent-1")?.outcome).toBe("failed");
    expect(store.searchTasks("jira", 10).map((hit) => hit.task.id)).toEqual(["task:agent-1"]);
    expect(store.counts().task).toBe(2);
  });

  it("keeps every tracked file's blob", () => {
    store.setFileBlobs(new Map([["a.ts", "1"], ["package.json", "2"]]));
    store.setFileBlobs(new Map([["a.ts", "3"]]));
    expect(store.fileBlobs()).toEqual(new Map([["a.ts", "3"]]));
  });

  it("lists one kind in file order a page at a time, and resets file entries but keeps tasks and the brief", () => {
    for (const name of ["b.md", "a.md", "c.md"]) store.replaceSource({ path: `docs/${name}`, kind: "doc", blob: "x", chunks: [{ title: name, body: `About ${name}`, line: 1 }] });
    store.replaceSource({ path: "(brief)", kind: "brief", blob: "g", chunks: [{ title: "Project brief", body: "An API.", line: 1 }] });
    store.upsertTask(task());
    expect(store.browse("doc", 2, 0)).toMatchObject({ total: 3, entries: [{ path: "docs/a.md", body: "About a.md" }, { path: "docs/b.md" }] });
    expect(store.browse("doc", 2, 2).entries.map((entry) => entry.path)).toEqual(["docs/c.md"]);
    expect(store.tasks(1, 1)).toEqual([]);
    store.resetSources();
    expect(store.browse("doc", 10, 0).total).toBe(0);
    expect(store.browse("brief", 10, 0).total).toBe(1);
    expect(store.tasks(10)).toHaveLength(1);
  });

  it("splits identifiers into words", () => {
    expect(identifierWords("parseItemRef")).toBe("parse item ref");
    expect(identifierWords("HTTP_server-name")).toBe("http server name");
  });

  it("gives each part of a long section its own id, so a hit in a later part reads that part", () => {
    store.replaceSource({ path: "docs/big.md", kind: "doc", blob: "b", chunks: [{ title: "Big", body: "alpha words", line: 1 }, { title: "Big", body: "beta words", line: 1 }, { title: "Big", body: "gamma uniqueterm", line: 1 }] });
    const [hit] = store.search("uniqueterm", { kinds: ["doc"], limit: 5 });
    expect(hit.id).toBe("doc:docs/big.md:1#3");
    expect(store.read(hit.id)?.body).toBe("gamma uniqueterm");
    expect(store.read("doc:docs/big.md:1")?.body).toBe("alpha words");
    expect(new Set(store.browse("doc", 10, 0).entries.map((entry) => entry.id)).size).toBe(3);
  });
});

