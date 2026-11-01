import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLog, recentChanges } from "./history";

describe("parseLog", () => {
  const now = 1761800000;
  const day = 86_400;
  it("counts each file's commits over 90, 30, and 7 days, keeps its latest change, busiest first", () => {
    const log = `\u0000${now - 2 * day}\n\napps/a.py\ncore/b.py\n\u0000${now - 10 * day}\n\napps/a.py\n\u0000${now - 60 * day}\n\nREADME.md\n`;
    expect(parseLog(log, now)).toEqual({
      commits: 3,
      filesChanged: { week: 2, month: 2, quarter: 3 },
      files: [
        { path: "apps/a.py", changes: 2, recent: { week: 1, month: 2 }, lastAt: new Date((now - 2 * day) * 1000).toISOString(), area: null },
        { path: "core/b.py", changes: 1, recent: { week: 1, month: 1 }, lastAt: new Date((now - 2 * day) * 1000).toISOString(), area: null },
        { path: "README.md", changes: 1, recent: { week: 0, month: 0 }, lastAt: new Date((now - 60 * day) * 1000).toISOString(), area: null },
      ],
    });
  });

  it("answers a repository with no commits yet with no changes, not a failure", async () => {
    const top = mkdtempSync(join(tmpdir(), "contextualise-history-"));
    try {
      execFileSync("git", ["init", "-q", top]);
      expect(await recentChanges(top, 1761800000)).toEqual({ files: [], filesChanged: { week: 0, month: 0, quarter: 0 }, filesTruncated: false, commits: [], commitsTruncated: false });
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  it("keeps the busiest files of each window, so a file busy only this week is not cut by older busy files", () => {
    const old = Array.from({ length: 3 }, (_, index) => `\u0000${now - 60 * day}\n\nold${index}.ts\n\u0000${now - 61 * day}\n\nold${index}.ts\n`).join("");
    const result = parseLog(`${old}\u0000${now - day}\n\nnew.ts\n`, now, 2);
    expect(result.files.map((file) => file.path)).toEqual(["old0.ts", "old1.ts", "new.ts"]);
  });

  it("returns nothing for an empty history and keeps only the busiest files", () => {
    expect(parseLog("", 1761800000)).toEqual({ commits: 0, filesChanged: { week: 0, month: 0, quarter: 0 }, files: [] });
    // Distinct files are counted before the list is cut to the busiest.
    const cut = parseLog("\u00001761700000\n\na\nb\nc\n", 1761800000, 2);
    expect(cut.files.map((file) => file.path)).toEqual(["a", "b"]);
    expect(cut.filesChanged.quarter).toBe(3);
  });
});
