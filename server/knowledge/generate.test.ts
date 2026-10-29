import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotSettingsSchema, type SnapshotSettings } from "../../shared/contracts";
import type { PaseoApi } from "../paseo-types";
import type { WorkerJob } from "../workers";
import { KnowledgeBase } from "./base";
import { BRIEF_AFTER_SUMMARIES, Generator } from "./generate";
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
    return job.prompt.includes("<material>") ? '{"brief": "An API for orders.\\nWork is mostly queue fixes."}' : '```json\n{"title": "Fixed the queue retry", "summary": "Asked to fix retries. Changed the worker. Tests pass."}\n```';
  });
  const paseo = {
    agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }) },
  } as unknown as PaseoApi;
  let generator: Generator;
  const project = async () => (await base.repoFor(top))!;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "contextualise-generate-"));
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-generate-repo-")));
    execFileSync("git", ["init", "-q", top]);
    writeFileSync(join(top, "README.md"), "# Orders API\nServes orders.\n");
    execFileSync("git", ["-C", top, "add", "-A"]);
    values = snapshotSettingsSchema.parse({ knowledgeGenerate: true });
    const root = join(home, "plugin-data", "contextualise");
    base = new KnowledgeBase({ root: async () => root, symbols: new SymbolReader(async () => process.cwd()), indexOptions: async () => ({ codeSymbols: false }) });
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
    runWorker.mockClear();
    generator = new Generator({
      base,
      prefs: new ProjectPrefsStore(async () => join(root, "knowledge")),
      root: async () => root,
      settings: async () => values,
      runWorker,
      readTimeline: async (_paseo, agentId) => timelines[agentId] ?? [],
      now: () => new Date("2026-10-29T13:00:00.000Z"),
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
    expect(generator.status(repo.key)?.message).toBe("2 past sessions imported; generated knowledge is off in Settings > Contextualise");
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

  it("writes a brief from the task log and documents, kept across re-indexing", async () => {
    const repo = await project();
    await generator.importPast(paseo, repo);
    expect(await generator.brief(paseo, repo)).toBe("done");
    expect(jobs[0].prompt).toContain('doc: README.md "Orders API"');
    expect(jobs[0].prompt).toContain("Document the API (failed)");
    base.invalidate(repo.key);
    await base.refresh(repo, 10_000);
    expect((await base.open(repo)).read(BRIEF_ID)?.body).toBe("An API for orders.\nWork is mostly queue fixes.");
  });

  it("generates nothing for a project switched off", async () => {
    const repo = await project();
    await new ProjectPrefsStore(async () => join(home, "plugin-data", "contextualise", "knowledge")).setEnabled(repo.key, false);
    expect(await generator.summarize(paseo, repo, agents[0])).toBe("skipped");
    expect(await generator.brief(paseo, repo)).toBe("skipped");
  });

  it("summarises after the quiet period, and writes a brief after enough summaries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const repo = await project();
      values = { ...values, knowledgeGenerateIdleMinutes: 5 };
      for (let i = 0; i < BRIEF_AFTER_SUMMARIES; i += 1) {
        const id = `s${i}`;
        timelines[id] = [at({ type: "user_message", text: `task ${i}` })];
        await generator.schedule(paseo, repo, { id, provider: "claude", cwd: top, title: `task ${i}` });
      }
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(runWorker).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await vi.waitFor(() => expect(runWorker).toHaveBeenCalledTimes(BRIEF_AFTER_SUMMARIES + 1));
      expect(jobs.at(-1)?.prompt).toContain("<material>");
    } finally {
      vi.useRealTimers();
    }
  });
});
