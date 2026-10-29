import { DatabaseSync } from "node:sqlite";
import { KNOWLEDGE_KINDS, type KnowledgeKind, type TaskSummary } from "../../shared/knowledge";
import type { AdrInfo, TextChunk } from "./sources";
import type { CodeSymbol } from "./symbols";

export interface StoredHit {
  id: string;
  kind: KnowledgeKind;
  path: string;
  line: number;
  title: string;
  snippet: string;
}

export interface StoredEntry extends Omit<StoredHit, "snippet"> {
  body: string;
}

// A finished task as stored: its summary, plus each changed file's git blob at the time, so a later
// change to that file marks the task "needs check".
export type TaskRecord = Omit<TaskSummary, "needsCheck"> & { citations: { path: string; blob: string }[] };

const SCHEMA_VERSION = "1";
export { BRIEF_ID } from "../../shared/knowledge";

// Splits camelCase and snake_case so "parseItemRef" is found by "item" and "parse ref".
export function identifierWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

// Every word becomes a quoted prefix term, so user text can never be read as FTS5 syntax.
function ftsQuery(text: string, join: "AND" | "OR"): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length === 0 ? null : words.map((word) => `"${word}"*`).join(` ${join} `);
}

// One SQLite file per repository. Everything but tasks is a cache of the repository's files and is
// rebuilt when lost; tasks are also kept in tasks.jsonl beside it (see KnowledgeBase).
export class KnowledgeStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, blob TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, kind TEXT NOT NULL, blob TEXT NOT NULL, status TEXT, superseded_by TEXT);
      CREATE TABLE IF NOT EXISTS symbols (path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, signature TEXT NOT NULL, params INTEGER NOT NULL, shape TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS symbols_by_path ON symbols (path);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(id UNINDEXED, path UNINDEXED, kind UNINDEXED, line UNINDEXED, title, body, tokenize = 'unicode61');
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, ended_at TEXT NOT NULL, record TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_text USING fts5(id UNINDEXED, title, request, files, tokenize = 'unicode61');
    `);
    const version = this.getMeta("schema");
    if (version !== null && version !== SCHEMA_VERSION) throw new Error(`Knowledge index ${file} has schema ${version}; expected ${SCHEMA_VERSION}`);
    this.setMeta("schema", SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Every tracked file's blob, indexed or not: a task's citations can name any file.
  fileBlobs(): Map<string, string> {
    const rows = this.db.prepare("SELECT path, blob FROM files").all() as { path: string; blob: string }[];
    return new Map(rows.map((row) => [row.path, row.blob]));
  }

  setFileBlobs(blobs: ReadonlyMap<string, string>): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM files");
      const insert = this.db.prepare("INSERT INTO files (path, blob) VALUES (?, ?)");
      for (const [path, blob] of blobs) insert.run(path, blob);
    });
  }

  indexedSources(): Map<string, { kind: KnowledgeKind; blob: string }> {
    const rows = this.db.prepare("SELECT path, kind, blob FROM sources").all() as { path: string; kind: KnowledgeKind; blob: string }[];
    return new Map(rows.map((row) => [row.path, { kind: row.kind, blob: row.blob }]));
  }

  replaceSource(source: { path: string; kind: KnowledgeKind; blob: string; chunks: readonly TextChunk[]; symbols?: readonly CodeSymbol[]; adr?: AdrInfo }): void {
    this.transaction(() => {
      this.deleteSource(source.path);
      this.db.prepare("INSERT INTO sources (path, kind, blob, status, superseded_by) VALUES (?, ?, ?, ?, ?)").run(source.path, source.kind, source.blob, source.adr?.status ?? null, source.adr?.supersededBy ?? null);
      const chunk = this.db.prepare("INSERT INTO chunks (id, path, kind, line, title, body) VALUES (?, ?, ?, ?, ?, ?)");
      for (const part of source.chunks) chunk.run(`${source.kind}:${source.path}:${part.line}`, source.path, source.kind, part.line, part.title, part.body);
      const symbol = this.db.prepare("INSERT INTO symbols (path, name, kind, line, signature, params, shape) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const found of source.symbols ?? []) {
        symbol.run(source.path, found.name, found.kind, found.line, found.signature, found.params, found.shape);
        chunk.run(`code:${source.path}:${found.line}:${found.name}`, source.path, "code", found.line, found.name, `${found.kind} ${found.name} (${identifierWords(found.name)})\n${found.signature}`);
      }
    });
  }

  private deleteSource(path: string): void {
    for (const table of ["sources", "chunks", "symbols"]) this.db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(path);
  }

  removeSource(path: string): void {
    this.transaction(() => this.deleteSource(path));
  }

  symbolsIn(path: string): CodeSymbol[] {
    return this.db.prepare("SELECT name, kind, line, signature, params, shape FROM symbols WHERE path = ? ORDER BY line").all(path) as unknown as CodeSymbol[];
  }

  hasSymbol(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM symbols WHERE name = ? LIMIT 1").get(name) !== undefined;
  }

  adrs(): { path: string; title: string; status: string | null; supersededBy: string | null }[] {
    return this.db
      .prepare(
        `SELECT s.path AS path, s.status AS status, s.superseded_by AS supersededBy,
          (SELECT title FROM chunks c WHERE c.path = s.path ORDER BY CAST(c.line AS INTEGER) LIMIT 1) AS title
         FROM sources s WHERE s.kind = 'adr' ORDER BY s.path`,
      )
      .all() as { path: string; title: string; status: string | null; supersededBy: string | null }[];
  }

  // The first heading of each file of a kind, for the project map.
  titles(kind: KnowledgeKind): { path: string; title: string }[] {
    return this.db
      .prepare(`SELECT s.path AS path, (SELECT title FROM chunks c WHERE c.path = s.path ORDER BY CAST(c.line AS INTEGER) LIMIT 1) AS title FROM sources s WHERE s.kind = ? ORDER BY s.path`)
      .all(kind) as { path: string; title: string }[];
  }

  counts(): Record<KnowledgeKind, number> {
    const counts = Object.fromEntries(KNOWLEDGE_KINDS.map((kind) => [kind, 0])) as Record<KnowledgeKind, number>;
    for (const row of this.db.prepare("SELECT kind, COUNT(*) AS n FROM chunks GROUP BY kind").all() as { kind: KnowledgeKind; n: number }[]) counts[row.kind] = row.n;
    counts.task = (this.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    return counts;
  }

  // All words must match; when nothing does, any word may. Title matches rank above body matches.
  search(text: string, options: { kinds: readonly KnowledgeKind[]; limit: number }): StoredHit[] {
    const kinds = options.kinds.filter((kind) => kind !== "task");
    if (options.kinds.length > 0 && kinds.length === 0) return [];
    for (const join of ["AND", "OR"] as const) {
      const query = ftsQuery(text, join);
      if (!query) return [];
      const filter = kinds.length > 0 ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
      const rows = this.db
        .prepare(`SELECT id, kind, path, line, title, snippet(chunks, 5, '', '', ' … ', 24) AS snippet FROM chunks WHERE chunks MATCH ? ${filter} ORDER BY bm25(chunks, 0, 0, 0, 0, 5.0, 1.0) LIMIT ?`)
        .all(query, ...kinds, options.limit) as unknown as StoredHit[];
      if (rows.length > 0 || join === "OR") return rows.map((row) => ({ ...row, line: Number(row.line) }));
    }
    return [];
  }

  // A file's sections or code symbols in line order.
  outline(path: string): { id: string; kind: KnowledgeKind; title: string; line: number }[] {
    const rows = this.db.prepare("SELECT id, kind, title, line FROM chunks WHERE path = ?").all(path) as unknown as { id: string; kind: KnowledgeKind; title: string; line: number }[];
    return rows.map((row) => ({ ...row, line: Number(row.line) })).sort((a, b) => a.line - b.line);
  }

  read(id: string): StoredEntry | null {
    const row = this.db.prepare("SELECT id, kind, path, line, title, body FROM chunks WHERE id = ?").get(id) as unknown as StoredEntry | undefined;
    return row ? { ...row, line: Number(row.line) } : null;
  }

  sourceStatus(path: string): { status: string | null; supersededBy: string | null } | null {
    return (this.db.prepare("SELECT status, superseded_by AS supersededBy FROM sources WHERE path = ?").get(path) as { status: string | null; supersededBy: string | null } | undefined) ?? null;
  }

  upsertTask(task: TaskRecord): void {
    this.transaction(() => {
      this.db.prepare("INSERT INTO tasks (id, ended_at, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET ended_at = excluded.ended_at, record = excluded.record").run(task.id, task.endedAt, JSON.stringify(task));
      this.db.prepare("DELETE FROM tasks_text WHERE id = ?").run(task.id);
      this.db.prepare("INSERT INTO tasks_text (id, title, request, files) VALUES (?, ?, ?, ?)").run(task.id, task.title, task.request, task.files.join(" "));
    });
  }

  tasks(limit: number, offset = 0): TaskRecord[] {
    return (this.db.prepare("SELECT record FROM tasks ORDER BY ended_at DESC LIMIT ? OFFSET ?").all(limit, offset) as { record: string }[]).map((row) => JSON.parse(row.record) as TaskRecord);
  }

  // Every entry of one kind, in file order, a page at a time: what the screen lists without a search.
  browse(kind: Exclude<KnowledgeKind, "task">, limit: number, offset: number): { entries: StoredEntry[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = ?").get(kind) as { n: number }).n;
    const rows = this.db
      .prepare("SELECT id, kind, path, line, title, substr(body, 1, 200) AS body FROM chunks WHERE kind = ? ORDER BY path, CAST(line AS INTEGER) LIMIT ? OFFSET ?")
      .all(kind, limit, offset) as unknown as StoredEntry[];
    return { entries: rows.map((row) => ({ ...row, line: Number(row.line) })), total };
  }

  // Drops everything indexed from files, keeping tasks: the next refresh reads every file again.
  // Used when the way files are read changes, so old entries do not keep old titles.
  resetSources(): void {
    this.transaction(() => {
      for (const table of ["sources", "chunks", "symbols", "files"]) this.db.exec(`DELETE FROM ${table} WHERE path NOT LIKE '(%'`);
    });
  }

  task(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT record FROM tasks WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as TaskRecord) : null;
  }

  searchTasks(text: string, limit: number): { task: TaskRecord; snippet: string }[] {
    for (const join of ["AND", "OR"] as const) {
      const query = ftsQuery(text, join);
      if (!query) return [];
      const rows = this.db
        .prepare("SELECT t.record AS record, snippet(tasks_text, 2, '', '', ' … ', 24) AS snippet FROM tasks_text JOIN tasks t ON t.id = tasks_text.id WHERE tasks_text MATCH ? ORDER BY bm25(tasks_text, 0, 5.0, 1.0, 2.0) LIMIT ?")
        .all(query, limit) as { record: string; snippet: string }[];
      if (rows.length > 0 || join === "OR") return rows.map((row) => ({ task: JSON.parse(row.record) as TaskRecord, snippet: row.snippet }));
    }
    return [];
  }
}
