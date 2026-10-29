import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  let now: number;
  let base: KnowledgeBase;
  const onChanges = vi.fn(async () => {});
  const make = () => new KnowledgeBase({ root: async () => root, symbols, codeSymbols: async () => true, onChanges, now: () => now });

  beforeEach(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-base-repo-")));
    root = mkdtempSync(join(tmpdir(), "contextualise-base-data-"));
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
    rmSync(root, { recursive: true, force: true });
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

  it("finds no repository outside git", async () => {
    expect(await base.repoFor(root)).toBeNull();
  });
});
