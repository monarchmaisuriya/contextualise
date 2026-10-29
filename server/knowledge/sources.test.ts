import { describe, expect, it } from "vitest";
import { adrInfo, chunkMarkdown, classify } from "./sources";

describe("classify", () => {
  it.each([
    ["ARCHITECTURE.md", "architecture"],
    ["docs/architecture/storage.md", "architecture"],
    ["docs/design-notes.md", "architecture"],
    ["CONTRIBUTING.md", "convention"],
    ["CLAUDE.md", "convention"],
    ["AGENTS.md", "convention"],
    [".cursorrules", "convention"],
    ["docs/conventions/naming.md", "convention"],
    ["docs/adr/0001-use-sqlite.md", "adr"],
    ["doc/decisions/2024-01-02-queue.md", "adr"],
    ["ADR-7-cache.md", "adr"],
    ["README.md", "doc"],
    ["docs/setup.mdx", "doc"],
    ["server/plugin.ts", "code"],
    ["client/tags-screen.tsx", "code"],
    ["tools/run.py", "code"],
    ["cmd/main.go", "code"],
  ])("%s is %s", (path, kind) => {
    expect(classify(path)).toBe(kind);
  });

  it.each(["node_modules/x/README.md", "vendor/lib/a.go", "dist/index.js", "types/index.d.ts", "assets/app.min.js", "package.json", "logo.png", "docs/conventions/rules.txt"])("skips %s", (path) => {
    expect(classify(path)).toBeNull();
  });
});

describe("chunkMarkdown", () => {
  it("makes one chunk per section with parent headings in the title and the heading's line", () => {
    const text = ["Intro text.", "", "# Design", "Overview.", "## Storage", "SQLite per repo.", "```", "# not a heading", "```", "# Rollout", "Later."].join("\n");
    expect(chunkMarkdown("docs/design.md", text)).toEqual([
      { title: "design.md", body: "Intro text.", line: 1 },
      { title: "Design", body: "Overview.", line: 3 },
      { title: "Design > Storage", body: "SQLite per repo.\n```\n# not a heading\n```", line: 5 },
      { title: "Rollout", body: "Later.", line: 10 },
    ]);
  });

  it("drops empty sections and splits long ones", () => {
    const chunks = chunkMarkdown("a.md", `# Empty\n# Long\n${"x".repeat(9_000)}`);
    expect(chunks.map((chunk) => [chunk.title, chunk.body.length])).toEqual([
      ["Long", 4_000],
      ["Long", 4_000],
      ["Long", 1_000],
    ]);
  });
});

describe("adrInfo", () => {
  it.each([
    ["---\nstatus: Accepted\n---\n# Use SQLite", "accepted", null],
    ["# 1. Use SQLite\n\nStatus: **Superseded** by [ADR-0004](0004-use-postgres.md)", "superseded", "0004-use-postgres.md"],
    ["# Use SQLite\n\n## Status\n\nProposed\n\n## Context", "proposed", null],
    ["* Status: deprecated (2024-01-01)\n\nSuperseded by 0009-queues.md.", "deprecated", "0009-queues.md"],
    ["# No status here", null, null],
  ])("reads %j", (text, status, supersededBy) => {
    expect(adrInfo(text)).toEqual({ status, supersededBy });
  });
});
