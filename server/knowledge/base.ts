import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { Project } from "../../shared/knowledge";
import { type ProjectRoot, projectName, projectRoot } from "./git";
import { storedFacts, updateFacts } from "./facts";
import { type IndexChange, type IndexerOptions, indexRepo } from "./indexer";
import { cleanTitle } from "../rows";
import { ProjectKeys } from "./projects";
import { KnowledgeStore, type TaskRecord } from "./store";
import type { SymbolReader } from "./symbols";

// How long an index counts as current before the next use compares blobs again, so a burst of
// searches runs git once.
export const FRESH_MS = 30_000;
const REPO_CACHE_MS = 60_000;
// Raised when what is stored from files changes shape, so old indexes are rebuilt once.
const CONTENT_VERSION = "3";

export interface KnowledgeBaseDeps {
  root: () => Promise<string>;
  symbols: SymbolReader;
  // Read at each re-index, so a settings change applies on the next one.
  indexOptions: () => Promise<Omit<IndexerOptions, "symbols">>;
  // Called after each re-index that changed something; failures are logged, never thrown.
  onChanges?: (repo: ProjectRoot, store: KnowledgeStore, changes: IndexChange[]) => Promise<void>;
  now?: () => number;
}

interface Opened {
  repo: ProjectRoot;
  store: KnowledgeStore;
}

// The per-repository indexes of this daemon. One re-index per repository runs at a time; a caller
// that cannot wait (agent creation) gets "updating" and the run finishes in the background.
export class KnowledgeBase {
  private readonly opened = new Map<string, Opened>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly freshUntil = new Map<string, number>();
  private readonly problems = new Map<string, string>();
  private readonly repos = new Map<string, { repo: ProjectRoot | null; at: number }>();
  private readonly now: () => number;
  private keys: ProjectKeys | null = null;

  constructor(private readonly deps: KnowledgeBaseDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async projectKeys(): Promise<ProjectKeys> {
    if (!this.keys) {
      const dir = await this.dir();
      // A folder with an index of its own stays its own project under a later project root.
      this.keys = new ProjectKeys(dir, (key) => access(join(dir, `${KnowledgeBase.fileName(key)}.sqlite`)).then(() => true, () => false));
    }
    return this.keys;
  }

  // Records a Paseo project's folder as a project root, so agents in its subfolders share it.
  async markRoot(folder: string): Promise<void> {
    await (await this.projectKeys()).markRoot(folder);
  }

  private async dir(): Promise<string> {
    const dir = join(await this.deps.root(), "knowledge");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private static fileName(repoKey: string): string {
    return createHash("sha256").update(repoKey).digest("hex").slice(0, 32);
  }

  // The project `cwd` belongs to, or null for folders that never get knowledge: plugin data (where
  // this plugin's and Memorise's background workers run), the home folder, and the filesystem root.
  async repoFor(cwd: string): Promise<ProjectRoot | null> {
    const cached = this.repos.get(cwd);
    if (cached && this.now() - cached.at < REPO_CACHE_MS) return cached.repo;
    const real = await realpath(cwd).catch(() => null);
    const dataParent = dirname(await this.deps.root());
    const pluginData = await realpath(dataParent).catch(() => dataParent);
    let repo: ProjectRoot | null = null;
    if (real && real !== pluginData && !real.startsWith(`${pluginData}${sep}`)) {
      const found = await (await this.projectKeys()).resolve(real);
      const home = await realpath(homedir()).catch(() => homedir());
      repo = !found.git && (found.top === home || found.top === dirname(found.top)) ? null : found;
    }
    this.repos.set(cwd, { repo, at: this.now() });
    return repo;
  }

  async open(repo: ProjectRoot): Promise<KnowledgeStore> {
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
    if (repo.checkoutName) store.setMeta("checkoutName", repo.checkoutName);
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
    KnowledgeBase.upgrade(store);
    this.opened.set(repo.key, { repo, store });
    return store;
  }

  // Indexes made before titles were cleaned (0.16.1 and older), or before imports were kept (0.16.2
  // and older), are read again from the files, and recorded tasks get plain titles. The index is a
  // cache; tasks are kept. Runs once per index.
  private static upgrade(store: KnowledgeStore): void {
    if (store.getMeta("contentVersion") === CONTENT_VERSION) return;
    store.resetSources();
    for (const task of store.tasks(100_000)) {
      const title = cleanTitle(task.title, true);
      if (title !== task.title) store.upsertTask({ ...task, title });
    }
    store.setMeta("contentVersion", CONTENT_VERSION);
  }

  // Resolves when the index is current, or after `maxWaitMs` with "updating" while it carries on.
  async refresh(repo: ProjectRoot, maxWaitMs: number): Promise<"fresh" | "updating"> {
    if ((this.freshUntil.get(repo.key) ?? 0) > this.now()) return "fresh";
    let run = this.running.get(repo.key);
    if (!run) {
      run = (async () => {
        const store = await this.open(repo);
        const changes = await indexRepo(repo, store, { symbols: this.deps.symbols, ...(await this.deps.indexOptions()) });
        // The project's structure follows its files: rebuilt when any changed, or made by another version.
        if (changes.length > 0 || !storedFacts(store)) await updateFacts(repo, store);
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

  async recordTask(repo: ProjectRoot, task: TaskRecord): Promise<void> {
    const store = await this.open(repo);
    store.upsertTask(task);
    await appendFile(join(await this.dir(), `${KnowledgeBase.fileName(repo.key)}.tasks.jsonl`), `${JSON.stringify(task)}\n`, { mode: 0o600 });
  }

  // Every repository that has an index, including ones not opened since the plugin started.
  async projects(): Promise<Omit<Project, "enabled" | "pins" | "generation">[]> {
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
      KnowledgeBase.upgrade(store);
      this.opened.set(repoKey, { repo: projectRoot(repoKey, top), store });
    }
    return [...this.opened.values()]
      .map(({ repo, store }) => ({
        repoKey: repo.key,
        name: projectName({ ...repo, checkoutName: repo.checkoutName ?? store.getMeta("checkoutName") ?? undefined }),
        top: repo.top,
        counts: store.counts(),
        indexedAt: store.getMeta("indexedAt"),
        indexing: this.running.has(repo.key),
        problem: this.problems.get(repo.key) ?? null,
        git: repo.git,
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
