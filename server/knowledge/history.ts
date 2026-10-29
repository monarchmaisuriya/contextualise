import type { BusyFile } from "../../shared/knowledge";
import { git } from "./git";

export const BUSY_DAYS = 90;
const BUSY_COMMITS = 3_000;
const BUSY_TIMEOUT_MS = 20_000;
const BUSY_FILES = 200;

// `git log --format=%x00%ct --name-only` output: per commit a NUL, its time, then the files it touched.
// Areas are filled in when the files are shown, against the project's current areas.
export function parseLog(text: string, limit = BUSY_FILES): BusyFile[] {
  const files = new Map<string, { changes: number; last: number }>();
  for (const commit of text.split("\0")) {
    const [time, ...paths] = commit.split("\n").map((line) => line.trim());
    const at = Number(time);
    if (!Number.isFinite(at) || at <= 0) continue;
    for (const path of paths.filter(Boolean)) {
      const seen = files.get(path) ?? { changes: 0, last: 0 };
      files.set(path, { changes: seen.changes + 1, last: Math.max(seen.last, at) });
    }
  }
  return [...files.entries()]
    .map(([path, { changes, last }]) => ({ path, changes, lastAt: new Date(last * 1000).toISOString(), area: null }))
    .sort((a, b) => b.changes - a.changes || b.lastAt.localeCompare(a.lastAt) || a.path.localeCompare(b.path))
    .slice(0, limit);
}

// The files changed most in the last BUSY_DAYS days, from at most BUSY_COMMITS commits (read-only).
// A repository with no commits yet has no history, which is not a failure: `git log` would fail on
// its unborn branch, so that case is answered first.
export async function recentChanges(top: string): Promise<BusyFile[]> {
  if ((await git(top, ["rev-list", "-n", "1", "--all"], BUSY_TIMEOUT_MS)).trim() === "") return [];
  return parseLog(await git(top, ["log", `--since=${BUSY_DAYS}.days`, "--no-merges", "--name-only", "--format=%x00%ct", "-n", String(BUSY_COMMITS)], BUSY_TIMEOUT_MS));
}
