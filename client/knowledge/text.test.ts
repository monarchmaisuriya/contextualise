import { describe, expect, it } from "vitest";
import { connectionGroups, entryMeta, glanceLine, languageShares, readerBody } from "./text";

describe("project knowledge text", () => {
  it("sums a project up in one line: files, areas, and its main languages", () => {
    expect(glanceLine({ codeFiles: 1, testFiles: 0, areas: [{}], languages: { TypeScript: 1 } })).toBe("1 code file · 1 area · TypeScript 100%");
    expect(glanceLine({ codeFiles: 10, testFiles: 4, areas: [{}, {}], languages: { Python: 1, TypeScript: 6, Go: 3 } })).toBe("10 code files · 4 test files · 2 areas · TypeScript 60%, Go 30%, +1 more");
    expect(glanceLine({ codeFiles: 0, testFiles: 0, areas: [], languages: {} })).toBe("0 code files · 0 areas");
  });

  it("orders languages by files, with rounded shares", () => {
    expect(languageShares({ a: 1, b: 2 })).toEqual([
      { language: "b", count: 2, percent: 67 },
      { language: "a", count: 1, percent: 33 },
    ]);
  });

  it("says what an entry is and where, and what to look at again", () => {
    expect(entryMeta({ kind: "architecture", path: "ARCHITECTURE.md", line: 1, needsCheck: false, relatedMemories: [] })).toBe("Design · ARCHITECTURE.md:1");
    expect(entryMeta({ kind: "task", path: "a.ts", line: 0, needsCheck: true, relatedMemories: [{ id: "m", subject: "queues" }] })).toBe("Past work · changed a.ts · needs check · Memorise: queues");
    expect(entryMeta({ kind: "task", path: "", line: 0, needsCheck: false, relatedMemories: [] })).toBe("Past work");
  });

  it("reads code as a fenced block, agents' writing as plain text, and documents as Markdown", () => {
    expect(readerBody({ kind: "code", path: "a.ts", body: "x" })).toEqual({ text: "```typescript\nx\n```", plain: false });
    expect(readerBody({ kind: "task", path: "", body: "Request: y" })).toEqual({ text: "Request: y", plain: true });
    expect(readerBody({ kind: "doc", path: "README.md", body: "# Hi" })).toEqual({ text: "# Hi", plain: false });
    // Written by an agent from repository text: never rendered as Markdown, so it cannot carry links.
    expect(readerBody({ kind: "brief", path: "(brief)", body: "[x](https://example.com)" })).toEqual({ text: "[x](https://example.com)", plain: true });
  });
});

describe("connectionGroups", () => {
  it("lists each group's files, says how many more, and says None found for an empty one", () => {
    expect(connectionGroups({ fresh: true, imports: { paths: [], total: 0 }, usedBy: { paths: ["a.ts", "b.ts"], total: 5 }, tests: { paths: ["a.test.ts"], total: 1 } })).toEqual([
      { label: "Imports", lines: ["None found"] },
      { label: "Used by", lines: ["a.ts", "b.ts", "and 3 more"] },
      { label: "Tests", lines: ["a.test.ts"] },
    ]);
  });
});

