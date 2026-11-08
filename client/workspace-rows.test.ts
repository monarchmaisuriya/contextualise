import { expect, test } from "vitest";
import { workspaceItems } from "./workspace-rows";

const repo = (workspaceId: string, name: string, path: string) => ({ workspaceId, name, project: "Develop", path, branch: null, attaches: "repository" as const });
const all = () => true;

test("puts a workspace's repositories under one heading with its title, each row named by its folder", () => {
  const items = workspaceItems([repo("w1", "Scan codebases", "/d/web"), repo("w1", "Scan codebases", "/d/api"), repo("w2", "Fix login", "/d/api")], all);
  expect(items).toEqual([
    { kind: "heading", key: "w1", title: "Scan codebases", meta: "2 repositories · Develop" },
    { kind: "row", key: "w1|/d/web", title: "web", meta: "/d/web", path: "/d/web", attachedWorkspaceId: undefined, nested: true },
    { kind: "row", key: "w1|/d/api", title: "api", meta: "/d/api", path: "/d/api", attachedWorkspaceId: undefined, nested: true },
    { kind: "row", key: "w2|/d/api", title: "Fix login", meta: "api · Develop", path: "/d/api", attachedWorkspaceId: undefined, nested: false },
  ]);
});

test("keeps the heading over the repositories a search leaves, and drops a workspace with none left", () => {
  const items = workspaceItems([repo("w1", "Scan codebases", "/d/web"), repo("w1", "Scan codebases", "/d/api"), repo("w2", "Fix login", "/d/web")], (choice) => choice.path.endsWith("api"));
  expect(items.map((item) => [item.kind, item.title])).toEqual([
    ["heading", "Scan codebases"],
    ["row", "api"],
  ]);
});

test("a worktree or folder row still names its workspace so the link lapses with it", () => {
  const [row] = workspaceItems([{ workspaceId: "wt", name: "lavish-otter", project: "api", path: "/w/otter", branch: "fix/1", attaches: "worktree" }], all);
  expect(row).toMatchObject({ kind: "row", title: "lavish-otter", meta: "fix/1 · api", attachedWorkspaceId: "wt", nested: false });
});
