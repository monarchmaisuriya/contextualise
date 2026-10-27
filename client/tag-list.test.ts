import { expect, test } from "vitest";
import type { TagSummary } from "../shared/contracts";
import { filterTags, filterPlaceholder, nextSort, sortTags } from "./tag-list";

const tag = (name: string, agents: number, notes = 0): TagSummary => ({
  key: name,
  name,
  hasWorkspaceLabel: false,
  workspaces: [],
  links: [],
  agents: Array.from({ length: agents }, (_, i) => ({ agentId: `${name}-${i}`, workspaceId: "w", taggedAt: "t", title: `${name} agent ${i}`, provider: "claude", workspaceName: null, state: "active" as const })),
  notes: Array.from({ length: notes }, (_, i) => ({ id: `${name}-n${i}`, vendor: "jira" as const, ref: `P-${i}`, title: `Item ${i}`, url: null, status: "ready" as const, text: "", error: null, addedAt: "t", fetchedAt: "t", provider: null, notifyAgentId: null })),
});

test("one sort control cycles recent, name, size, then back", () => {
  expect(nextSort("recent")).toBe("name");
  expect(nextSort("name")).toBe("size");
  expect(nextSort("size")).toBe("recent");
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
