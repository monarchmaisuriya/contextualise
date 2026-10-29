import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

// Same as Memorise (memorise/server/git.ts and repo-key.ts); plugins cannot import each other, and
// both must name a repository the same way for Memorise's export files to line up.
const runFile = promisify(execFile);
const GIT_TIMEOUT_MS = 1_500;

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

// A git blocked on a hung mount can ignore the kill from execFile's own timeout, and Paseo fails
// agent creation when a hook takes 30 s, so every call also races a deadline of its own.
export async function git(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GitError(`git ${args[0]} gave no answer in ${timeoutMs} ms`, null, "")), timeoutMs);
  });
  try {
    const { stdout } = await Promise.race([
      runFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 }),
      deadline,
    ]);
    return stdout.trimEnd();
  } catch (error) {
    if (error instanceof GitError) throw error;
    const exitCode: unknown = Reflect.get(Object(error), "code");
    const stderr: unknown = Reflect.get(Object(error), "stderr");
    throw new GitError(
      `git ${args.join(" ")} failed: ${typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(error)}`,
      typeof exitCode === "number" ? exitCode : null,
      typeof stderr === "string" ? stderr : "",
    );
  } finally {
    clearTimeout(timer);
  }
}

const REPO_KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._~-]+)+$/;
// A one-letter host is a Windows drive, as in "C:/src/app".
const SCP_LIKE_REMOTE = /^(?:[^/@]+@)?([^:/\\]{2,}):(.+)$/;
// Keys under these hosts are made by Memorise for repos without an origin and folders outside git.
const RESERVED_HOSTS = new Set(["folder", "local"]);

function splitRemote(url: string): { host: string; path: string } | null {
  const scpLike = url.includes("://") ? null : SCP_LIKE_REMOTE.exec(url);
  if (scpLike) return { host: scpLike[1], path: scpLike[2] };
  if (!URL.canParse(url)) return null;
  const { hostname, pathname } = new URL(url);
  return hostname === "" ? null : { host: hostname, path: pathname };
}

export function isRepoKey(key: string): boolean {
  return key.length <= 200 && REPO_KEY.test(key) && !key.split("/").includes("..");
}

// Clones and worktrees of one repository share the key, whatever folder they live in.
export function repoKeyFromRemote(remoteUrl: string): string | null {
  const remote = splitRemote(remoteUrl.trim());
  if (!remote || RESERVED_HOSTS.has(remote.host.toLowerCase())) return null;
  const segments = remote.path
    .toLowerCase()
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter((segment) => segment !== "");
  const key = [remote.host.toLowerCase(), ...segments].join("/");
  return isRepoKey(key) ? key : null;
}

// Worktrees of a repository with no origin share one git common dir.
export function repoKeyFromCommonDir(commonDir: string): string {
  return `local/${createHash("sha256").update(commonDir).digest("hex").slice(0, 16)}`;
}

export interface GitRepo {
  key: string;
  top: string;
}

// The repository `cwd` is in, or null outside git. Project knowledge is built from tracked files, so
// a folder outside git has none. Any other git failure is thrown.
export async function readGitRepo(cwd: string): Promise<GitRepo | null> {
  try {
    const remote = await git(cwd, ["config", "--get", "remote.origin.url"]).catch((error: unknown) => {
      // `git config --get` exits 1 when the key is absent: a repo without an origin.
      if (error instanceof GitError && error.exitCode === 1) return "";
      throw error;
    });
    // A bare repo or a folder inside .git has no work tree; its own folder stands in for one.
    const top = await realpath(
      await git(cwd, ["rev-parse", "--show-toplevel"]).catch((error: unknown) => {
        if (error instanceof GitError && error.stderr.includes("must be run in a work tree")) return cwd;
        throw error;
      }),
    );
    const fromRemote = remote === "" ? null : repoKeyFromRemote(remote);
    if (fromRemote) return { key: fromRemote, top };
    const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return { key: repoKeyFromCommonDir(await realpath(commonDir)), top };
  } catch (error) {
    if (error instanceof GitError && error.stderr.includes("not a git repository")) return null;
    throw error;
  }
}
