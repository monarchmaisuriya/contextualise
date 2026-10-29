import { expect, test } from "vitest";
import { describeAgent, mergePins, mergeTags, type DirectoryWorkspace } from "./tags";

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
  expect(tags[0].agents).toEqual([{ agentId: "a1", workspaceId: "w9", taggedAt: "2026-10-27T10:00:00Z", title: "Fix login", provider: "claude", workspaceName: null, state: "active" }]);
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

test("pinned agents carry the daemon's title and workspace, or show as missing", () => {
  const pins = mergePins(
    [
      { agentId: "a1", pinnedAt: "t1" },
      { agentId: "gone", pinnedAt: "t2" },
    ],
    { workspaces: [], agents: [{ id: "a1", title: "Fix login", provider: "claude", workspaceId: "w1", archivedAt: "2026-10-02" }] },
  );
  expect(pins).toEqual([
    { agentId: "a1", pinnedAt: "t1", title: "Fix login", provider: "claude", workspaceId: "w1", workspaceName: null, state: "archived" },
    { agentId: "gone", pinnedAt: "t2", title: null, provider: null, workspaceId: null, workspaceName: null, state: "missing" },
  ]);
});

// Plugin screens cannot read Paseo's client state (useWorkspace, useAgent throw there), so the
// server names each agent's workspace.
test("tagged and pinned agents carry their current workspace's name", () => {
  const directory = { workspaces: [workspace("w1", []), workspace("w2", [])], agents: [{ id: "a1", title: "Fix login", provider: "claude", workspaceId: "w2" }] };
  const [tag] = mergeTags({ x: { name: "x", agents: [{ agentId: "a1", workspaceId: "w1", taggedAt: "t" }, { agentId: "gone", workspaceId: "w1", taggedAt: "t" }], links: [], notes: [] } }, directory);
  expect(tag.agents.map((agent) => agent.workspaceName)).toEqual(["ws-w2", "ws-w1"]);
  expect(mergePins([{ agentId: "a1", pinnedAt: "t" }], directory)[0].workspaceName).toBe("ws-w2");
});

test("one agent is described from the directory, or as missing", () => {
  const directory = { workspaces: [workspace("w1", [])], agents: [{ id: "a1", title: "Fix login", provider: "claude", workspaceId: "w1" }] };
  expect(describeAgent(directory, "a1")).toEqual({ agentId: "a1", title: "Fix login", provider: "claude", workspaceId: "w1", workspaceName: "ws-w1", state: "active" });
  expect(describeAgent(directory, "gone")).toEqual({ agentId: "gone", title: null, provider: null, workspaceId: null, workspaceName: null, state: "missing" });
});

test("a workspace renamed in Paseo shows its new title in tags and agent descriptions", () => {
  const renamed: DirectoryWorkspace = { id: "w9", name: "glorious-tiger", title: "Review PR 5854", projectDisplayName: "payments", projectRootPath: "/src/payments", labels: ["auth"] };
  const directory = { workspaces: [renamed], agents: [{ id: "a9", title: "scan", provider: "claude", workspaceId: "w9" }] };
  expect(describeAgent(directory, "a9").workspaceName).toBe("Review PR 5854");
  const [tag] = mergeTags({ auth: { name: "auth", agents: [{ agentId: "a9", workspaceId: "w9", taggedAt: "2026-10-29T10:00:00.000Z" }], links: [], notes: [] } }, directory);
  expect(tag.workspaces[0].name).toBe("Review PR 5854");
  expect(tag.agents[0].workspaceName).toBe("Review PR 5854");
});
