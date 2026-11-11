import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { codeEntryBody, KNOWLEDGE_KINDS, type KnowledgeKind, type TaskSummary, taskSummarySchema } from "../../shared/knowledge";
import type { FileLink } from "./facts";
import type { AdrInfo, TextChunk } from "./sources";
import type { CodeImport, CodeSymbol } from "./symbols";

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
export const taskRecordSchema = taskSummarySchema.omit({ needsCheck: true }).extend({ citations: z.array(z.object({ path: z.string(), blob: z.string() })) });
export type TaskRecord = Omit<TaskSummary, "needsCheck"> & { citations: { path: string; blob: string }[] };

// 2: sections live in chunk_rows, indexed by path, id and kind; the full-text table only indexes them.
const SCHEMA_VERSION = "2";
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, blob TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, kind TEXT NOT NULL, blob TEXT NOT NULL, status TEXT, superseded_by TEXT);
  CREATE TABLE IF NOT EXISTS symbols (path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, signature TEXT NOT NULL, params INTEGER NOT NULL, shape TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS symbols_by_path ON symbols (path);
  CREATE TABLE IF NOT EXISTS imports (path TEXT NOT NULL, spec TEXT NOT NULL, names TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS imports_by_path ON imports (path);
  CREATE TABLE IF NOT EXISTS file_links (from_path TEXT NOT NULL, to_path TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS file_links_from ON file_links (from_path, kind);
  CREATE INDEX IF NOT EXISTS file_links_to ON file_links (to_path, kind);
  -- A file's sections and code symbols. Reads and deletes by path, id or kind use these indexes; a
  -- full-text table cannot index such columns, so finding them there reads every row.
  CREATE TABLE IF NOT EXISTS chunk_rows (n INTEGER PRIMARY KEY, id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS chunk_rows_by_path ON chunk_rows (path);
  CREATE INDEX IF NOT EXISTS chunk_rows_by_id ON chunk_rows (id);
  CREATE INDEX IF NOT EXISTS chunk_rows_by_kind ON chunk_rows (kind);
  -- The words of chunk_rows, kept in step by the triggers below (SQLite FTS5 "external content").
  -- Only searches (MATCH) read it; everything else reads chunk_rows.
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(id UNINDEXED, path UNINDEXED, kind UNINDEXED, line UNINDEXED, title, body, tokenize = 'unicode61', content = 'chunk_rows', content_rowid = 'n');
  CREATE TRIGGER IF NOT EXISTS chunk_rows_added AFTER INSERT ON chunk_rows BEGIN
    INSERT INTO chunks (rowid, id, path, kind, line, title, body) VALUES (new.n, new.id, new.path, new.kind, new.line, new.title, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS chunk_rows_removed AFTER DELETE ON chunk_rows BEGIN
    INSERT INTO chunks (chunks, rowid, id, path, kind, line, title, body) VALUES ('delete', old.n, old.id, old.path, old.kind, old.line, old.title, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS chunk_rows_changed AFTER UPDATE ON chunk_rows BEGIN
    INSERT INTO chunks (chunks, rowid, id, path, kind, line, title, body) VALUES ('delete', old.n, old.id, old.path, old.kind, old.line, old.title, old.body);
    INSERT INTO chunks (rowid, id, path, kind, line, title, body) VALUES (new.n, new.id, new.path, new.kind, new.line, new.title, new.body);
  END;
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, ended_at TEXT NOT NULL, record TEXT NOT NULL);
  CREATE VIRTUAL TABLE IF NOT EXISTS tasks_text USING fts5(id UNINDEXED, title, request, files, tokenize = 'unicode61');
`;
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
// How much a match counts per kind of entry. bm25 scores are negative (lower is better), so a larger
// weight ranks a kind higher; every weight is above zero, so no kind drops out. Grep already finds
// code; what only this index holds is the project's docs, decisions, and conventions.
export const SEARCH_KIND_WEIGHTS: Readonly<Record<Exclude<KnowledgeKind, "task">, number>> = { brief: 2, architecture: 2, adr: 2, convention: 2, doc: 1.5, code: 1 };
const KIND_WEIGHT_SQL = `(CASE kind ${Object.entries(SEARCH_KIND_WEIGHTS).map(([kind, weight]) => `WHEN '${kind}' THEN ${weight}`).join(" ")} ELSE 1 END)`;

export class KnowledgeStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const version = this.getMeta("schema");
    if (version === "1") this.upgradeFromSchema1();
    else if (version !== null && version !== SCHEMA_VERSION) throw new Error(`Knowledge index ${file} has schema ${version}; expected ${SCHEMA_VERSION}`);
    this.db.exec(SCHEMA);
    this.setMeta("schema", SCHEMA_VERSION);
  }

  // Schema 1 kept sections in the full-text table itself, so removing one file's sections read every
  // section of the project (46 ms a file in a 236,000-section index). The written entries (the brief,
  // area notes) move to chunk_rows; entries read from files are dropped and read again by the next
  // refresh, which yields to other work, rather than copied here while nothing else can run.
  private upgradeFromSchema1(): void {
    this.transaction(() => {
      const written = this.db.prepare("SELECT id, path, kind, line, title, body FROM chunks WHERE path LIKE '(%'").all() as { id: string; path: string; kind: string; line: number; title: string; body: string }[];
      this.db.exec("DROP TABLE chunks");
      this.db.exec(SCHEMA);
      const insert = this.db.prepare("INSERT INTO chunk_rows (id, path, kind, line, title, body) VALUES (?, ?, ?, ?, ?, ?)");
      for (const row of written) insert.run(row.id, row.path, row.kind, row.line, row.title, row.body);
      this.clearFileEntries();
      this.setMeta("schema", SCHEMA_VERSION);
    });
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

  replaceSource(source: { path: string; kind: KnowledgeKind; blob: string; chunks: readonly TextChunk[]; symbols?: readonly CodeSymbol[]; imports?: readonly CodeImport[]; adr?: AdrInfo }): void {
    this.transaction(() => {
      this.deleteSource(source.path);
      this.db.prepare("INSERT INTO sources (path, kind, blob, status, superseded_by) VALUES (?, ?, ?, ?, ?)").run(source.path, source.kind, source.blob, source.adr?.status ?? null, source.adr?.supersededBy ?? null);
      const chunk = this.db.prepare("INSERT INTO chunk_rows (id, path, kind, line, title, body) VALUES (?, ?, ?, ?, ?, ?)");
      // A long section is stored in several parts that start on the same line; the first keeps the
      // plain id, later ones get #2, #3, so every part can be read and pinned on its own.
      const parts = new Map<number, number>();
      for (const part of source.chunks) {
        const count = (parts.get(part.line) ?? 0) + 1;
        parts.set(part.line, count);
        chunk.run(`${source.kind}:${source.path}:${part.line}${count > 1 ? `#${count}` : ""}`, source.path, source.kind, part.line, part.title, part.body);
      }
      const symbol = this.db.prepare("INSERT INTO symbols (path, name, kind, line, signature, params, shape) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const found of source.symbols ?? []) {
        symbol.run(source.path, found.name, found.kind, found.line, found.signature, found.params, found.shape);
        chunk.run(`code:${source.path}:${found.line}:${found.name}`, source.path, "code", found.line, found.name, codeEntryBody({ kind: found.kind, name: found.name, words: identifierWords(found.name), signature: found.signature }));
      }
      const imported = this.db.prepare("INSERT INTO imports (path, spec, names) VALUES (?, ?, ?)");
      for (const entry of source.imports ?? []) imported.run(source.path, entry.spec, JSON.stringify(entry.names));
    });
  }

  private deleteSource(path: string): void {
    for (const table of ["sources", "chunk_rows", "symbols", "imports"]) this.db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(path);
    if (!path.startsWith("(")) this.bumpSourcesRevision();
  }

  // Changes with every write of a project file's entries, in the same transaction, so facts built
  // from an older state are known to be old even when a refresh stopped before rebuilding them.
  // Written entries ("(area)/..." and the brief) do not count: facts do not read them.
  private bumpSourcesRevision(): void {
    this.setMeta("sourcesRevision", String(Number(this.sourcesRevision()) + 1));
  }

  sourcesRevision(): string {
    return this.getMeta("sourcesRevision") ?? "0";
  }

  removeSource(path: string): void {
    this.transaction(() => this.deleteSource(path));
  }

  symbolsIn(path: string): CodeSymbol[] {
    return this.db.prepare("SELECT name, kind, line, signature, params, shape FROM symbols WHERE path = ? ORDER BY line").all(path) as unknown as CodeSymbol[];
  }

  // Every code file with its definitions and imports: the input of the project's facts.
  codeFiles(): { path: string; symbols: Pick<CodeSymbol, "name" | "kind" | "line">[]; imports: CodeImport[] }[] {
    const files = new Map<string, { path: string; symbols: Pick<CodeSymbol, "name" | "kind" | "line">[]; imports: CodeImport[] }>();
    for (const { path } of this.db.prepare("SELECT path FROM sources WHERE kind = 'code' ORDER BY path").all() as { path: string }[]) files.set(path, { path, symbols: [], imports: [] });
    for (const row of this.db.prepare("SELECT path, name, kind, line FROM symbols ORDER BY path, line").all() as { path: string; name: string; kind: string; line: number }[]) {
      files.get(row.path)?.symbols.push({ name: row.name, kind: row.kind, line: Number(row.line) });
    }
    for (const row of this.db.prepare("SELECT path, spec, names FROM imports").all() as { path: string; spec: string; names: string }[]) {
      files.get(row.path)?.imports.push({ spec: row.spec, names: JSON.parse(row.names) as string[] });
    }
    return [...files.values()];
  }

  // Indexed files that are not code or generated, with each file's first heading, in path order.
  documents(limit: number): { id: string; kind: KnowledgeKind; path: string; title: string }[] {
    return this.db
      .prepare(
        `SELECT c.id AS id, c.kind AS kind, c.path AS path, c.title AS title FROM chunk_rows c JOIN sources s ON s.path = c.path
         WHERE s.kind NOT IN ('code', 'brief') AND CAST(c.line AS INTEGER) = (SELECT MIN(CAST(line AS INTEGER)) FROM chunk_rows WHERE path = s.path)
         ORDER BY s.path LIMIT ?`,
      )
      .all(limit) as { id: string; kind: KnowledgeKind; path: string; title: string }[];
  }

  hasSymbol(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM symbols WHERE name = ? LIMIT 1").get(name) !== undefined;
  }

  adrs(): { path: string; title: string; status: string | null; supersededBy: string | null }[] {
    return this.db
      .prepare(
        `SELECT s.path AS path, s.status AS status, s.superseded_by AS supersededBy,
          COALESCE((SELECT title FROM chunk_rows c WHERE c.path = s.path ORDER BY CAST(c.line AS INTEGER) LIMIT 1), s.path) AS title
         FROM sources s WHERE s.kind = 'adr' ORDER BY s.path`,
      )
      .all() as { path: string; title: string; status: string | null; supersededBy: string | null }[];
  }

  // The first heading of each file of a kind, for the project map.
  titles(kind: KnowledgeKind): { path: string; title: string }[] {
    return this.db
      .prepare(`SELECT s.path AS path, COALESCE((SELECT title FROM chunk_rows c WHERE c.path = s.path ORDER BY CAST(c.line AS INTEGER) LIMIT 1), s.path) AS title FROM sources s WHERE s.kind = ? ORDER BY s.path`)
      .all(kind) as { path: string; title: string }[];
  }

  counts(): Record<KnowledgeKind, number> {
    const counts = Object.fromEntries(KNOWLEDGE_KINDS.map((kind) => [kind, 0])) as Record<KnowledgeKind, number>;
    for (const row of this.db.prepare("SELECT kind, COUNT(*) AS n FROM chunk_rows GROUP BY kind").all() as { kind: KnowledgeKind; n: number }[]) counts[row.kind] = row.n;
    counts.task = (this.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    return counts;
  }

  // All words must match; when nothing does, any word may. Title matches rank above body matches, and
  // at an equal match the project's own writing ranks above code symbols (SEARCH_KIND_WEIGHTS).
  // `keep` drops hits the caller cannot use (a path filter, test files); the best `limit` kept hits come back.
  search(text: string, options: { kinds: readonly KnowledgeKind[]; limit: number; keep?: (hit: StoredHit) => boolean }): StoredHit[] {
    const kinds = options.kinds.filter((kind) => kind !== "task");
    if (options.kinds.length > 0 && kinds.length === 0) return [];
    const filter = kinds.length > 0 ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
    const statement = this.db.prepare(`SELECT id, kind, path, line, title, snippet(chunks, 5, '', '', ' … ', 24) AS snippet FROM chunks WHERE chunks MATCH ? ${filter} ORDER BY bm25(chunks, 0, 0, 0, 0, 5.0, 1.0) * ${KIND_WEIGHT_SQL} LIMIT ?`);
    return matching(text, options.limit, options.keep ?? (() => true), (query, count) =>
      (statement.all(query, ...kinds, count) as unknown as StoredHit[]).map((row) => ({ ...row, line: Number(row.line) })),
    );
  }

  // A file's sections or code symbols in line order.
  outline(path: string): { id: string; kind: KnowledgeKind; title: string; line: number }[] {
    const rows = this.db.prepare("SELECT id, kind, title, line FROM chunk_rows WHERE path = ?").all(path) as unknown as { id: string; kind: KnowledgeKind; title: string; line: number }[];
    return rows.map((row) => ({ ...row, line: Number(row.line) })).sort((a, b) => a.line - b.line);
  }

  // Every document of these kinds with its sections in file order, by path. A long section is stored
  // in parts under one line, kept in the order they were written.
  documentsOf(kinds: readonly KnowledgeKind[]): Map<string, { kind: KnowledgeKind; sections: { title: string; body: string }[] }> {
    const documents = new Map<string, { kind: KnowledgeKind; sections: { title: string; body: string }[] }>();
    if (kinds.length === 0) return documents;
    const rows = this.db
      .prepare(`SELECT path, kind, title, body FROM chunk_rows WHERE kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY path, CAST(line AS INTEGER), n`)
      .all(...kinds) as { path: string; kind: KnowledgeKind; title: string; body: string }[];
    for (const row of rows) {
      const document = documents.get(row.path) ?? { kind: row.kind, sections: [] };
      document.sections.push({ title: row.title, body: row.body });
      documents.set(row.path, document);
    }
    return documents;
  }

  // The text of each of these entries.
  bodies(ids: readonly string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const rows = this.db.prepare(`SELECT id, body FROM chunk_rows WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as { id: string; body: string }[];
    return new Map(rows.map((row) => [row.id, row.body]));
  }

  read(id: string): StoredEntry | null {
    const row = this.db.prepare("SELECT id, kind, path, line, title, body FROM chunk_rows WHERE id = ?").get(id) as unknown as StoredEntry | undefined;
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

  // Tasks that ended at or after `since` (ISO time), newest first.
  tasksSince(since: string): TaskRecord[] {
    return (this.db.prepare("SELECT record FROM tasks WHERE ended_at >= ? ORDER BY ended_at DESC").all(since) as { record: string }[]).map((row) => JSON.parse(row.record) as TaskRecord);
  }

  isCode(path: string): boolean {
    return this.db.prepare("SELECT 1 FROM sources WHERE path = ? AND kind = 'code'").get(path) !== undefined;
  }

  tasks(limit: number, offset = 0): TaskRecord[] {
    return (this.db.prepare("SELECT record FROM tasks ORDER BY ended_at DESC LIMIT ? OFFSET ?").all(limit, offset) as { record: string }[]).map((row) => JSON.parse(row.record) as TaskRecord);
  }

  // Every entry of one kind, in file order, a page at a time: what the screen lists without a search.
  browse(kind: Exclude<KnowledgeKind, "task">, limit: number, offset: number): { entries: StoredEntry[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM chunk_rows WHERE kind = ?").get(kind) as { n: number }).n;
    const rows = this.db
      .prepare("SELECT id, kind, path, line, title, substr(body, 1, 200) AS body FROM chunk_rows WHERE kind = ? ORDER BY path, CAST(line AS INTEGER) LIMIT ? OFFSET ?")
      .all(kind, limit, offset) as unknown as StoredEntry[];
    return { entries: rows.map((row) => ({ ...row, line: Number(row.line) })), total };
  }

  // The files holding one kind's entries and how many each holds, in path order.
  files(kind: Exclude<KnowledgeKind, "task">, limit: number): { files: { path: string; count: number }[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(DISTINCT path) AS n FROM chunk_rows WHERE kind = ?").get(kind) as { n: number }).n;
    const files = this.db.prepare("SELECT path, COUNT(*) AS count FROM chunk_rows WHERE kind = ? GROUP BY path ORDER BY path LIMIT ?").all(kind, limit) as { path: string; count: number }[];
    return { files: files.map((file) => ({ path: file.path, count: Number(file.count) })), total };
  }

  // One file's entries of one kind, in line order, with the first `bodyChars` of each body.
  fileEntries(path: string, kind: Exclude<KnowledgeKind, "task">, limit: number, bodyChars = 200): { entries: StoredEntry[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM chunk_rows WHERE path = ? AND kind = ?").get(path, kind) as { n: number }).n;
    const rows = this.db
      .prepare("SELECT id, kind, path, line, title, substr(body, 1, ?) AS body FROM chunk_rows WHERE path = ? AND kind = ? ORDER BY CAST(line AS INTEGER), id LIMIT ?")
      .all(bodyChars, path, kind, limit) as unknown as StoredEntry[];
    return { entries: rows.map((row) => ({ ...row, line: Number(row.line) })), total };
  }

  // Drops everything indexed from files, keeping tasks: the next refresh reads every file again.
  // Used when the way files are read changes, so old entries do not keep old titles.
  resetSources(): void {
    this.transaction(() => this.clearFileEntries());
  }

  private clearFileEntries(): void {
    for (const table of ["sources", "chunk_rows", "symbols", "imports", "files"]) this.db.exec(`DELETE FROM ${table} WHERE path NOT LIKE '(%'`);
    this.db.exec("DELETE FROM file_links");
    this.bumpSourcesRevision();
  }

  // The links between code files, replaced together with the facts they were built with.
  replaceFileLinks(links: readonly FileLink[]): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM file_links");
      const insert = this.db.prepare("INSERT INTO file_links (from_path, to_path, kind) VALUES (?, ?, ?)");
      for (const link of links) insert.run(link.from, link.to, link.kind);
    });
  }

  // Files `path` links to (`from`) or that link to it (`to`), by kind, sorted.
  linkedFiles(path: string, direction: "from" | "to", kind: FileLink["kind"]): string[] {
    const [match, other] = direction === "from" ? ["from_path", "to_path"] : ["to_path", "from_path"];
    return (this.db.prepare(`SELECT DISTINCT ${other} AS path FROM file_links WHERE ${match} = ? AND kind = ? ORDER BY ${other}`).all(path, kind) as { path: string }[]).map((row) => row.path);
  }

  hasCode(): boolean {
    return this.db.prepare("SELECT 1 FROM sources WHERE kind = 'code' LIMIT 1").get() !== undefined;
  }

  // Indexed code files: the given file itself, every one under the given folder, or all for "".
  codeFilesUnder(path: string): string[] {
    const folder = path.replace(/\/+$/, "");
    if (folder === "") return (this.db.prepare("SELECT path FROM sources WHERE kind = 'code' ORDER BY path").all() as { path: string }[]).map((row) => row.path);
    // Paths under folder/ sort from "folder/" up to "folder0", the character after "/".
    return (this.db.prepare("SELECT path FROM sources WHERE kind = 'code' AND (path = ? OR (path >= ? AND path < ?)) ORDER BY path").all(folder, `${folder}/`, `${folder}0`) as { path: string }[]).map((row) => row.path);
  }

  task(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT record FROM tasks WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as TaskRecord) : null;
  }

  searchTasks(text: string, limit: number, keep: (hit: { task: TaskRecord; snippet: string }) => boolean = () => true): { task: TaskRecord; snippet: string }[] {
    const statement = this.db.prepare("SELECT t.record AS record, snippet(tasks_text, 2, '', '', ' … ', 24) AS snippet FROM tasks_text JOIN tasks t ON t.id = tasks_text.id WHERE tasks_text MATCH ? ORDER BY bm25(tasks_text, 0, 5.0, 1.0, 2.0) LIMIT ?");
    return matching(text, limit, keep, (query, count) => (statement.all(query, count) as { record: string; snippet: string }[]).map((row) => ({ task: JSON.parse(row.record) as TaskRecord, snippet: row.snippet })));
  }
}

// The best `limit` ranked rows that `keep` accepts: all words first, any word when none of those is kept.
// The window grows until enough rows are kept or every match was read, so a filter that drops most of
// the top matches still fills the limit.
function matching<Row>(text: string, limit: number, keep: (row: Row) => boolean, rows: (query: string, count: number) => Row[]): Row[] {
  for (const join of ["AND", "OR"] as const) {
    const query = ftsQuery(text, join);
    if (!query) return [];
    for (let count = Math.max(limit, 1) * 5; ; count *= 4) {
      const page = rows(query, count);
      const kept = page.filter(keep);
      if (kept.length >= limit || page.length < count) {
        if (kept.length > 0 || join === "OR") return kept.slice(0, limit);
        break;
      }
    }
  }
  return [];
}
