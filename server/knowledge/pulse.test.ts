import { describe, expect, it } from "vitest";
import type { BusyFile } from "../../shared/knowledge";
import { needsYou } from "../agent-state";
import { hotspots, perDay, recentFailures, waitingAgents } from "./pulse";

const HOUR = 3_600_000;

describe("perDay", () => {
  it("counts by the viewer's local day, today last", () => {
    // 2026-11-01 19:00 UTC is 2026-11-02 00:30 in UTC+05:30.
    const now = Date.parse("2026-11-01T19:00:00Z");
    const result = perDay([Date.parse("2026-11-01T18:45:00Z"), Date.parse("2026-11-01T18:15:00Z"), Date.parse("2026-10-31T10:00:00Z")], 3, now, 330);
    expect(result).toEqual({ firstDay: "2026-10-31", counts: [1, 1, 1] });
    // The same instants in UTC: the two evening commits are both on 1 November, today.
    expect(perDay([Date.parse("2026-11-01T18:45:00Z"), Date.parse("2026-11-01T18:15:00Z"), Date.parse("2026-10-31T10:00:00Z")], 3, now, 0)).toEqual({ firstDay: "2026-10-30", counts: [0, 1, 2] });
  });

  it("leaves out what falls outside the window", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(perDay([now - 8 * 24 * HOUR, now + HOUR * 24], 7, now, 0).counts.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("needsYou", () => {
  it("puts a permission request first, then an error, then a finished turn, as Paseo's sidebar does", () => {
    expect(needsYou({ id: "a", title: null, status: "error", pendingPermissions: [{}] })).toBe("permission");
    expect(needsYou({ id: "a", title: null, status: "error" })).toBe("error");
    expect(needsYou({ id: "a", title: null, status: "idle", requiresAttention: true, attentionReason: "finished" })).toBe("finished");
    expect(needsYou({ id: "a", title: null, status: "idle", requiresAttention: false, attentionReason: "finished" })).toBeNull();
    expect(needsYou({ id: "a", title: null, status: "running" })).toBeNull();
  });
});

describe("waiting agents and recent failures", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  const task = (id: string, agentId: string, outcome: string, hoursAgo: number) => ({ id, agentId, title: id, outcome, endedAt: new Date(now - hoursAgo * HOUR).toISOString() });

  it("lists agents waiting on a permission, then those in error", () => {
    expect(
      waitingAgents([
        { id: "e", title: "Broken", status: "error", updatedAt: "2026-11-01T11:00:00Z" },
        { id: "p", title: "Asks", status: "running", pendingPermissions: [{}], attentionTimestamp: "2026-11-01T11:30:00Z" },
        { id: "r", title: "Busy", status: "running" },
      ]),
    ).toEqual([
      { kind: "agent", agentId: "p", title: "Asks", reason: "permission", since: "2026-11-01T11:30:00Z" },
      { kind: "agent", agentId: "e", title: "Broken", reason: "error", since: "2026-11-01T11:00:00Z" },
    ]);
  });

  it("keeps failures from the last 48 hours, newest first, one per agent, unless the agent completed a task after", () => {
    const result = recentFailures([task("old", "a", "failed", 49), task("fixed", "b", "failed", 5), task("later", "b", "completed", 1), task("open", "c", "failed", 3), task("again", "c", "failed", 2)], now);
    expect(result).toEqual([{ kind: "failed-task", taskId: "again", agentId: "c", title: "again", endedAt: new Date(now - 2 * HOUR).toISOString() }]);
  });
});

describe("hotspots", () => {
  const file = (path: string, changes: number, week: number, month: number): BusyFile => ({ path, changes, recent: { week, month }, lastAt: "2026-11-01T00:00:00Z", area: null });
  const inputs = {
    files: [file("core/models.py", 9, 1, 4), file("api/views.py", 12, 6, 10), file("README.md", 20, 5, 10), file("api/test_views.py", 8, 4, 8), file("lib/util.py", 3, 0, 3)],
    isCode: (path: string) => path.endsWith(".py") && !path.includes("test_"),
    usedBy: (path: string) => ({ "core/models.py": 10, "api/views.py": 1, "lib/util.py": 0 })[path] ?? 0,
    tests: (path: string) => (path === "api/views.py" ? 1 : 0),
    areaOf: (path: string) => path.split("/")[0],
    areaHasTests: (area: string | null) => area === "api" || area === "core",
  };

  it("ranks code changed in the window by changes times users, and says no tests only where the area has tests", () => {
    expect(hotspots({ ...inputs, days: 90 })).toEqual({
      hotspots: [
        { path: "core/models.py", area: "core", changes: 9, usedBy: 10, tests: 0 },
        { path: "api/views.py", area: "api", changes: 12, usedBy: 1, tests: 1 },
        { path: "lib/util.py", area: "lib", changes: 3, usedBy: 0, tests: null },
      ],
      untested: 1,
    });
  });

  it("counts only the window's changes, and leaves out files not changed in it", () => {
    expect(hotspots({ ...inputs, days: 7 }).hotspots.map((hotspot) => [hotspot.path, hotspot.changes])).toEqual([
      ["api/views.py", 6],
      ["core/models.py", 1],
    ]);
  });
});
