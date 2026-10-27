import { expect, test } from "vitest";
import { mergeTags, type DirectoryWorkspace } from "./tags";

function workspace(id: string, labels: string[]): DirectoryWorkspace {
  return { id, name: `ws-${id}`, projectDisplayName: "payments", projectRootPath: "/src/payments", workspaceDirectory: `/src/payments/${id}`, labels };
}

test("a workspace label and an agent tag with the same name are one tag, named as the label", () => {
  const tags = mergeTags(
    { "auth rewrite": { name: "auth   rewrite", agents: [{ agentId: "a1", workspaceId: "w9", taggedAt: "2026-10-27T10:00:00Z" }], links: [{ url: "https://e.com/", title: "Spec", taggedAt: "2026-10-27T11:00:00Z" }], notes: [] } },
    { workspaces: [workspace("w1", ["Auth Rewrite"])], agents: [{ id: "a1", title: "Fix login", provider: "claude", archivedAt: null }] },
  );
  expect(tags).toHaveLength(1);
  expect(tags[0]).toMatchObject({ key: "auth rewrite", name: "Auth Rewrite", hasWorkspaceLabel: true });
  expect(tags[0].workspaces).toEqual([{ workspaceId: "w1", name: "ws-w1", projectName: "payments", directory: "/src/payments/w1" }]);
  expect(tags[0].agents).toEqual([{ agentId: "a1", workspaceId: "w9", taggedAt: "2026-10-27T10:00:00Z", title: "Fix login", provider: "claude", state: "active" }]);
  expect(tags[0].links).toEqual([{ url: "https://e.com/", title: "Spec", taggedAt: "2026-10-27T11:00:00Z" }]);
});

test("agents are active, archived, or missing by what the daemon still knows", () => {
  const [tag] = mergeTags(
    {
      x: {
        name: "x",
        agents: [
          { agentId: "live", workspaceId: "w", taggedAt: "t1" },
          { agentId: "old", workspaceId: "w", taggedAt: "t2" },
          { agentId: "gone", workspaceId: "w", taggedAt: "t3" },
        ],
        links: [],
        notes: [],
      },
    },
    {
      workspaces: [],
      agents: [
        { id: "live", title: null, provider: "codex" },
        { id: "old", title: "Old", provider: "claude", archivedAt: "2026-10-01T00:00:00Z" },
      ],
    },
  );
  expect(tag.agents.map((agent) => [agent.agentId, agent.state])).toEqual([
    ["live", "active"],
    ["old", "archived"],
    ["gone", "missing"],
  ]);
  expect(tag.hasWorkspaceLabel).toBe(false);
});

test("recently tagged first, then label-only tags by name", () => {
  const tags = mergeTags(
    {
      older: { name: "older", agents: [{ agentId: "a", workspaceId: "w", taggedAt: "2026-10-01T00:00:00Z" }], links: [], notes: [] },
      newer: { name: "newer", agents: [], links: [{ url: "https://e.com/", title: "e", taggedAt: "2026-10-20T00:00:00Z" }], notes: [] },
    },
    { workspaces: [workspace("w1", ["zeta", "alpha"])], agents: [] },
  );
  expect(tags.map((tag) => tag.key)).toEqual(["newer", "older", "alpha", "zeta"]);
});
