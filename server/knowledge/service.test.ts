import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "./base";
import { KnowledgeService } from "./service";
import { KnowledgeStore } from "./store";
import { SymbolReader } from "./symbols";

const commit = (top: string, message: string) => {
  execFileSync("git", ["-C", top, "add", "-A"]);
  execFileSync("git", ["-C", top, "-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-q", "-m", message]);
};

describe("KnowledgeService facts and areas", () => {
  let top: string;
  let home: string;
  let base: KnowledgeBase;
  let service: KnowledgeService;

  beforeEach(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-service-repo-")));
    home = mkdtempSync(join(tmpdir(), "contextualise-service-data-"));
    base = new KnowledgeBase({ root: async () => join(home, "plugin-data", "contextualise"), symbols: new SymbolReader(async () => process.cwd()), indexOptions: async () => ({ codeSymbols: true }) });
    service = new KnowledgeService(base, async () => null);
    mkdirSync(join(top, "core"));
    mkdirSync(join(top, "api"));
    mkdirSync(join(top, "api", "docs"));
    // Areas need three files each, or they are listed together as "Other".
    for (const name of ["__init__.py", "utils.py"]) {
      writeFileSync(join(top, "core", name), "");
      writeFileSync(join(top, "api", name), "");
    }
    writeFileSync(join(top, "core", "models.py"), "class User:\n    pass\n");
    writeFileSync(join(top, "api", "views.py"), "from core.models import User\n");
    writeFileSync(join(top, "api", "docs", "guide.md"), "# Api guide\n\nHow the api works.\n");
  });
  afterEach(() => {
    base.close();
    rmSync(top, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("answers a git project's areas, links, and busiest files, and each area's neighbours and documents", async () => {
    execFileSync("git", ["init", "-q", top]);
    commit(top, "start");
    writeFileSync(join(top, "api", "views.py"), "from core.models import User\nprint(User)\n");
    commit(top, "change views");
    const repo = (await base.repoFor(top))!;
    const { facts, busy } = await service.facts(repo);
    expect(facts.areas.map((area) => area.path).sort()).toEqual(["api", "core"]);
    expect(busy).toMatchObject({ available: true, problem: null });
    expect(busy.files[0]).toMatchObject({ path: "api/views.py", changes: 2 });
    const api = await service.area(repo, "api");
    expect(api.dependsOn).toEqual([{ from: "api", to: "core", count: 1 }]);
    // Any file in the area's folders counts, docs included; views.py changed twice, so it leads.
    expect(api.busy[0]).toMatchObject({ path: "api/views.py", changes: 2, area: "api" });
    expect(api.busy.map((file) => file.path)).toContain("api/docs/guide.md");
    expect(api.busy.every((file) => file.area === "api")).toBe(true);
    expect(api.documents).toEqual([expect.objectContaining({ path: "api/docs/guide.md", title: "Api guide" })]);
    expect((await service.area(repo, "core")).usedBy).toEqual([{ from: "api", to: "core", count: 1 }]);
    await expect(service.area(repo, "billing")).rejects.toThrow('Unknown area "billing"');
  });

  it("says change history needs git for a folder outside git", async () => {
    const repo = (await base.repoFor(top))!;
    expect(repo.git).toBe(false);
    const { facts, busy } = await service.facts(repo);
    expect(facts.links).toEqual([{ from: "api", to: "core", count: 1 }]);
    expect(busy).toMatchObject({ available: false, problem: null, files: [] });
  });

  it("answers from the stored index when the project folder is gone", async () => {
    execFileSync("git", ["init", "-q", top]);
    commit(top, "start");
    const repo = (await base.repoFor(top))!;
    expect((await service.search(repo, "api guide", [], 5)).map((hit) => hit.path)).toEqual(["api/docs/guide.md"]);
    rmSync(top, { recursive: true, force: true });
    base.invalidate(repo.key);
    // The refresh fails (the folder is gone); search, tasks, and facts still answer from the index.
    expect((await service.search(repo, "api guide", [], 5)).map((hit) => hit.path)).toEqual(["api/docs/guide.md"]);
    expect((await service.tasks(repo, 5)).total).toBe(0);
    expect((await service.facts(repo)).facts.areas.map((area) => area.path).sort()).toEqual(["api", "core"]);
  });

  it("fails the refresh, rather than emptying the index, when a folder outside git cannot be read", async () => {
    const repo = (await base.repoFor(top))!;
    expect((await service.search(repo, "api guide", [], 5))).toHaveLength(1);
    rmSync(top, { recursive: true, force: true });
    base.invalidate(repo.key);
    await expect(base.refresh(repo, 10_000)).rejects.toThrow();
    expect((await service.search(repo, "api guide", [], 5))).toHaveLength(1);
  });
});

describe("KnowledgeService search", () => {
  let dir: string;
  let store: KnowledgeStore;
  let service: KnowledgeService;
  const repo = { key: "local/abc", top: "/nonexistent", git: true };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "contextualise-service-search-"));
    store = new KnowledgeStore(join(dir, "index.sqlite"));
    service = new KnowledgeService({ refresh: async () => "fresh", open: async () => store } as unknown as KnowledgeBase, async () => null);
    store.replaceSource({ path: "jobs/queue.ts", kind: "code", blob: "1", chunks: [], symbols: [{ name: "drainQueue", kind: "function", line: 1, signature: "function drainQueue() {", params: 0, shape: "s" }] });
    store.replaceSource({ path: "jobs/queue.test.ts", kind: "code", blob: "2", chunks: [], symbols: [{ name: "drainQueueTwice", kind: "function", line: 1, signature: "function drainQueueTwice() {", params: 0, shape: "s" }] });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves out symbols from test files unless code or a path is asked for", async () => {
    const paths = async (kinds: string[], within: string[] = []) => (await service.search(repo, "drain queue", kinds as never, 8, within)).map((hit) => hit.path).sort();
    expect(await paths([])).toEqual(["jobs/queue.ts"]);
    expect(await paths(["code"])).toEqual(["jobs/queue.test.ts", "jobs/queue.ts"]);
    expect(await paths([], ["jobs/"])).toEqual(["jobs/queue.test.ts", "jobs/queue.ts"]);
  });
});
