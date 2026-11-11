import { describe, expect, it } from "vitest";
import { attentionRow, attentionRows, barHeights, hotspotMeta, periodSummary } from "./pulse-text";

describe("periodSummary", () => {
  const changes = { available: true, problem: null, commits: 1, commitsTruncated: false, filesChanged: 192, filesTruncated: false, untested: 1, hotspots: 5, analysed: true };
  const agents = { available: true, problem: null, running: 0, needsYou: 0 };
  const idle = { done: 0, failed: 0, canceled: 0 };

  it("says the period in plain sentences: changes, agent work, agents now, risk", () => {
    expect(periodSummary({ days: 7, changes, work: idle, agents })).toBe("Last 7 days: 1 commit touching 192 files; no agent work. No agents running now. 1 often-changed file has no tests.");
    expect(periodSummary({ days: 30, changes: { ...changes, commits: 20_000, commitsTruncated: true, filesChanged: 2, untested: 0 }, work: { done: 3, failed: 1, canceled: 0 }, agents: { ...agents, running: 2, needsYou: 1 } })).toBe(
      "Last 30 days: 20,000+ commits touching 2 files; 3 agent tasks finished, 1 failed. 2 agents running now, 1 needs you.",
    );
  });

  it("says only what has arrived, and why a part is missing", () => {
    expect(periodSummary({ days: 7 })).toBe("");
    expect(periodSummary({ days: 7, work: idle })).toBe("Last 7 days: no agent work.");
    expect(periodSummary({ days: 7, work: { done: 0, failed: 2, canceled: 1 } })).toBe("Last 7 days: 2 agent tasks failed, 1 canceled.");
    // An agent stopped with an error needs M without running.
    expect(periodSummary({ days: 7, agents: { ...agents, needsYou: 1 } })).toBe("No agents running now, 1 needs you.");
    // A problem's own text is kept as written, full stops and paths included.
    expect(periodSummary({ days: 7, changes: { ...changes, available: false, problem: "Could not read ../repo." } })).toBe("Could not read ../repo.");
    expect(periodSummary({ days: 7, changes: { ...changes, available: false, problem: null }, agents: { ...agents, available: false, problem: "Could not read Paseo's agents" } })).toBe("Change history needs git. Could not read Paseo's agents.");
    expect(periodSummary({ days: 7, changes: { ...changes, commits: 0, filesChanged: 0, analysed: false } })).toBe("Last 7 days: no commits.");
  });
});

describe("rows", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  it("says why an agent or a task needs M", () => {
    expect(attentionRow({ kind: "agent", agentId: "a", title: "Fix login", reason: "permission", since: "2026-11-01T11:50:00Z" }, now)).toEqual({ title: "Fix login", meta: "asks for permission · 10 min ago", danger: false });
    expect(attentionRow({ kind: "agent", agentId: "a", title: "Fix login", reason: "error", since: null }, now)).toEqual({ title: "Fix login", meta: "stopped with an error", danger: true });
    expect(attentionRow({ kind: "failed-task", taskId: "t", agentId: "b", title: "Migrate", endedAt: "2026-11-01T09:00:00Z" }, now)).toEqual({ title: "Migrate", meta: "task failed · 3 h ago", danger: true });
  });

  it("lists waiting agents first, leaves out failures of agents already listed, and stops at three", () => {
    const agent = (agentId: string) => ({ kind: "agent" as const, agentId, title: agentId, reason: "error" as const, since: null });
    const failure = (agentId: string) => ({ kind: "failed-task" as const, taskId: `t-${agentId}`, agentId, title: agentId, endedAt: "2026-11-01T09:00:00Z" });
    expect(attentionRows([agent("a")], [failure("a"), failure("b")]).map((item) => item.agentId)).toEqual(["a", "b"]);
    expect(attentionRows([agent("a"), agent("b")], [failure("c"), failure("d")])).toHaveLength(3);
  });

  it("describes a hot file: its area, changes, users, and tests when they mean something", () => {
    expect(hotspotMeta({ path: "a.ts", area: "core", changes: 9, usedBy: 12, tests: 0 })).toBe("core · 9 changes · used by 12 · no tests");
    expect(hotspotMeta({ path: "a.ts", area: null, changes: 1, usedBy: 0, tests: 2 })).toBe("1 change · 2 tests");
    expect(hotspotMeta({ path: "a.ts", area: "", changes: 2, usedBy: 1, tests: null })).toBe("Top level · 2 changes · used by 1");
  });
});

describe("barHeights", () => {
  it("scales counts to the tallest, keeps any count visible, and draws nothing when all are zero", () => {
    expect(barHeights([0, 2, 4], 20)).toEqual([0, 10, 20]);
    expect(barHeights([1, 100], 20)).toEqual([2, 20]);
    expect(barHeights([0, 0], 20)).toEqual([0, 0]);
  });
});
