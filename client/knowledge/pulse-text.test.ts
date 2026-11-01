import { describe, expect, it } from "vitest";
import { agentsTile, attentionRow, attentionRows, barHeights, changesTile, hotspotMeta, riskTile, workTile } from "./pulse-text";

describe("tiles", () => {
  it("says agent work as done and failed, and teaches when there is none", () => {
    expect(workTile({ done: 12, failed: 2, canceled: 1 })).toEqual({ value: "12", sentence: "tasks done · 2 failed", tone: "warning" });
    expect(workTile({ done: 3, failed: 0, canceled: 0 })).toEqual({ value: "3", sentence: "tasks done", tone: "normal" });
    expect(workTile({ done: 0, failed: 0, canceled: 0 })).toEqual({ value: "0", sentence: "Agents' finished work shows here", tone: "muted" });
  });

  it("says commits and files, marks a count cut at git's limit, and teaches outside git", () => {
    expect(changesTile({ available: true, problem: null, commits: 48, commitsTruncated: false, filesChanged: 31, filesTruncated: false })).toEqual({ value: "48", sentence: "commits · 31 files", tone: "normal" });
    expect(changesTile({ available: true, problem: null, commits: 20000, commitsTruncated: true, filesChanged: 900, filesTruncated: true })).toEqual({ value: "20,000+", sentence: "commits · 900+ files", tone: "normal" });
    expect(changesTile({ available: false, problem: null, commits: 0, commitsTruncated: false, filesChanged: 0, filesTruncated: false })).toEqual({ value: "–", sentence: "Change history needs git", tone: "muted" });
    expect(changesTile({ available: false, problem: "Could not read the change history: boom", commits: 0, commitsTruncated: false, filesChanged: 0, filesTruncated: false }).sentence).toBe("Could not read the change history: boom");
  });

  it("leads the agents tile with those that need M, then those running", () => {
    const live = { available: true, problem: null };
    expect(agentsTile({ ...live, running: 3, needsYou: 1, finished: 0 })).toEqual({ value: "1", sentence: "need you · 3 running", tone: "warning" });
    expect(agentsTile({ ...live, running: 2, needsYou: 0, finished: 1 })).toEqual({ value: "2", sentence: "running · 1 finished", tone: "normal" });
    expect(agentsTile({ ...live, running: 0, needsYou: 0, finished: 0 })).toEqual({ value: "0", sentence: "agents running", tone: "muted" });
    expect(agentsTile({ available: false, problem: "Could not read Paseo's agents: down", running: 0, needsYou: 0, finished: 0 })).toEqual({ value: "–", sentence: "Could not read Paseo's agents: down", tone: "muted" });
  });

  it("counts hot files without tests, and says when the languages are not analysed", () => {
    expect(riskTile({ untested: 3, hotspots: 5, analysed: true })).toEqual({ value: "3", sentence: "hot files without tests", tone: "warning" });
    expect(riskTile({ untested: 0, hotspots: 5, analysed: true })).toEqual({ value: "0", sentence: "hot files without tests", tone: "normal" });
    expect(riskTile({ untested: 0, hotspots: 0, analysed: true })).toEqual({ value: "0", sentence: "code files changed lately", tone: "muted" });
    expect(riskTile({ untested: 0, hotspots: 0, analysed: false })).toEqual({ value: "–", sentence: "Risk needs Python, TypeScript, JavaScript, or Go code", tone: "muted" });
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
