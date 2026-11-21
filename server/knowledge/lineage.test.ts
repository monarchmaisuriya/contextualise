import { expect, it } from "vitest";
import { mergeTaskLineage } from "./lineage";
import type { TaskRecord } from "./store";

const task: TaskRecord = { id: "task:a", agentId: "a", provider: "claude", title: "Work", request: "Work", outcome: "completed", files: [], commands: [], startedAt: "2026-11-21T10:00:00Z", endedAt: "2026-11-21T11:00:00Z", citations: [] };

it("retains a completed child when an older summary writes a running snapshot last", () => {
  const previous = { ...task, subtasks: [{ callId: "child", description: "Review", status: "completed" as const, observedAt: "2026-11-21T11:00:00Z" }] };
  const next = { ...task, subtasks: [{ callId: "child", description: "Review", status: "running" as const, observedAt: "2026-11-21T10:00:00Z" }] };
  expect(mergeTaskLineage(previous, next).subtasks?.[0].status).toBe("completed");
});

it("enriches identity independently of a losing status snapshot", () => {
  const previous = { ...task, subtasks: [{ callId: "child", description: "Review", status: "completed" as const, observedAt: "2026-11-21T11:00:00Z" }] };
  const next = { ...task, subtasks: [{ callId: "child", description: "Review", status: "running" as const, observedAt: "2026-11-21T10:00:00Z", nativeSessionRef: "native-child", childAgentId: "known-child" }] };
  expect(mergeTaskLineage(previous, next).subtasks?.[0]).toMatchObject({ status: "completed", nativeSessionRef: "native-child", childAgentId: "known-child" });
});
