import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../paseo-types";
import { buildTask, taskNeedsCheck, type TimelineEntry } from "./task-log";

const at = (item: unknown, timestamp = "2026-10-29T10:00:00.000Z"): TimelineEntry => ({ item: item as AgentTimelineItem, timestamp });
const tool = (detail: Record<string, unknown>) => at({ type: "tool_call", name: String(detail.type), status: "completed", detail });

const base = {
  agent: { id: "agent-1", provider: "claude", cwd: "/repo/server", title: null },
  outcome: "completed" as const,
  top: "/repo",
  now: "2026-10-29T10:30:00.000Z",
};

describe("buildTask", () => {
  it("records the first request, changed files relative to the repo, commands with exit codes, and the outcome", () => {
    const task = buildTask({
      ...base,
      entries: [
        at({ type: "user_message", text: "Make parseItemRef accept\nbare Jira keys" }, "2026-10-29T10:01:00.000Z"),
        tool({ type: "read", filePath: "/repo/shared/contracts.ts" }),
        tool({ type: "edit", filePath: "/repo/shared/contracts.ts" }),
        tool({ type: "write", filePath: "plugin.test.ts" }),
        tool({ type: "edit", filePath: "/elsewhere/notes.md" }),
        tool({ type: "shell", command: "npm test", exitCode: 1 }),
        tool({ type: "shell", command: "npm test", exitCode: 0 }),
        at({ type: "user_message", text: "thanks" }),
        at({ type: "assistant_message", text: "Done." }),
      ],
    });
    expect(task).toEqual({
      id: "task:agent-1",
      agentId: "agent-1",
      provider: "claude",
      title: "Make parseItemRef accept bare Jira keys",
      request: "Make parseItemRef accept bare Jira keys",
      outcome: "completed",
      files: ["shared/contracts.ts", "server/plugin.test.ts"],
      commands: [
        { command: "npm test", exitCode: 1 },
        { command: "npm test", exitCode: 0 },
      ],
      startedAt: "2026-10-29T10:01:00.000Z",
      endedAt: "2026-10-29T10:30:00.000Z",
    });
  });

  it("uses the agent's title when it has one, and removes secrets from requests and commands", () => {
    const task = buildTask({
      ...base,
      agent: { ...base.agent, title: "Rotate tokens" },
      entries: [at({ type: "user_message", text: "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), tool({ type: "shell", command: "export API_KEY=abcdef123456", exitCode: 0 })],
    });
    expect(task?.title).toBe("Rotate tokens");
    expect(task?.request).toBe("Use [removed: GitHub token]");
    expect(task?.commands[0].command).toBe("export [removed: password or key assignment]");
  });

  it("records nothing for an agent that was never asked anything", () => {
    expect(buildTask({ ...base, entries: [at({ type: "assistant_message", text: "Hi" })] })).toBeNull();
  });
});

describe("taskNeedsCheck", () => {
  const task = { citations: [{ path: "a.ts", blob: "1" }] };
  it.each([
    [new Map([["a.ts", "1"]]), false],
    [new Map([["a.ts", "2"]]), true],
    [new Map<string, string>(), true],
  ])("current %j -> %s", (current, expected) => {
    expect(taskNeedsCheck(task, current)).toBe(expected);
  });
});
