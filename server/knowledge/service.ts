import { type Busy, busySchema, type KnowledgeEntry, type KnowledgeKind, type ProjectFacts, type RelatedMemory, type SearchHit } from "../../shared/knowledge";
import type { KnowledgeBase } from "./base";
import { AREA_PREFIX, areaOf, isTestFile, storedFacts, updateFacts } from "./facts";
import type { ProjectRoot } from "./git";
import { BUSY_DAYS, recentChanges } from "./history";
import type { KnowledgeStore, TaskRecord } from "./store";
import { anyGlob } from "./globs";
import { taskNeedsCheck } from "./task-log";

// How long a search waits for a re-index before answering from the index as it is.
const SEARCH_WAIT_MS = 3_000;
const MAX_TASK_HITS = 5;
// Change history is read again at most this often per project; git log is the slow part of facts.
const BUSY_REFRESH_MS = 10 * 60_000;
const AREA_BUSY = 8;
const AREA_DOCUMENTS = 10;
const AREA_TASKS = 5;

export type RelatedLookup = (repoKey: string, path: string) => Promise<RelatedMemory[]>;

function taskText(task: TaskRecord): string {
  return [
    `Request: ${task.request}`,
    `Outcome: ${task.outcome} (${task.provider}, ${task.startedAt} to ${task.endedAt})`,
    task.files.length > 0 ? `Files changed: ${task.files.join(", ")}` : "Files changed: none recorded",
    ...(task.commands.length > 0 ? ["Commands:", ...task.commands.map((command) => `- ${command.command}${command.exitCode === null ? "" : ` (exit ${command.exitCode})`}`)] : []),
  ].join("\n");
}

// Search and read for one repository, shared by the agent tools and the app's screens.
export class KnowledgeService {
  constructor(
    private readonly base: KnowledgeBase,
    // Memories about a path, when Memorise is available; null when it is not.
    private readonly related: () => Promise<RelatedLookup | null>,
    private readonly now: () => number = Date.now,
  ) {}

  // A failed re-index (a deleted worktree, an unreadable folder) is the project's problem, shown with
  // it and logged by the base; what was indexed before is still the best answer, so reads go on.
  private async current(repo: ProjectRoot): Promise<KnowledgeStore> {
    await this.base.refresh(repo, SEARCH_WAIT_MS).catch(() => "failed");
    return this.base.open(repo);
  }

  private async withRelated(repoKey: string, hits: Omit<SearchHit, "relatedMemories">[]): Promise<SearchHit[]> {
    const lookup = await this.related();
    return Promise.all(hits.map(async (hit) => ({ ...hit, relatedMemories: lookup && hit.kind !== "task" ? await lookup(repoKey, hit.path).catch(() => []) : [] })));
  }

  // `paths` narrows results to files matching any of them: a glob (src/api/**), a file, or a folder.
  async search(repo: ProjectRoot, query: string, kinds: readonly KnowledgeKind[], limit: number, paths: readonly string[] = []): Promise<SearchHit[]> {
    const store = await this.current(repo);
    const wantsTasks = kinds.length === 0 || kinds.includes("task");
    const blobs = wantsTasks ? store.fileBlobs() : new Map<string, string>();
    const within = (path: string) => paths.length === 0 || paths.some((wanted) => path === wanted || path.startsWith(`${wanted.replace(/\/+$/, "")}/`)) || anyGlob(paths, path);
    // Symbols in test files rarely answer a question about the project; they come back only when the
    // agent asks for code or for paths. With a filter, more candidates are read so enough survive it.
    const keepTests = kinds.includes("code") || paths.length > 0;
    const fetch = paths.length > 0 || !keepTests ? limit * 5 : limit;
    const tasks = wantsTasks
      ? store
          .searchTasks(query, Math.min(MAX_TASK_HITS, fetch))
          .filter(({ task }) => paths.length === 0 || task.files.some(within))
          .slice(0, Math.min(MAX_TASK_HITS, limit))
          .map(({ task, snippet }) => ({
          id: task.id,
          kind: "task" as const,
          path: task.files[0] ?? "",
          line: 0,
          title: task.generatedTitle ?? task.title,
          snippet,
          needsCheck: taskNeedsCheck(task, blobs),
        }))
      : [];
    const sources = store
      .search(query, { kinds, limit: fetch })
      .filter((hit) => within(hit.path) && (keepTests || hit.kind !== "code" || !isTestFile(hit.path)))
      .slice(0, limit - tasks.length)
      .map((hit) => ({ ...hit, needsCheck: hit.kind === "adr" && store.sourceStatus(hit.path)?.status === "superseded" }));
    return this.withRelated(repo.key, [...sources, ...tasks]);
  }

  async read(repo: ProjectRoot, id: string): Promise<KnowledgeEntry> {
    const store = await this.current(repo);
    if (id.startsWith("task:")) {
      const task = store.task(id);
      if (!task) throw new Error(`No task ${id} in ${repo.key}; search again for current ids`);
      const [entry] = await this.withRelated(repo.key, [{ id, kind: "task", path: task.files[0] ?? "", line: 0, title: task.generatedTitle ?? task.title, snippet: "", needsCheck: taskNeedsCheck(task, store.fileBlobs()) }]);
      return { ...entry, body: taskText(task) };
    }
    const entry = store.read(id);
    if (!entry) throw new Error(`No entry ${id} in ${repo.key}; the file may have changed, so search again for current ids`);
    const [hit] = await this.withRelated(repo.key, [{ ...entry, snippet: "", needsCheck: entry.kind === "adr" && store.sourceStatus(entry.path)?.status === "superseded" }]);
    const { snippet: _snippet, ...rest } = hit;
    return { ...rest, body: entry.body };
  }

