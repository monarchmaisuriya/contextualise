import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGitRepo, repoKeyFromRemote } from "./git";

// The same cases as Memorise's repo-key tests: both plugins must name a repository identically.
describe("repoKeyFromRemote", () => {
  it.each([
    ["https://github.com/Acme/Api.git", "github.com/acme/api"],
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    ["ssh://git@gitlab.example.com:2222/group/sub/repo", "gitlab.example.com/group/sub/repo"],
    ["work-github:acme/api.git", "work-github/acme/api"],
  ])("%s -> %s", (remote, key) => {
    expect(repoKeyFromRemote(remote)).toBe(key);
  });

  it.each(["", "not a url", "C:/src/app", "file:///tmp/repo", "git@folder:notes-0123456789ab", "https://local/abc"])("rejects %s", (remote) => {
    expect(repoKeyFromRemote(remote)).toBeNull();
  });
});

describe("readGitRepo", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const temp = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-git-")));
    made.push(dir);
    return dir;
  };

  it("keys a repo by its origin from any folder inside it, and finds none outside git", async () => {
    const repo = temp();
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/api.git"]);
    mkdirSync(join(repo, "src"));
    expect(await readGitRepo(join(repo, "src"))).toEqual({ key: "github.com/acme/api", top: repo });
    expect((await readGitRepo(join(repo, ".git")))?.key).toBe("github.com/acme/api");
    expect(await readGitRepo(temp())).toBeNull();
  });

  it("keys a repo without an origin by its git folder, shared by its worktrees", async () => {
    const repo = temp();
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "start"]);
    const tree = join(temp(), "tree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", tree]);
    const key = (await readGitRepo(repo))?.key;
    expect(key).toMatch(/^local\/[0-9a-f]{16}$/);
    expect((await readGitRepo(tree))?.key).toBe(key);
  });
});
