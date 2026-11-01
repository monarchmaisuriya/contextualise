import { expect, test } from "vitest";
import type { TagSummary } from "../shared/contracts";
import { agentStatus, filterPlaceholder, filterTags, liveLine, popoverTags, selectedTag, sortTags } from "./tag-list";

const tag = (name: string, agents: number, notes = 0): TagSummary => ({
  key: name,
  name,
  hasWorkspaceLabel: false,
  workspaces: [],
  links: [],
  agents: Array.from({ length: agents }, (_, i) => ({ agentId: `${name}-${i}`, workspaceId: "w", taggedAt: "t", title: `${name} agent ${i}`, provider: "claude", workspaceName: null, state: "active" as const })),
  notes: Array.from({ length: notes }, (_, i) => ({ id: `${name}-n${i}`, vendor: "jira" as const, ref: `P-${i}`, title: `Item ${i}`, url: null, status: "ready" as const, text: "", error: null, addedAt: "t", fetchedAt: "t", provider: null, notifyAgentId: null })),
});

test("tags sort by list order, name, or size", () => {
  const tags = [tag("b", 1), tag("a", 3), tag("c", 2)];
  expect(sortTags(tags, "recent").map((t) => t.name)).toEqual(["b", "a", "c"]);
  expect(sortTags(tags, "name").map((t) => t.name)).toEqual(["a", "b", "c"]);
  expect(sortTags(tags, "size").map((t) => t.name)).toEqual(["a", "c", "b"]);
});

test("the filter matches tag names, agent titles, and item titles", () => {
  const tags = [tag("auth", 1), tag("billing", 0, 1)];
  expect(filterTags(tags, "AUTH agent").map((t) => t.name)).toEqual(["auth"]);
  expect(filterTags(tags, "item 0").map((t) => t.name)).toEqual(["billing"]);
  expect(filterTags(tags, " ")).toHaveLength(2);
});

test("the filter box says what there is to filter", () => {
  expect(filterPlaceholder([tag("a", 2, 1), tag("b", 1)])).toBe("Filter 2 tags, 3 agents, 1 item");
  expect(filterPlaceholder([tag("a", 0)])).toBe("Filter 1 tag");
});

test("a chosen tag stays selected; otherwise desktop shows the first listed tag and a phone the list", () => {
  const tags = [tag("a", 1), tag("b", 1)];
  expect(selectedTag(tags, tags, "b", false)?.name).toBe("b");
  expect(selectedTag(tags, tags, "b", true)?.name).toBe("b");
  expect(selectedTag(tags, [tags[1]], "a", false)?.name).toBe("a");
  expect(selectedTag(tags, [tags[1]], null, false)?.name).toBe("b");
  expect(selectedTag(tags, tags, "gone", false)?.name).toBe("a");
  expect(selectedTag(tags, tags, null, true)).toBeUndefined();
  expect(selectedTag(tags, tags, "gone", true)).toBeUndefined();
  expect(selectedTag([], [], null, false)).toBeUndefined();
});

test("the popover field filters other tags by the name being typed and never hides the agent's own", () => {
  const tags = [tag("auth", 1), tag("billing", 0), tag("bills", 0), tag("api", 0)];
  const mineOf = (typed: string) => popoverTags(tags, "auth-0", typed);
  expect(mineOf("").mine.map((t) => t.name)).toEqual(["auth"]);
  expect(mineOf("").others.map((t) => t.name)).toEqual(["billing", "bills", "api"]);
  expect(mineOf("BIL").others.map((t) => t.name)).toEqual(["billing", "bills"]);
  expect(mineOf("api, bill").others.map((t) => t.name)).toEqual(["billing", "bills"]);
  expect(mineOf("zzz").mine.map((t) => t.name)).toEqual(["auth"]);
  expect(popoverTags(Array.from({ length: 30 }, (_, i) => tag(`t${i}`, 0)), "x", "").others).toHaveLength(24);
});

test("a tag's line counts the agents that need M and those running; an agent's status says the most urgent", () => {
  const member = (live?: { status: string | null; needsYou: "permission" | "error" | "finished" | null }) => ({ agentId: "a", workspaceId: "w", taggedAt: "", title: null, provider: null, workspaceName: null, state: "active" as const, ...(live ? { live: { ...live, updatedAt: null } } : {}) });
  expect(liveLine({ agents: [member({ status: "running", needsYou: "permission" }), member({ status: "running", needsYou: null }), member({ status: "error", needsYou: "error" }), member()] })).toBe("2 need you · 2 running");
  expect(liveLine({ agents: [member({ status: "idle", needsYou: null }), member()] })).toBe("");
  expect(agentStatus({ status: "running", needsYou: "permission", updatedAt: null })).toEqual({ text: "needs permission", urgent: true });
  expect(agentStatus({ status: "idle", needsYou: "finished", updatedAt: null })).toEqual({ text: "finished, not looked at", urgent: false });
  expect(agentStatus({ status: "idle", needsYou: null, updatedAt: null })).toBeNull();
  expect(agentStatus(undefined)).toBeNull();
});

