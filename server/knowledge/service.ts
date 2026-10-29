import type { KnowledgeEntry, KnowledgeKind, RelatedMemory, SearchHit } from "../../shared/knowledge";
import type { KnowledgeBase } from "./base";
import type { GitRepo } from "./git";
import type { KnowledgeStore, TaskRecord } from "./store";
import { taskNeedsCheck } from "./task-log";

// How long a search waits for a re-index before answering from the index as it is.
const SEARCH_WAIT_MS = 3_000;
const MAX_TASK_HITS = 5;

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
  ) {}

  private async current(repo: GitRepo): Promise<KnowledgeStore> {
    await this.base.refresh(repo, SEARCH_WAIT_MS);
    return this.base.open(repo);
  }

  private async withRelated(repoKey: string, hits: Omit<SearchHit, "relatedMemories">[]): Promise<SearchHit[]> {
    const lookup = await this.related();
    return Promise.all(hits.map(async (hit) => ({ ...hit, relatedMemories: lookup && hit.kind !== "task" ? await lookup(repoKey, hit.path).catch(() => []) : [] })));
  }

  async search(repo: GitRepo, query: string, kinds: readonly KnowledgeKind[], limit: number): Promise<SearchHit[]> {
    const store = await this.current(repo);
    const wantsTasks = kinds.length === 0 || kinds.includes("task");
    const blobs = wantsTasks ? store.fileBlobs() : new Map<string, string>();
    const tasks = wantsTasks
      ? store.searchTasks(query, Math.min(MAX_TASK_HITS, limit)).map(({ task, snippet }) => ({
          id: task.id,
          kind: "task" as const,
          path: task.files[0] ?? "",
          line: 0,
          title: task.title,
          snippet,
          needsCheck: taskNeedsCheck(task, blobs),
        }))
      : [];
    const sources = store.search(query, { kinds, limit: limit - tasks.length }).map((hit) => ({ ...hit, needsCheck: hit.kind === "adr" && store.sourceStatus(hit.path)?.status === "superseded" }));
    return this.withRelated(repo.key, [...sources, ...tasks]);
  }

  async read(repo: GitRepo, id: string): Promise<KnowledgeEntry> {
    const store = await this.current(repo);
    if (id.startsWith("task:")) {
      const task = store.task(id);
      if (!task) throw new Error(`No task ${id} in ${repo.key}; search again for current ids`);
      const [entry] = await this.withRelated(repo.key, [{ id, kind: "task", path: task.files[0] ?? "", line: 0, title: task.title, snippet: "", needsCheck: taskNeedsCheck(task, store.fileBlobs()) }]);
      return { ...entry, body: taskText(task) };
    }
    const entry = store.read(id);
    if (!entry) throw new Error(`No entry ${id} in ${repo.key}; the file may have changed, so search again for current ids`);
    const [hit] = await this.withRelated(repo.key, [{ ...entry, snippet: "", needsCheck: entry.kind === "adr" && store.sourceStatus(entry.path)?.status === "superseded" }]);
    const { snippet: _snippet, ...rest } = hit;
    return { ...rest, body: entry.body };
  }

  async tasks(repo: GitRepo, limit: number) {
    const store = await this.base.open(repo);
    const blobs = store.fileBlobs();
    return store.tasks(limit).map(({ citations, ...task }) => ({ ...task, needsCheck: taskNeedsCheck({ citations }, blobs) }));
  }
}