  async outline(repo: ProjectRoot, path: string) {
    return (await this.current(repo)).outline(path.replace(/^\.?\//, ""));
  }

  // Tasks that changed a file, or any file in a folder, newest first.
  async history(repo: ProjectRoot, path: string, limit: number) {
    const wanted = path.replace(/^\.?\//, "").replace(/\/+$/, "");
    const store = await this.current(repo);
    const blobs = store.fileBlobs();
    return store
      .tasks(500)
      .filter((task) => task.files.some((file) => file === wanted || file.startsWith(`${wanted}/`)))
      .slice(0, limit)
      .map(({ citations, ...task }) => ({ ...task, needsCheck: taskNeedsCheck({ citations }, blobs) }));
  }

  async tasks(repo: ProjectRoot, limit: number, offset = 0) {
    // Fresh file versions decide "needs check", the same as search and browse.
    const store = await this.current(repo);
    const blobs = store.fileBlobs();
    return { tasks: store.tasks(limit, offset).map(({ citations, ...task }) => ({ ...task, needsCheck: taskNeedsCheck({ citations }, blobs) })), total: store.counts().task };
  }

  private async busy(repo: ProjectRoot, store: KnowledgeStore): Promise<Busy> {
    const kept = store.getMeta("busy");
    const cached = kept ? busySchema.safeParse(JSON.parse(kept)) : null;
    if (cached?.success && this.now() - Date.parse(cached.data.at) < BUSY_REFRESH_MS) return cached.data;
    const at = new Date(this.now()).toISOString();
    let busy: Busy;
    if (!repo.git) busy = { at, days: BUSY_DAYS, available: false, problem: null, files: [] };
    else {
      try {
        busy = { at, days: BUSY_DAYS, available: true, problem: null, files: await recentChanges(repo.top) };
      } catch (error) {
        console.error(`[contextualise] could not read the change history of ${repo.key}: ${String(error)}`);
        busy = { at, days: BUSY_DAYS, available: false, problem: `Could not read the change history: ${error instanceof Error ? error.message : String(error)}`, files: [] };
      }
    }
    store.setMeta("busy", JSON.stringify(busy));
    return busy;
  }

  // One written line per area, kept only for areas that still exist.
  private static areaLines(store: KnowledgeStore, facts: ProjectFacts): Record<string, string> {
    const kept = JSON.parse(store.getMeta("areaLines") ?? "{}") as Record<string, string>;
    return Object.fromEntries(facts.areas.filter((area) => typeof kept[area.path] === "string").map((area) => [area.path, kept[area.path]]));
  }

  // The project's structure alone, without change history: for callers that need no git.
  async structure(repo: ProjectRoot): Promise<ProjectFacts> {
    const store = await this.current(repo);
    return storedFacts(store) ?? (await updateFacts(repo, store));
  }

  async facts(repo: ProjectRoot): Promise<{ facts: ProjectFacts; busy: Busy; areaLines: Record<string, string> }> {
    const facts = await this.structure(repo);
    const store = await this.base.open(repo);
    const busy = await this.busy(repo, store);
    return { facts, busy: { ...busy, files: busy.files.map((file) => ({ ...file, area: areaOf(file.path, facts) })) }, areaLines: KnowledgeService.areaLines(store, facts) };
  }

  // One area: its facts, the areas it depends on and that use it, its busy files, and the documents
  // and recorded work in it.
  async area(repo: ProjectRoot, path: string) {
    const { facts, busy, areaLines } = await this.facts(repo);
    const area = facts.areas.find((candidate) => candidate.path === path);
    if (!area) throw new Error(`Unknown area "${path}" in ${repo.key}; the project's areas may have changed, so open the overview again`);
    const store = await this.base.open(repo);
    const blobs = store.fileBlobs();
    const explained = store.read(`brief:${AREA_PREFIX}${path}:1`);
    return {
      area,
      line: areaLines[path] ?? null,
      explanation: explained ? { body: explained.body, at: store.indexedSources().get(`${AREA_PREFIX}${path}`)?.blob.replace(/^generated:/, "") ?? "" } : null,
      dependsOn: facts.links.filter((link) => link.from === path),
      usedBy: facts.links.filter((link) => link.to === path),
      busy: busy.files.filter((file) => file.area === path).slice(0, AREA_BUSY),
      documents: store
        .documents(2_000)
        .filter((document) => areaOf(document.path, facts) === path)
        .slice(0, AREA_DOCUMENTS),
      tasks: store
        .tasks(500)
        .filter((task) => task.files.some((file) => areaOf(file, facts) === path))
        .slice(0, AREA_TASKS)
        .map(({ citations, ...task }) => ({ ...task, needsCheck: taskNeedsCheck({ citations }, blobs) })),
    };
  }

  async browse(repo: ProjectRoot, kind: Exclude<KnowledgeKind, "task">, limit: number, offset: number): Promise<{ hits: SearchHit[]; total: number }> {
    const store = await this.current(repo);
    const { entries, total } = store.browse(kind, limit, offset);
    const hits = await this.withRelated(
      repo.key,
      entries.map(({ body, ...entry }) => ({ ...entry, snippet: body.replace(/\s+/g, " ").trim(), needsCheck: entry.kind === "adr" && store.sourceStatus(entry.path)?.status === "superseded" })),
    );
    return { hits, total };
  }
}
