import { describe, expect, it } from "vitest";
import { agentTitle, capTitle, cleanTitle, gitParts, workspaceLabel, workspaceTitle } from "./rows";
import type { DirectoryWorkspace } from "./tags";

const worktree = (overrides: Partial<DirectoryWorkspace> = {}): DirectoryWorkspace => ({
  id: "w1",
  name: "glorious-tiger",
  title: "Review PR 5854",
  projectDisplayName: "payments",
  projectRootPath: "/src/payments",
  workspaceKind: "worktree",
  worktreeSlug: "glorious-tiger",
  ...overrides,
});

describe("workspace names", () => {
  it("uses the title Paseo shows, falling back to the name", () => {
    expect(workspaceTitle(worktree())).toBe("Review PR 5854");
    expect(workspaceTitle(worktree({ title: "  " }))).toBe("glorious-tiger");
    expect(workspaceTitle(worktree({ title: null }))).toBe("glorious-tiger");
  });

  it("names the project too, once", () => {
    expect(workspaceLabel(worktree())).toBe("payments / Review PR 5854");
    expect(workspaceLabel(worktree({ title: null, name: "payments" }))).toBe("payments");
  });
});

describe("agentTitle", () => {
  const agent = { title: "scan https://github.com/acme/api/pull/5854 review the auth change", id: "a1" };

  it("gives an agent in a titled worktree the worktree's title", () => {
    expect(agentTitle(agent, worktree(), 1, { maxChars: 44, shortenLinks: true })).toEqual({ title: "Review PR 5854", includesWorkspace: true });
  });

  it("adds each agent's own prompt when several share the worktree", () => {
    expect(agentTitle(agent, worktree(), 2, { maxChars: 44, shortenLinks: true })).toEqual({ title: "Review PR 5854 · scan github.com/acme/api/p…", includesWorkspace: true });
  });

  it("keeps the prompt in plain folders and in worktrees that have no title of their own", () => {
    for (const workspace of [worktree({ workspaceKind: "directory" }), worktree({ title: null }), worktree({ title: "glorious-tiger" }), undefined]) {
      expect(agentTitle(agent, workspace, 1, { maxChars: 44, shortenLinks: true })).toEqual({ title: "scan github.com/acme/api/pull/5854 review…", includesWorkspace: false });
    }
  });

  it("falls back to the agent id when there is no title at all", () => {
    expect(agentTitle({ title: null, id: "a1" }, undefined, 1, { maxChars: 44, shortenLinks: true }).title).toBe("a1");
  });
});

describe("capTitle", () => {
  it("cuts long titles at a word where it can, ending in …", () => {
    expect(capTitle("Plan fix for Astra finding AS 04 in the dashboard", 30)).toBe("Plan fix for Astra finding AS…");
    expect(capTitle("short", 30)).toBe("short");
    expect(capTitle("x".repeat(40), 20)).toBe(`${"x".repeat(19)}…`);
  });
});

describe("gitParts", () => {
  it("names the branch, the uncommitted changes, and the pull request", () => {
    expect(gitParts(worktree({ gitRuntime: { currentBranch: "fix-refs", isDirty: true }, diffStat: { additions: 12, deletions: 3 }, githubRuntime: { pullRequest: { number: 42, state: "open", isDraft: false } } }))).toEqual(["fix-refs", "+12 −3", "PR #42"]);
  });

  it("says uncommitted without counts, and marks draft and merged pull requests", () => {
    expect(gitParts(worktree({ gitRuntime: { currentBranch: "main", isDirty: true }, githubRuntime: { pullRequest: { number: 7, state: "open", isDraft: true } } }))).toEqual(["main", "uncommitted", "PR #7 draft"]);
    expect(gitParts(worktree({ githubRuntime: { pullRequest: { number: 8, state: "MERGED" } } }))).toEqual(["PR #8 merged"]);
  });

  it("shows nothing Paseo did not send", () => {
    expect(gitParts(worktree())).toEqual([]);
    expect(gitParts(undefined)).toEqual([]);
    expect(gitParts(worktree({ diffStat: { additions: 0, deletions: 0 }, gitRuntime: { currentBranch: null, isDirty: false } }))).toEqual([]);
  });
});

describe("cleanTitle", () => {
  it("drops Markdown marks and shortens links", () => {
    expect(cleanTitle("  ## Plan __things__  ", true)).toBe("Plan things");
    expect(cleanTitle("scan https://acme.atlassian.net/browse/PROJ-5896 now", true)).toBe("scan acme.atlassian.net/browse/PROJ-5896 now");
  });
});
