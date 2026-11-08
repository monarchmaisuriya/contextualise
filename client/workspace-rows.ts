import type { WorkspaceLinksPayload } from "../shared/linked-projects";
import { shortTimeAgo } from "../shared/time";

type Choice = WorkspaceLinksPayload["workspaces"][number];
type Attached = WorkspaceLinksPayload["attachedWorkspaces"][number];
type Project = WorkspaceLinksPayload["suggestions"][number];

// One Workspaces-tab row per workspace. A worktree attaches its own folder; a local workspace attaches
// as a whole (no path), bringing the repositories its chats changed.
export type WorkspaceRow = { key: string; title: string; meta: string; path?: string; attachedWorkspaceId: string };

const folderName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// What a row says after its title: when the workspace was last active (as Attach > Chat shows it),
// then a worktree's branch and project, or how many repositories a local workspace brings and its project.
function workspaceMeta(found: Choice, now: number): string {
  const active = found.activeAt ? shortTimeAgo(found.activeAt, now) : null;
  const gives = found.attaches === "worktree" ? [found.branch, found.project] : [found.repositories.length === 0 ? "no repositories yet" : `${found.repositories.length} ${found.repositories.length === 1 ? "repository" : "repositories"}`, found.project];
  return [active, ...gives].filter(Boolean).join(" · ");
}

// A search finds a workspace by its title, project, branch, or a repository it brings.
export function workspaceRows(found: readonly Choice[], has: (...texts: (string | null)[]) => boolean, now = Date.now()): WorkspaceRow[] {
  return found
    .filter((choice) => has(choice.name, choice.project, choice.branch, ...choice.repositories.map(folderName)))
    .map((choice) => ({ key: choice.workspaceId, title: choice.name, meta: workspaceMeta(choice, now), ...(choice.attaches === "worktree" ? { path: choice.path } : {}), attachedWorkspaceId: choice.workspaceId }));
}

// An attached local workspace's line under its name: the repositories it brings.
export function broughtLine(attached: Attached): string {
  return attached.folders.length === 0 ? "No repositories yet: it brings the ones its chats change" : attached.folders.map(folderName).join(", ");
}

// What a Projects tab row says after its name: when the project was last active, then its folder.
export function projectMeta(found: Project, now = Date.now()): string {
  return [found.activeAt ? shortTimeAgo(found.activeAt, now) : null, found.path].filter(Boolean).join(" · ");
}
