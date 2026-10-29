import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepo, trackedBlobs } from "./indexer";
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
});
