import { expect, test } from "vitest";
import type { TagSummary } from "../shared/contracts";
import { pillLabel, tagNamesByAgent } from "./pill-label";

test("the pill says Tag, the tag, or the first tag and how many more", () => {
  expect(pillLabel([])).toBe("Tag");
  expect(pillLabel(["auth rewrite"])).toBe("auth rewrite");
  expect(pillLabel(["auth rewrite", "billing", "infra"])).toBe("auth rewrite +2");
  expect(pillLabel(["a very long tag name that keeps going"])).toBe("a very long tag name th…");
});

test("tag names are grouped by agent in list order", () => {
  const tag = (name: string, agentIds: string[]): TagSummary => ({
    key: name,
    name,
    hasWorkspaceLabel: false,
    workspaces: [],
    links: [],
    notes: [],
    agents: agentIds.map((agentId) => ({ agentId, workspaceId: "w", taggedAt: "t", title: null, provider: null, state: "active" })),
  });
  const byAgent = tagNamesByAgent([tag("newest", ["a1"]), tag("older", ["a1", "a2"])]);
  expect(byAgent.get("a1")).toEqual(["newest", "older"]);
  expect(byAgent.get("a2")).toEqual(["older"]);
  expect(byAgent.has("a3")).toBe(false);
});
