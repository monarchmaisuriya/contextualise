import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectPack } from "./pack";
import { BRIEF_ID, KnowledgeStore } from "./store";

describe("projectPack", () => {
  let dir: string;
  let store: KnowledgeStore;
  const project = { name: "api", repoKey: "github.com/acme/api" };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "contextualise-pack-"));
    store = new KnowledgeStore(join(dir, "index.sqlite"));
    store.replaceSource({ path: "CLAUDE.md", kind: "convention", blob: "c", chunks: [{ title: "Rules", body: "Run npm test before a commit.", line: 1 }] });
    store.replaceSource({
      path: "ARCHITECTURE.md",
      kind: "architecture",
      blob: "a",
      chunks: [
        { title: "Overview", body: "One daemon.", line: 1 },
        { title: "Overview > Queue", body: "Jobs wait in SQLite.", line: 4 },
      ],
    });
    store.replaceSource({ path: "docs/adr/0001-sqlite.md", kind: "adr", blob: "d1", chunks: [{ title: "Use SQLite", body: "Status: accepted", line: 1 }], adr: { status: "accepted", supersededBy: null } });
    store.replaceSource({ path: "docs/adr/0000-files.md", kind: "adr", blob: "d0", chunks: [{ title: "Use files", body: "Status: superseded", line: 1 }], adr: { status: "superseded", supersededBy: "0001-sqlite.md" } });
    store.replaceSource({ path: "README.md", kind: "doc", blob: "r", chunks: [{ title: "Api", body: "Read me.", line: 1 }] });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("quotes conventions, architecture, and decisions still in force in full, in that order, and recent work", () => {
    store.replaceSource({ path: "(brief)", kind: "brief", blob: "generated:x", chunks: [{ title: "Project overview", body: "An API for orders.", line: 1 }] });
    store.upsertTask({ id: "task:a1", agentId: "a1", provider: "claude", title: "Fix refs", request: "Fix refs", outcome: "completed", files: [], commands: [], startedAt: "2026-11-01T10:00:00.000Z", endedAt: "2026-11-01T11:00:00.000Z", citations: [] });
    const pack = projectPack(store, project);
    expect(store.read(BRIEF_ID)).not.toBeNull();
    expect(pack.text).toContain("An API for orders.");
    expect(pack.text.indexOf("### CLAUDE.md")).toBeLessThan(pack.text.indexOf("### ARCHITECTURE.md"));
    expect(pack.text.indexOf("### ARCHITECTURE.md")).toBeLessThan(pack.text.indexOf("### docs/adr/0001-sqlite.md"));
    expect(pack.text).toContain("#### Overview\nOne daemon.\n#### Overview > Queue\nJobs wait in SQLite.");
    expect(pack.text).not.toContain("0000-files");
    expect(pack.text).not.toContain("Read me.");
    expect(pack.text).toContain("- 2026-11-01 Fix refs (completed)");
    expect(pack.text).toContain("Search Attach > Project for anything else in this project.");
    expect(pack).toMatchObject({ documents: 3, included: 3, tokens: Math.round(pack.text.length / 4) });
  });

  it("leaves out whole documents that pass the limit and names them, staying within it", () => {
    store.replaceSource({ path: "docs/design/big.md", kind: "architecture", blob: "b", chunks: [{ title: "Big", body: "x".repeat(5_000), line: 1 }] });
    const pack = projectPack(store, project, 4_500);
    expect(pack.text.length).toBeLessThanOrEqual(4_500);
    expect(pack.text).not.toContain("x".repeat(100));
    expect(pack.text).toContain("Left out (over the size limit): docs/design/big.md.");
    expect(pack.text).toContain("### docs/adr/0001-sqlite.md");
    expect(pack).toMatchObject({ documents: 4, included: 3 });
  });

  it("writes a long section split in parts under one title", () => {
    store.replaceSource({ path: "CLAUDE.md", kind: "convention", blob: "c2", chunks: [{ title: "Rules", body: "part one", line: 1 }, { title: "Rules", body: "part two", line: 1 }] });
    expect(projectPack(store, project).text).toContain("### CLAUDE.md\n#### Rules\npart one\npart two");
  });
});
