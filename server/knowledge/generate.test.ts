import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotSettingsSchema, type SnapshotSettings } from "../../shared/contracts";
import type { PaseoApi } from "../paseo-types";
import type { WorkerJob } from "../workers";
import { KnowledgeBase } from "./base";
import { DESCRIBE_AFTER_MS, Generator, LINE_MAX_CHARS } from "./generate";
import { ProjectPrefsStore } from "./prefs";
import { BRIEF_ID } from "./store";
import { SymbolReader } from "./symbols";
import type { TimelineEntry } from "./task-log";

const at = (item: unknown): TimelineEntry => ({ item: item as TimelineEntry["item"], timestamp: "2026-10-29T10:00:00.000Z" });

describe("Generator", () => {
  let home: string;
  let top: string;
  let values: SnapshotSettings;
  let base: KnowledgeBase;
  let timelines: Record<string, TimelineEntry[]>;
  let agents: { id: string; provider: string; cwd: string; title: string | null; updatedAt: string; internal?: boolean; lastError?: string }[];
  const jobs: WorkerJob[] = [];
  const runWorker = vi.fn(async (_paseo: PaseoApi, _root: string, job: WorkerJob) => {
    jobs.push(job);
    if (job.title.startsWith("contextualise: describe")) return JSON.stringify({ overview: "An API for orders.\nWork is mostly queue fixes.", areas: [{ path: "core", line: `Holds the user model. ${"x".repeat(200)}` }, { path: "made-up", line: "Not an area." }] });
    if (job.title.startsWith("contextualise: explain")) return '{"explanation": "core holds User, which api imports."}';
    return '```json\n{"title": "Fixed the queue retry", "summary": "Asked to fix retries. Changed the worker. Tests pass."}\n```';
  });
  const paseo = {
    agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }) },
  } as unknown as PaseoApi;
  let generator: Generator;
  let clock: Date;
  const project = async () => (await base.repoFor(top))!;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "contextualise-generate-"));
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-generate-repo-")));
    execFileSync("git", ["init", "-q", top]);
    writeFileSync(join(top, "README.md"), "# Orders API\nServes orders.\n");
    mkdirSync(join(top, "core"));
    mkdirSync(join(top, "api"));
    // Areas need three files each, or they are listed together as "Other".
    for (const name of ["__init__.py", "utils.py"]) {
      writeFileSync(join(top, "core", name), "");
      writeFileSync(join(top, "api", name), "");
    }
    writeFileSync(join(top, "core", "models.py"), "class User:\n    pass\n");
    writeFileSync(join(top, "api", "views.py"), "from core.models import User\n");
    execFileSync("git", ["-C", top, "add", "-A"]);
    values = snapshotSettingsSchema.parse({ knowledgeGenerate: true });
    const root = join(home, "plugin-data", "contextualise");
    base = new KnowledgeBase({ root: async () => root, symbols: new SymbolReader(async () => process.cwd()), indexOptions: async () => ({ codeSymbols: true }) });
    timelines = {
      a1: [at({ type: "user_message", text: "Fix the queue retry, token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), at({ type: "assistant_message", text: "Done." })],
      a2: [at({ type: "user_message", text: "Document the API" })],
    };
    agents = [
      { id: "a1", provider: "codex", cwd: top, title: "Fix the queue retry", updatedAt: "2026-10-29T11:00:00.000Z" },
      { id: "a2", provider: "opencode/x", cwd: top, title: "Document the API", updatedAt: "2026-10-29T12:00:00.000Z", lastError: "boom" },
      { id: "w", provider: "claude", cwd: root, title: "worker", updatedAt: "2026-10-29T12:00:00.000Z" },
    ];
    jobs.length = 0;
    clock = new Date("2026-10-29T13:00:00.000Z");
    runWorker.mockClear();
    generator = new Generator({
      base,
      prefs: new ProjectPrefsStore(async () => join(root, "knowledge")),
      root: async () => root,
      settings: async () => values,
      runWorker,
      readTimeline: async (_paseo, agentId) => timelines[agentId] ?? [],
      now: () => clock,
    });
  });
  afterEach(() => {
    generator.stop();
    base.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(top, { recursive: true, force: true });
  });


  it("imports past sessions without a model, leaving out plugin workers and sessions already logged", async () => {
    const repo = await project();
    expect(await generator.importPast(paseo, repo)).toBe(2);
    expect(await generator.importPast(paseo, repo)).toBe(0);
    const store = await base.open(repo);
    expect(store.tasks(10).map((task) => [task.id, task.outcome])).toEqual([["task:a2", "failed"], ["task:a1", "completed"]]);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("starts no background agent while generated knowledge is off, and imports anyway", async () => {
    values = snapshotSettingsSchema.parse({});
    const repo = await project();
    generator.run(paseo, repo, true);
    await vi.waitFor(() => expect(generator.status(repo.key)?.state).toBe("done"));
    expect(generator.status(repo.key)?.message).toBe("2 past conversations added; summaries are off (Settings > Contextualise > Conversation summaries)");
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("summarises a session once per set of turns, with secrets removed and the session's own provider", async () => {
    const repo = await project();
    const agent = agents[0];
    expect(await generator.summarize(paseo, repo, agent)).toBe("done");
    expect(await generator.summarize(paseo, repo, agent)).toBe("skipped");
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(jobs[0]).toMatchObject({ provider: "codex", outputSchema: { required: ["title", "summary"] } });
    expect(jobs[0].prompt).toContain("[removed: GitHub token]");
    expect(jobs[0].prompt).not.toContain("ghp_");
    expect((await base.open(repo)).task("task:a1")).toMatchObject({ generatedTitle: "Fixed the queue retry", summary: "Asked to fix retries. Changed the worker. Tests pass.", summarizedTurns: 1 });
    timelines.a1.push(at({ type: "user_message", text: "Also add a test" }));
    expect(await generator.summarize(paseo, repo, agent)).toBe("done");
    expect(runWorker).toHaveBeenCalledTimes(2);
  });

  it("summarises OpenCode sessions with Claude, and follows a fixed provider choice", async () => {
    const repo = await project();
    await generator.summarize(paseo, repo, agents[1]);
    values = { ...values, knowledgeGenerateProvider: "codex" };
    timelines.a1 = [at({ type: "user_message", text: "x" })];
    await generator.summarize(paseo, repo, agents[0]);
    expect(jobs.map((job) => job.provider)).toEqual(["claude", "codex"]);
  });

  it("stops at the daily limit", async () => {
    values = { ...values, knowledgeGenerateMaxPerDay: 1 };
    const repo = await project();
    expect(await generator.summarize(paseo, repo, agents[0])).toBe("done");
    expect(await generator.summarize(paseo, repo, agents[1])).toBe("capped");
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("writes the overview and a line per area from the project's facts, kept across re-indexing", async () => {
    const repo = await project();
    await generator.importPast(paseo, repo);
    expect(await generator.describe(paseo, repo, false)).toBe("done");
    const prompt = jobs[0].prompt;
    expect(prompt).toContain('- area "core" (core): 3 code files');
    expect(prompt).toContain("names: class User: [core/models.py]");
    expect(prompt).toContain("used by: api (1)");
    expect(prompt).toContain("Serves orders.");
    expect(prompt).toContain("Document the API");
    base.invalidate(repo.key);
    await base.refresh(repo, 10_000);
    const store = await base.open(repo);
    expect(store.read(BRIEF_ID)?.body).toBe("An API for orders.\nWork is mostly queue fixes.");
    // Only areas the facts have keep a line, cut to the line limit.
    const lines = JSON.parse(store.getMeta("areaLines") ?? "{}") as Record<string, string>;
    expect(Object.keys(lines)).toEqual(["core"]);
    expect(lines.core).toHaveLength(LINE_MAX_CHARS);
  });

  it("writes the overview again only when the structure changed and it is a week old, or when asked", async () => {
    const repo = await project();
    expect(await generator.describe(paseo, repo, false)).toBe("done");
    expect(await generator.describe(paseo, repo, false)).toBe("current");
    mkdirSync(join(top, "web"));
    for (const name of ["__init__.py", "urls.py"]) writeFileSync(join(top, "web", name), "");
    writeFileSync(join(top, "web", "app.py"), "from api.views import User\n");
    execFileSync("git", ["-C", top, "add", "-A"]);
    base.invalidate(repo.key);
    expect(await generator.describe(paseo, repo, false)).toBe("current");
    clock = new Date(clock.getTime() + DESCRIBE_AFTER_MS + 1);
    expect(await generator.describe(paseo, repo, false)).toBe("done");
    expect(await generator.describe(paseo, repo, true)).toBe("done");
    expect(runWorker).toHaveBeenCalledTimes(3);
  });

  it("explains one area on request, as an entry search finds, and refuses unknown areas", async () => {
    const repo = await project();
    expect(await generator.explainArea(paseo, repo, "core")).toBe("done");
    expect(jobs[0].prompt).toContain("- core/models.py");
    expect(jobs[0].prompt).toContain("used by: api (1)");
    const store = await base.open(repo);
    expect(store.read("brief:(area)/core:1")).toMatchObject({ title: "About core", body: "core holds User, which api imports." });
    expect(store.search("imports", { kinds: ["brief"], limit: 5 }).map((hit) => hit.path)).toEqual(["(area)/core"]);
    await expect(generator.explainArea(paseo, repo, "billing")).rejects.toThrow('Unknown area "billing"');
  });

  it("generates nothing for a project switched off", async () => {
    const repo = await project();
    await new ProjectPrefsStore(async () => join(home, "plugin-data", "contextualise", "knowledge")).setEnabled(repo.key, false);
    expect(await generator.summarize(paseo, repo, agents[0])).toBe("skipped");
    expect(await generator.describe(paseo, repo, true)).toBe("skipped");
    expect(await generator.explainArea(paseo, repo, "core")).toBe("skipped");
  });

  it("summarises after the quiet period, then writes the overview once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const repo = await project();
      values = { ...values, knowledgeGenerateIdleMinutes: 5 };
      for (const id of ["s0", "s1"]) {
        timelines[id] = [at({ type: "user_message", text: `task ${id}` })];
        await generator.schedule(paseo, repo, { id, provider: "claude", cwd: top, title: `task ${id}` });
      }
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(runWorker).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      // Two summaries; the overview is written after the first and is current after the second.
      await vi.waitFor(() => expect(runWorker).toHaveBeenCalledTimes(3));
      expect(jobs.filter((job) => job.title.startsWith("contextualise: describe"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
