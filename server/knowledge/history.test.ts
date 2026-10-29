import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLog, recentChanges } from "./history";

describe("parseLog", () => {
  it("counts each file's commits and keeps its latest change, busiest first", () => {
    const log = "\u00001761700000\n\napps/a.py\ncore/b.py\n\u00001761800000\n\napps/a.py\n\u00001761600000\n\nREADME.md\n";
    expect(parseLog(log)).toEqual([
      { path: "apps/a.py", changes: 2, lastAt: new Date(1761800000 * 1000).toISOString(), area: null },
      { path: "core/b.py", changes: 1, lastAt: new Date(1761700000 * 1000).toISOString(), area: null },
      { path: "README.md", changes: 1, lastAt: new Date(1761600000 * 1000).toISOString(), area: null },
    ]);
  });

  it("answers a repository with no commits yet with no changes, not a failure", async () => {
    const top = mkdtempSync(join(tmpdir(), "contextualise-history-"));
    try {
      execFileSync("git", ["init", "-q", top]);
      expect(await recentChanges(top)).toEqual([]);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  it("returns nothing for an empty history and keeps only the busiest files", () => {
    expect(parseLog("")).toEqual([]);
    expect(parseLog("\u00001761700000\n\na\nb\nc\n", 2).map((file) => file.path)).toEqual(["a", "b"]);
  });
});
