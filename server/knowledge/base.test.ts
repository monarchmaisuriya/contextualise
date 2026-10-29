import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRESH_MS, KnowledgeBase } from "./base";
import type { TaskRecord } from "./store";
import { SymbolReader } from "./symbols";

const symbols = new SymbolReader(async () => process.cwd());
const task: TaskRecord = {
  id: "task:agent-1",
  agentId: "agent-1",
  provider: "claude",
  title: "Docs",
  request: "Write docs",
  outcome: "completed",
  files: ["README.md"],
  commands: [],
  startedAt: "2026-10-29T10:00:00.000Z",
  endedAt: "2026-10-29T10:10:00.000Z",
  citations: [{ path: "README.md", blob: "x" }],
};

describe("KnowledgeBase", () => {
  let top: string;
  let root: string;
  let home: string;
  let now: number;
  let base: KnowledgeBase;
  const onChanges = vi.fn(async () => {});
  const make = () => new KnowledgeBase({ root: async () => root, symbols, indexOptions: async () => ({ codeSymbols: true }), onChanges, now: () => now });

  beforeEach(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-base-repo-")));
    home = mkdtempSync(join(tmpdir(), "contextualise-base-data-"));
    root = join(home, "plugin-data", "contextualise");
    execFileSync("git", ["init", "-q", top]);
    execFileSync("git", ["-C", top, "remote", "add", "origin", "https://github.com/acme/api.git"]);
    writeFileSync(join(top, "README.md"), "# Api\nHello.\n");
    execFileSync("git", ["-C", top, "add", "-A"]);
    now = 1_000_000;
    onChanges.mockClear();
    base = make();
  });
  afterEach(() => {
    base.close();
    rmSync(top, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("indexes once per freshness window, and reports changes only when something changed", async () => {
    const repo = (await base.repoFor(top))!;
    expect(repo.key).toBe("github.com/acme/api");
    expect(await base.refresh(repo, 10_000)).toBe("fresh");
    expect(onChanges).toHaveBeenCalledTimes(1);
    writeFileSync(join(top, "README.md"), "# Api\nChanged.\n");
    expect(await base.refresh(repo, 10_000)).toBe("fresh");
    expect(onChanges).toHaveBeenCalledTimes(1);
    now += FRESH_MS + 1;
    await base.refresh(repo, 10_000);
    expect(onChanges).toHaveBeenCalledTimes(2);
    now += FRESH_MS + 1;
    await base.refresh(repo, 10_000);
    expect(onChanges).toHaveBeenCalledTimes(2);
  });

  it("answers 'updating' when the caller cannot wait, and runs one index at a time", async () => {
    const repo = (await base.repoFor(top))!;
    const [first, second] = await Promise.all([base.refresh(repo, 0), base.refresh(repo, 10_000)]);
    expect(first).toBe("updating");
    expect(second).toBe("fresh");
    expect(onChanges).toHaveBeenCalledTimes(1);
  });

  it("lists indexed projects after a restart, and restores tasks from the log when the index is lost", async () => {
    const repo = (await base.repoFor(top))!;
    await base.refresh(repo, 10_000);
    await base.recordTask(repo, task);
    base.close();
    for (const name of ["sqlite", "sqlite-wal", "sqlite-shm"]) rmSync(join(root, "knowledge", `${(await import("node:crypto")).createHash("sha256").update(repo.key).digest("hex").slice(0, 32)}.${name}`), { force: true });
    base = make();
    expect(await base.projects()).toEqual([]);
    const store = await base.open(repo);
    expect(store.tasks(10).map((record) => record.id)).toEqual(["task:agent-1"]);
    expect((await base.projects()).map((project) => project.repoKey)).toEqual(["github.com/acme/api"]);
  });

  it("indexes a folder outside git under a folder key, keeps the key after a rename, and sees edits", async () => {
    const folder = join(home, "Notes");
    mkdirSync(join(folder, "docs"), { recursive: true });
    writeFileSync(join(folder, "docs", "setup.md"), "# Setup\nInstall it.\n");
    const project = (await base.repoFor(folder))!;
    expect(project).toMatchObject({ git: false, top: realpathSync(folder) });
    expect(project.key).toMatch(/^folder\/notes-[0-9a-f]{12}$/);
    await base.refresh(project, 10_000);
    expect((await base.open(project)).search("install", { kinds: [], limit: 5 })).toHaveLength(1);
    writeFileSync(join(folder, "docs", "setup.md"), "# Setup\nInstall it with brew.\n");
    now += FRESH_MS + 1;
    await base.refresh(project, 10_000);
    expect((await base.open(project)).search("brew", { kinds: [], limit: 5 })).toHaveLength(1);
    renameSync(folder, join(home, "Notebook"));
    expect((await make().repoFor(join(home, "Notebook")))?.key).toBe(project.key);
  });

  it("gives subfolders of a Paseo project root the root's project", async () => {
    const rootFolder = join(home, "Work");
    mkdirSync(join(rootFolder, "client", "src"), { recursive: true });
    await base.markRoot(rootFolder);
    expect((await base.repoFor(join(rootFolder, "client", "src")))?.top).toBe(realpathSync(rootFolder));
  });

  it("rebuilds an index made by an older version once, and gives its recorded tasks plain titles", async () => {
    const repo = (await base.repoFor(top))!;
    await base.refresh(repo, 10_000);
    await base.recordTask(repo, { ...task, title: "**Handoff:** docs" });
    const store = await base.open(repo);
    store.setMeta("contentVersion", "1");
    base.close();
    base = make();
    const reopened = await base.open(repo);
    expect(reopened.task("task:agent-1")?.title).toBe("Handoff: docs");
    expect(reopened.counts().doc).toBe(0);
    now += FRESH_MS + 1;
    await base.refresh(repo, 10_000);
    expect(reopened.counts().doc).toBe(1);
    expect(reopened.getMeta("contentVersion")).toBe("3");
  });

  it("builds the project's areas after indexing and rebuilds them when code changes", async () => {
    mkdirSync(join(top, "core"));
    mkdirSync(join(top, "api"));
    for (const name of ["__init__.py", "utils.py"]) {
      writeFileSync(join(top, "core", name), "");
      writeFileSync(join(top, "api", name), "");
    }
    writeFileSync(join(top, "core", "models.py"), "class User:\n    pass\n");
    writeFileSync(join(top, "api", "views.py"), "from core.models import User\n");
    execFileSync("git", ["-C", top, "add", "-A"]);
    const repo = (await base.repoFor(top))!;
    await base.refresh(repo, 10_000);
    const facts = async () => JSON.parse((await base.open(repo)).getMeta("facts")!);
    expect((await facts()).links).toEqual([{ from: "api", to: "core", count: 1 }]);
    // An explanation of an area that then disappears is dropped with the next rebuild.
    (await base.open(repo)).replaceSource({ path: "(area)/api", kind: "brief", blob: "g", chunks: [{ title: "About api", body: "Serves requests.", line: 1 }] });
    writeFileSync(join(top, "api", "views.py"), "print('no imports')\n");
    now += FRESH_MS + 1;
    await base.refresh(repo, 10_000);
    expect((await facts()).links).toEqual([]);
    expect((await base.open(repo)).read("brief:(area)/api:1")).not.toBeNull();
    rmSync(join(top, "api"), { recursive: true });
    execFileSync("git", ["-C", top, "add", "-A"]);
    now += FRESH_MS + 1;
    await base.refresh(repo, 10_000);
    expect((await base.open(repo)).read("brief:(area)/api:1")).toBeNull();
  });

  it("never takes the home folder or the filesystem root as a project", async () => {
    expect(await base.repoFor(homedir())).toBeNull();
    expect(await base.repoFor("/")).toBeNull();
  });

  it("gives plugin data folders no project", async () => {
    mkdirSync(join(root, "workers"), { recursive: true });
    expect(await base.repoFor(join(root, "workers"))).toBeNull();
    mkdirSync(join(home, "plugin-data", "memorise", "workers"), { recursive: true });
    expect(await base.repoFor(join(home, "plugin-data", "memorise", "workers"))).toBeNull();
  });
});
