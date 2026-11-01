import { posix } from "node:path";
import { type Busy, busySchema, type FileConnections, type KnowledgeEntry, type KnowledgeKind, type ProjectFacts, type RelatedMemory, type SearchHit } from "../../shared/knowledge";
import type { KnowledgeBase } from "./base";
import { AREA_PREFIX, areaOf, factsAreCurrent, factsFor, goPackage, isTestFile } from "./facts";
import type { ProjectRoot } from "./git";
import { BUSY_DAYS, type ChangeHistory, recentChanges } from "./history";
import { ATTENTION_MS, hotspots, perDay, recentFailures } from "./pulse";
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
const START_HERE = 3;
// Linked files listed by name; longer lists say how many more there are.
const CONNECTIONS_SHOWN = 20;
const IMPACT_SHOWN = 30;

export interface Impact {
  // False while the index is still being refreshed, or when the refresh failed.
  fresh: boolean;
  // False when the project has no code in the index, as when code indexing is off.
  codeIndexed: boolean;
  changed: string[];
  // Inputs that match no indexed code file.
  unknown: string[];
  direct: { paths: string[]; total: number };
  // Files that use a directly affected file, counted once.
  further: number;
  areas: string[];
  tests: { paths: string[]; total: number };
}

// A path as the index keeps it: no leading ./ or /, no trailing /.
const projectPath = (path: string) => path.replace(/^\.?\//, "").replace(/\/+$/, "");
const someOf = (paths: readonly string[], shown: number) => ({ paths: paths.slice(0, shown), total: paths.length });
const unique = (paths: Iterable<string>) => [...new Set(paths)].sort();
// What other files link to for this file: the file, and for Go code its package too.
const linkTargets = (path: string) => (path.endsWith(".go") && !isTestFile(path) ? [path, goPackage(posix.dirname(path))] : [path]);
// Files that import any of these, tests aside (they are listed as tests).
const usersOf = (store: KnowledgeStore, paths: readonly string[]) => unique(paths.flatMap(linkTargets).flatMap((target) => store.linkedFiles(target, "to", "imports"))).filter((user) => !isTestFile(user));
const testsOf = (store: KnowledgeStore, paths: readonly string[]) => unique(paths.flatMap(linkTargets).flatMap((target) => store.linkedFiles(target, "to", "tests")));

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
    return (await this.currentAndState(repo)).store;
  }

  private async currentAndState(repo: ProjectRoot): Promise<{ store: KnowledgeStore; fresh: boolean }> {
    const state = await this.base.refresh(repo, SEARCH_WAIT_MS).catch(() => "failed" as const);
    return { store: await this.base.open(repo), fresh: state === "fresh" };
  }

  // The index with its facts and file links, built now when a refresh has not built them yet.
  // `fresh` is false while a refresh carries on, when it failed, or when files were indexed after the
  // facts and links were built: links may then be out of date.
  private async withFacts(repo: ProjectRoot): Promise<{ store: KnowledgeStore; facts: ProjectFacts; fresh: boolean }> {
    const { store, fresh } = await this.currentAndState(repo);
    const facts = await factsFor(repo, store);
    return { store, facts, fresh: fresh && factsAreCurrent(store) };
  }

  private static connectionsOf(store: KnowledgeStore, path: string, fresh: boolean): FileConnections {
    return {
      fresh,
      imports: someOf(store.linkedFiles(path, "from", "imports"), CONNECTIONS_SHOWN),
      usedBy: someOf(usersOf(store, [path]), CONNECTIONS_SHOWN),
      tests: someOf(testsOf(store, [path]), CONNECTIONS_SHOWN),
    };
  }

  async connections(repo: ProjectRoot, path: string): Promise<FileConnections> {
    const { store, fresh } = await this.withFacts(repo);
    return KnowledgeService.connectionsOf(store, projectPath(path), fresh);
  }

  // What a change to these files or folders reaches: the files that import them, the files that import
  // those (counted), the areas, and the tests that cover any of them.
  async impact(repo: ProjectRoot, paths: readonly string[]): Promise<Impact> {
    const { store, facts, fresh } = await this.withFacts(repo);
    const unknown: string[] = [];
    const changed = unique(
      paths.flatMap((path) => {
        const files = store.codeFilesUnder(projectPath(path));
        if (files.length === 0) unknown.push(path);
        return files;
      }),
    );
    const changedSet = new Set(changed);
    const direct = usersOf(store, changed).filter((user) => !changedSet.has(user));
    const reachedSet = new Set([...changed, ...direct]);
    const further = usersOf(store, direct).filter((user) => !reachedSet.has(user));
    const reached = [...changed, ...direct];
    return {
      fresh,
      codeIndexed: store.hasCode(),
      changed,
      unknown,
      direct: someOf(direct, IMPACT_SHOWN),
      further: further.length,
      areas: unique(reached.map((file) => areaOf(file, facts)).filter((area): area is string => area !== null)),
      tests: someOf(unique([...changed.filter(isTestFile), ...testsOf(store, reached)]), IMPACT_SHOWN),
    };
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
    // agent asks for code or for paths.
    const keepTests = kinds.includes("code") || paths.length > 0;
    const tasks = wantsTasks
      ? store
          .searchTasks(query, Math.min(MAX_TASK_HITS, limit), ({ task }) => paths.length === 0 || task.files.some(within))
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
      .search(query, { kinds, limit: limit - tasks.length, keep: (hit) => within(hit.path) && (keepTests || hit.kind !== "code" || !isTestFile(hit.path)) })
      .map((hit) => ({ ...hit, needsCheck: hit.kind === "adr" && store.sourceStatus(hit.path)?.status === "superseded" }));
    return this.withRelated(repo.key, [...sources, ...tasks]);
  }

  // `connections` adds a code entry's links, for callers that show them (the agent tools and the reader).
  async read(repo: ProjectRoot, id: string, { connections = false }: { connections?: boolean } = {}): Promise<KnowledgeEntry> {
    const { store, fresh } = await this.currentAndState(repo);
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
    if (!connections || entry.kind !== "code") return { ...rest, body: entry.body };
    await factsFor(repo, store);
    return { ...rest, body: entry.body, connections: KnowledgeService.connectionsOf(store, entry.path, fresh && factsAreCurrent(store)) };
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
    const none: ChangeHistory = { files: [], filesChanged: { week: 0, month: 0, quarter: 0 }, filesTruncated: false, commits: [], commitsTruncated: false };
    let busy: Busy;
    if (!repo.git) busy = { at, days: BUSY_DAYS, available: false, problem: null, ...none };
    else {
      try {
        busy = { at, days: BUSY_DAYS, available: true, problem: null, ...(await recentChanges(repo.top, Math.floor(this.now() / 1000))) };
      } catch (error) {
        console.error(`[contextualise] could not read the change history of ${repo.key}: ${String(error)}`);
        busy = { at, days: BUSY_DAYS, available: false, problem: `Could not read the change history: ${error instanceof Error ? error.message : String(error)}`, ...none };
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

  // The part of the pulse that needs no git: agent work in the window, tasks that failed lately, and
  // the most used files to start reading from.
  async pulse(repo: ProjectRoot, days: 7 | 30 | 90, utcOffsetMinutes: number) {
    const { store, facts } = await this.withFacts(repo);
    const now = this.now();
    const empty = perDay([], days, now, utcOffsetMinutes);
    const firstMs = Date.parse(`${empty.firstDay}T00:00:00Z`) - utcOffsetMinutes * 60_000;
    const tasks = store.tasksSince(new Date(Math.min(firstMs, now - ATTENTION_MS)).toISOString());
    const inWindow = tasks.filter((task) => Date.parse(task.endedAt) >= firstMs);
    const count = (outcome: string) => inWindow.filter((task) => task.outcome === outcome).length;
    const candidates = unique(facts.areas.flatMap((area) => area.mainFiles.map((file) => file.path)));
    const startHere = candidates
      .map((path) => ({ path, usedBy: usersOf(store, [path]).length, area: areaOf(path, facts) }))
      .filter((file) => file.usedBy > 0)
      .sort((a, b) => b.usedBy - a.usedBy || a.path.localeCompare(b.path))
      .slice(0, START_HERE);
    return {
      failures: recentFailures(tasks.map((task) => ({ id: task.id, agentId: task.agentId, title: task.generatedTitle ?? task.title, outcome: task.outcome, endedAt: task.endedAt })), now),
      agentWork: { done: count("completed"), failed: count("failed"), canceled: count("canceled"), perDay: perDay(inWindow.map((task) => Date.parse(task.endedAt)), days, now, utcOffsetMinutes) },
      startHere,
      readme: store.sourceStatus("README.md") ? "README.md" : null,
      analysed: facts.codeFiles + facts.testFiles > 0,
    };
  }

  // The part of the pulse that reads git: commits and files changed in the window, and hot files.
  async changes(repo: ProjectRoot, days: 7 | 30 | 90, utcOffsetMinutes: number) {
    const { facts, busy } = await this.withHistory(repo);
    const store = await this.base.open(repo);
    const testedAreas = new Set(facts.areas.filter((area) => area.tests > 0).map((area) => area.path));
    const ranked = hotspots({
      files: busy.files,
      days,
      isCode: (path) => !isTestFile(path) && store.isCode(path),
      usedBy: (path) => usersOf(store, [path]).length,
      tests: (path) => testsOf(store, [path]).length,
      areaOf: (path) => areaOf(path, facts),
      areaHasTests: (area) => area !== null && testedAreas.has(area),
    });
    const commits = perDay(busy.commits.map((at) => at * 1000), days, this.now(), utcOffsetMinutes);
    return {
      available: busy.available,
      problem: busy.problem,
      commits: commits.counts.reduce((sum, value) => sum + value, 0),
      commitsTruncated: busy.commitsTruncated,
      filesChanged: days === 7 ? busy.filesChanged.week : days === 30 ? busy.filesChanged.month : busy.filesChanged.quarter,
      filesTruncated: busy.filesTruncated,
      perDay: commits,
      ...ranked,
      analysed: facts.codeFiles + facts.testFiles > 0,
    };
  }

  // The project's structure alone, without change history: for callers that need no git.
  async structure(repo: ProjectRoot): Promise<ProjectFacts> {
    return (await this.withFacts(repo)).facts;
  }

  // Facts and the full change history, commit times included: for the server's own counts.
  private async withHistory(repo: ProjectRoot): Promise<{ facts: ProjectFacts; busy: Busy; areaLines: Record<string, string> }> {
    const facts = await this.structure(repo);
    const store = await this.base.open(repo);
    const busy = await this.busy(repo, store);
    return { facts, busy: { ...busy, files: busy.files.map((file) => ({ ...file, area: areaOf(file.path, facts) })) }, areaLines: KnowledgeService.areaLines(store, facts) };
  }

  // What the screen shows of the facts and history; commit times stay here, counted by the pulse.
  async facts(repo: ProjectRoot): Promise<{ facts: ProjectFacts; busy: Omit<Busy, "commits">; areaLines: Record<string, string> }> {
    const { busy: { commits: _commits, ...busy }, ...rest } = await this.withHistory(repo);
    return { ...rest, busy };
  }

  // One area: its facts, the areas it depends on and that use it, its busy files, and the documents
  // and recorded work in it.
  async area(repo: ProjectRoot, path: string) {
    const { facts, busy, areaLines } = await this.withHistory(repo);
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
