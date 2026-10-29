import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Project } from "../../shared/knowledge";
import { type GitRepo, readGitRepo } from "./git";
import { type IndexChange, indexRepo } from "./indexer";
import { KnowledgeStore, type TaskRecord } from "./store";
import type { SymbolReader } from "./symbols";

// How long an index counts as current before the next use compares blobs again, so a burst of
// searches runs git once.
export const FRESH_MS = 30_000;
const REPO_CACHE_MS = 60_000;

export interface KnowledgeBaseDeps {
  root: () => Promise<string>;
  symbols: SymbolReader;
  codeSymbols: () => Promise<boolean>;
  // Called after each re-index that changed something; failures are logged, never thrown.
  onChanges?: (repo: GitRepo, store: KnowledgeStore, changes: IndexChange[]) => Promise<void>;
  now?: () => number;
}

interface Opened {
  repo: GitRepo;
  store: KnowledgeStore;
}

// The per-repository indexes of this daemon. One re-index per repository runs at a time; a caller
// that cannot wait (agent creation) gets "updating" and the run finishes in the background.
export class KnowledgeBase {
  private readonly opened = new Map<string, Opened>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly freshUntil = new Map<string, number>();
  private readonly problems = new Map<string, string>();
  private readonly repos = new Map<string, { repo: GitRepo | null; at: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: KnowledgeBaseDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async dir(): Promise<string> {
    const dir = join(await this.deps.root(), "knowledge");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private static fileName(repoKey: string): string {
    return createHash("sha256").update(repoKey).digest("hex").slice(0, 32);
  }

  async repoFor(cwd: string): Promise<GitRepo | null> {
    const cached = this.repos.get(cwd);
    if (cached && this.now() - cached.at < REPO_CACHE_MS) return cached.repo;
    const repo = await readGitRepo(cwd);
    this.repos.set(cwd, { repo, at: this.now() });
    return repo;
  }

  async open(repo: GitRepo): Promise<KnowledgeStore> {
    const known = this.opened.get(repo.key);
    if (known) {
      if (known.repo.top !== repo.top) known.store.setMeta("top", repo.top);
      known.repo = repo;
      return known.store;
    }
    const dir = await this.dir();
    const name = KnowledgeBase.fileName(repo.key);
    const store = new KnowledgeStore(join(dir, `${name}.sqlite`));
    store.setMeta("repoKey", repo.key);
    store.setMeta("top", repo.top);
    // The index is a cache, but tasks are not: a lost or reset index gets them back from the log.
    if (store.counts().task === 0) {
      const log = await readFile(join(dir, `${name}.tasks.jsonl`), "utf8").catch(() => "");
      for (const line of log.split("\n").filter(Boolean)) {
        try {
          store.upsertTask(JSON.parse(line) as TaskRecord);
        } catch (error) {
          console.error(`[contextualise] skipped an unreadable task log line for ${repo.key}: ${String(error)}`);
        }
      }
    }
    this.opened.set(repo.key, { repo, store });
    return store;
  }

  // Resolves when the index is current, or after `maxWaitMs` with "updating" while it carries on.
  async refresh(repo: GitRepo, maxWaitMs: number): Promise<"fresh" | "updating"> {
    if ((this.freshUntil.get(repo.key) ?? 0) > this.now()) return "fresh";
    let run = this.running.get(repo.key);
    if (!run) {
      run = (async () => {
        const store = await this.open(repo);
        const changes = await indexRepo(repo, store, { symbols: this.deps.symbols, codeSymbols: await this.deps.codeSymbols() });
        this.problems.delete(repo.key);
        this.freshUntil.set(repo.key, this.now() + FRESH_MS);
        if (changes.length > 0 && this.deps.onChanges) {
          await this.deps.onChanges(repo, store, changes).catch((error: unknown) => console.error(`[contextualise] after re-indexing ${repo.key}: ${String(error)}`));
        }
      })()
        .catch((error: unknown) => {
          this.problems.set(repo.key, String(error instanceof Error ? error.message : error));
          throw error;
        })
        .finally(() => this.running.delete(repo.key));
      this.running.set(repo.key, run);
      run.catch((error: unknown) => console.error(`[contextualise] could not index ${repo.key}: ${String(error)}`));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"updating">((done) => {
      timer = setTimeout(() => done("updating"), maxWaitMs);
    });
    try {
      return await Promise.race([run.then(() => "fresh" as const), waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Forces the next refresh to compare blobs again.
  invalidate(repoKey: string): void {
    this.freshUntil.delete(repoKey);
  }

  async recordTask(repo: GitRepo, task: TaskRecord): Promise<void> {
    const store = await this.open(repo);
    store.upsertTask(task);
    await appendFile(join(await this.dir(), `${KnowledgeBase.fileName(repo.key)}.tasks.jsonl`), `${JSON.stringify(task)}\n`, { mode: 0o600 });
  }

  // Every repository that has an index, including ones not opened since the plugin started.
  async projects(): Promise<Project[]> {
    const dir = await this.dir();
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".sqlite")) continue;
      if ([...this.opened.keys()].some((key) => `${KnowledgeBase.fileName(key)}.sqlite` === name)) continue;
      const store = new KnowledgeStore(join(dir, name));
      const repoKey = store.getMeta("repoKey");
      const top = store.getMeta("top");
      if (!repoKey || !top) {
        store.close();
        continue;
      }
      this.opened.set(repoKey, { repo: { key: repoKey, top }, store });
    }
    return [...this.opened.values()]
      .map(({ repo, store }) => ({
        repoKey: repo.key,
        name: basename(repo.top),
        top: repo.top,
        counts: store.counts(),
        indexedAt: store.getMeta("indexedAt"),
        indexing: this.running.has(repo.key),
        problem: this.problems.get(repo.key) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async byKey(repoKey: string): Promise<Opened | null> {
    if (!this.opened.has(repoKey)) await this.projects();
    return this.opened.get(repoKey) ?? null;
  }

  close(): void {
    for (const { store } of this.opened.values()) store.close();
    this.opened.clear();
  }
}
