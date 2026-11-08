import { expect, test } from "vitest";
import { broughtLine, projectMeta, workspaceRows } from "./workspace-rows";

const local = (workspaceId: string, name: string, repositories: string[], activeAt: string | null = null) => ({ workspaceId, name, project: "Develop", path: "/d", branch: null, attaches: "workspace" as const, repositories, activeAt });
const words = (search: string) => (...texts: (string | null)[]) => search === "" || texts.some((text) => text?.toLowerCase().includes(search));

test("one row per local workspace, attached as a whole, saying how many repositories it brings", () => {
  expect(workspaceRows([local("w1", "Scan codebases", ["/d/web", "/d/api"]), local("w2", "Fix login", ["/d/api"]), local("w3", "Plan", [])], words(""))).toEqual([
    { key: "w1", title: "Scan codebases", meta: "2 repositories · Develop", attachedWorkspaceId: "w1" },
    { key: "w2", title: "Fix login", meta: "1 repository · Develop", attachedWorkspaceId: "w2" },
    { key: "w3", title: "Plan", meta: "no repositories yet · Develop", attachedWorkspaceId: "w3" },
  ]);
});

test("finds a workspace by a repository it brings, and a worktree still attaches its own folder", () => {
  expect(workspaceRows([local("w1", "Scan codebases", ["/d/web", "/d/api"]), local("w2", "Fix login", ["/d/auth"])], words("api")).map((row) => row.key)).toEqual(["w1"]);
  const [row] = workspaceRows([{ workspaceId: "wt", name: "lavish-otter", project: "api", path: "/w/otter", branch: "fix/1", attaches: "worktree", repositories: [], activeAt: null }], words(""));
  expect(row).toEqual({ key: "wt", title: "lavish-otter", meta: "fix/1 · api", path: "/w/otter", attachedWorkspaceId: "wt" });
});

test("leads with when the workspace was last active, as Attach > Chat does", () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const [local3h, worktree2d] = workspaceRows([local("w1", "Scan", ["/d/web"], "2026-11-08T09:00:00.000Z"), { workspaceId: "wt", name: "otter", project: "api", path: "/w/otter", branch: "fix/1", attaches: "worktree", repositories: [], activeAt: "2026-11-06T12:00:00.000Z" }], words(""), now);
  expect(local3h.meta).toBe("3h · 1 repository · Develop");
  expect(worktree2d.meta).toBe("2d · fix/1 · api");
});

test("names what an attached workspace brings, or says it brings nothing yet", () => {
  expect(broughtLine({ workspaceId: "w1", name: "Develop / Scan", folders: ["/d/web", "/d/api"] })).toBe("web, api");
  expect(broughtLine({ workspaceId: "w1", name: "Develop / Scan", folders: [] })).toContain("No repositories yet");
});

test("a Projects tab row leads with when the project was last active, then its folder", () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  expect(projectMeta({ name: "api", path: "/src/api", activeAt: "2026-11-08T11:00:00.000Z" }, now)).toBe("1h · /src/api");
  expect(projectMeta({ name: "api", path: "/src/api", activeAt: null }, now)).toBe("/src/api");
});
