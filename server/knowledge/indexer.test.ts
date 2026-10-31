import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentBlobs, indexRepo, trackedBlobs } from "./indexer";
import { KnowledgeStore } from "./store";
import { SymbolReader } from "./symbols";

const symbols = new SymbolReader(async () => process.cwd());

describe("indexRepo", () => {
  let top: string;
  let store: KnowledgeStore;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  };
  const commit = () => {
    execFileSync("git", ["-C", top, "add", "-A"]);
    execFileSync("git", ["-C", top, "-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-m", "change"]);
  };
  const index = () => indexRepo({ key: "github.com/acme/api", top, git: true }, store, { symbols, codeSymbols: true });

  beforeEach(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-index-")));
    execFileSync("git", ["init", "-q", top]);
    store = new KnowledgeStore(join(top, ".git", "knowledge.sqlite"));
    write("ARCHITECTURE.md", "# Overview\nOne daemon, many plugins.\n");
    write("docs/adr/0001-use-sqlite.md", "# Use SQLite\n\nStatus: accepted\n");
    write("shared/contracts.ts", "export function parseItemRef(ref: string) { return ref.trim(); }\n");
    write("package.json", "{}\n");
    commit();
  });
  afterEach(() => {
    store.close();
    rmSync(top, { recursive: true, force: true });
  });

  it("indexes docs, ADRs, and code symbols, and keeps every tracked file's blob", async () => {
    const changes = await index();
    expect(changes.map((change) => change.path).sort()).toEqual(["ARCHITECTURE.md", "docs/adr/0001-use-sqlite.md", "shared/contracts.ts"]);
    expect([...store.fileBlobs().keys()].sort()).toEqual(["ARCHITECTURE.md", "docs/adr/0001-use-sqlite.md", "package.json", "shared/contracts.ts"]);
    expect(store.search("parseItemRef", { kinds: [], limit: 5 })[0]).toMatchObject({ kind: "code", path: "shared/contracts.ts", line: 1 });
    expect(store.adrs()[0]).toMatchObject({ status: "accepted" });
  });

  it("re-reads only what changed, including uncommitted edits, and reports removed and added symbols", async () => {
    await index();
    write("shared/contracts.ts", "export function parseRef(ref: string) { return ref.trim(); }\n");
    const changes = await index();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "shared/contracts.ts", removedSymbols: [{ name: "parseItemRef" }], addedSymbols: [{ name: "parseRef" }] });
    expect(store.search("parseItemRef", { kinds: ["code"], limit: 5 })).toEqual([]);
    expect(await index()).toEqual([]);
  });

  it("reports an ADR's status change and drops deleted files", async () => {
    await index();
    write("docs/adr/0001-use-sqlite.md", "# Use SQLite\n\nStatus: superseded by [ADR-2](0002-use-postgres.md)\n");
    unlinkSync(join(top, "ARCHITECTURE.md"));
    const changes = await index();
    expect(changes.find((change) => change.path === "docs/adr/0001-use-sqlite.md")).toMatchObject({ adrBefore: { status: "accepted" }, adrAfter: { status: "superseded", supersededBy: "0002-use-postgres.md" } });
    expect(changes.find((change) => change.path === "ARCHITECTURE.md")).toMatchObject({ deleted: true });
    expect(store.titles("architecture")).toEqual([]);
  });

  it("redacts secret-shaped text before storing it", async () => {
    write("docs/setup.md", "# Setup\nexport TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    commit();
    await index();
    const [hit] = store.search("setup", { kinds: ["doc"], limit: 5 });
    expect(store.read(hit.id)?.body).toContain("[removed: GitHub token]");
    expect(store.read(hit.id)?.body).not.toContain("ghp_");
  });

  it("indexes no code when code symbols are off", async () => {
    await indexRepo({ key: "k/a", top, git: true }, store, { symbols, codeSymbols: false });
    expect(store.counts().code).toBe(0);
  });

  it("gives an edited file the blob git would give it", async () => {
    write("package.json", '{"name":"x"}\n');
    const expected = execFileSync("git", ["-C", top, "hash-object", "package.json"], { encoding: "utf8" }).trim();
    expect((await trackedBlobs(top)).get("package.json")).toBe(expected);
  });

  it("indexes only plain files: committed links (to a file outside the repo, or to a folder) and submodules are skipped", async () => {
    const outside = mkdtempSync(join(tmpdir(), "contextualise-outside-"));
    writeFileSync(join(outside, "private.md"), "# Private\nouter-secret-words\n");
    symlinkSync(join(outside, "private.md"), join(top, "notes.md"));
    symlinkSync(".", join(top, "loop.md"));
    // A submodule: another repository committed as a gitlink, then moved to a new commit.
    const sub = join(top, "lib");
    execFileSync("git", ["init", "-q", sub]);
    writeFileSync(join(sub, "README.md"), "# Lib\n");
    execFileSync("git", ["-C", sub, "add", "-A"]);
    execFileSync("git", ["-C", sub, "-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-m", "one"]);
    commit();
    writeFileSync(join(sub, "README.md"), "# Lib moved\n");
    execFileSync("git", ["-C", sub, "-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-am", "two"]);
    try {
      await index();
      expect(store.search("outer secret words", { kinds: [], limit: 5 })).toEqual([]);
      expect([...store.indexedSources().keys()]).not.toEqual(expect.arrayContaining(["notes.md", "loop.md", "lib"]));
      expect(store.indexedSources().has("ARCHITECTURE.md")).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("currentBlobs in a folder outside git", () => {
  let folder: string;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  };

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-folder-")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(folder, { recursive: true, force: true });
  });

  it("takes only the tracked files of a repository inside the folder, so what it ignores stays out", async () => {
    write("notes.md", "# Notes\n");
    write("app/.gitignore", "venv/\n");
    write("app/src/main.py", "def main():\n    pass\n");
    write("app/venv/lib/site.py", "def vendored():\n    pass\n");
    execFileSync("git", ["init", "-q", join(folder, "app")]);
    execFileSync("git", ["-C", join(folder, "app"), "add", "-A"]);
    const blobs = await currentBlobs({ key: "folder/work", top: folder, git: false });
    expect([...blobs.keys()].sort()).toEqual(["app/.gitignore", "app/src/main.py", "notes.md"]);
    expect(blobs.get("app/src/main.py")).toMatch(/^stat:\d+:\d+$/);
  });

  it("never runs a command a repository's own git config names (fsmonitor, clean filter)", async () => {
    const marker = join(folder, "ran");
    write("hook.sh", `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
    chmodSync(join(folder, "hook.sh"), 0o755);
    write("app/.gitattributes", "*.txt filter=probe\n");
    write("app/a.txt", "one\n");
    execFileSync("git", ["init", "-q", join(folder, "app")]);
    execFileSync("git", ["-C", join(folder, "app"), "add", "-A"]);
    execFileSync("git", ["-C", join(folder, "app"), "config", "core.fsmonitor", join(folder, "hook.sh")]);
    execFileSync("git", ["-C", join(folder, "app"), "config", "filter.probe.clean", join(folder, "hook.sh")]);
    write("app/a.txt", "two\n");
    expect([...(await currentBlobs({ key: "folder/work", top: folder, git: false })).keys()]).toContain("app/a.txt");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not treat a linked .git as a repository", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-other-")));
    try {
      execFileSync("git", ["init", "-q", other]);
      mkdirSync(join(folder, "linked"));
      symlinkSync(join(other, ".git"), join(folder, "linked", ".git"));
      write("linked/notes.md", "# Notes\n");
      const blobs = await currentBlobs({ key: "folder/work", top: folder, git: false });
      expect([...blobs.keys()]).toEqual(["linked/notes.md"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("leaves out a repository git cannot read, says so, and still lists the rest", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    write("notes.md", "# Notes\n");
    write("broken/.git", "not a git folder\n");
    write("broken/src/main.py", "x = 1\n");
    const blobs = await currentBlobs({ key: "folder/work", top: folder, git: false });
    expect([...blobs.keys()]).toEqual(["notes.md"]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("broken"));
  });
});
