import type { Busy, BusyFile } from "../../shared/knowledge";
import { git } from "./git";

export const BUSY_DAYS = 90;
const BUSY_COMMITS = 3_000;
// Commit times alone are cheap to read, so far more of them are counted than commits with files.
const COMMIT_TIMES = 20_000;
const BUSY_TIMEOUT_MS = 20_000;
const BUSY_FILES = 200;
const DAY_SECONDS = 86_400;

export type ChangeHistory = Pick<Busy, "files" | "filesChanged" | "filesTruncated" | "commits" | "commitsTruncated">;

// `git log --format=%x00%ct --name-only` output: per commit a NUL, its time, then the files it touched.
// Counts per file over 90, 30, and 7 days before `now` (epoch seconds), and distinct files per window
// over every file, before the list is cut to the busiest. Areas are filled in when the files are shown.
export function parseLog(text: string, now: number, limit = BUSY_FILES): Pick<ChangeHistory, "files" | "filesChanged"> & { commits: number } {
  const files = new Map<string, { changes: number; week: number; month: number; last: number }>();
  let commits = 0;
  for (const commit of text.split("\0")) {
    const [time, ...paths] = commit.split("\n").map((line) => line.trim());
    const at = Number(time);
    if (!Number.isFinite(at) || at <= 0) continue;
    commits += 1;
    const age = now - at;
    for (const path of paths.filter(Boolean)) {
      const seen = files.get(path) ?? { changes: 0, week: 0, month: 0, last: 0 };
      files.set(path, { changes: seen.changes + 1, week: seen.week + (age <= 7 * DAY_SECONDS ? 1 : 0), month: seen.month + (age <= 30 * DAY_SECONDS ? 1 : 0), last: Math.max(seen.last, at) });
    }
  }
  const all = [...files.values()];
  return {
    commits,
    filesChanged: { week: all.filter((file) => file.week > 0).length, month: all.filter((file) => file.month > 0).length, quarter: all.length },
    files: busiest([...files.entries()].map(([path, { changes, week, month, last }]) => ({ path, changes, recent: { week, month }, lastAt: new Date(last * 1000).toISOString(), area: null })), limit),
  };
}

// The busiest `limit` files of each window (90, 30, and 7 days) together, busiest over 90 days first,
// so a file busy only this week is still there for the 7-day view.
function busiest(files: BusyFile[], limit: number): BusyFile[] {
  const top = (count: (file: BusyFile) => number) =>
    files
      .filter((file) => count(file) > 0)
      .sort((a, b) => count(b) - count(a) || b.lastAt.localeCompare(a.lastAt) || a.path.localeCompare(b.path))
      .slice(0, limit);
  const kept = new Set([...top((file) => file.changes), ...top((file) => file.recent.month), ...top((file) => file.recent.week)]);
  return [...kept].sort((a, b) => b.changes - a.changes || b.lastAt.localeCompare(a.lastAt) || a.path.localeCompare(b.path));
}

// The last 90 days of history (read-only): files changed, from at most BUSY_COMMITS commits, and
// every commit's time, from at most COMMIT_TIMES. A repository with no commits yet has no history,
// which is not a failure: `git log` would fail on its unborn branch, so that case is answered first.
export async function recentChanges(top: string, now: number): Promise<ChangeHistory> {
  if ((await git(top, ["rev-list", "-n", "1", "--all"], BUSY_TIMEOUT_MS)).trim() === "") return { files: [], filesChanged: { week: 0, month: 0, quarter: 0 }, filesTruncated: false, commits: [], commitsTruncated: false };
  const since = `--since=${BUSY_DAYS}.days`;
  const named = parseLog(await git(top, ["log", since, "--no-merges", "--name-only", "--format=%x00%ct", "-n", String(BUSY_COMMITS)], BUSY_TIMEOUT_MS), now);
  const commits = (await git(top, ["log", since, "--no-merges", "--format=%ct", "-n", String(COMMIT_TIMES)], BUSY_TIMEOUT_MS))
    .split("\n")
    .map(Number)
    .filter((at) => Number.isFinite(at) && at > 0);
  return { files: named.files, filesChanged: named.filesChanged, filesTruncated: named.commits >= BUSY_COMMITS, commits, commitsTruncated: commits.length >= COMMIT_TIMES };
}
