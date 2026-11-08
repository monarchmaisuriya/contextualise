import type { WorkspaceLinksPayload } from "../shared/linked-projects";

type Choice = WorkspaceLinksPayload["workspaces"][number];
type Attached = WorkspaceLinksPayload["attachedWorkspaces"][number];

// One Workspaces-tab row per workspace. A worktree attaches its own folder; a local workspace attaches
// as a whole (no path), bringing the repositories its chats changed.
export type WorkspaceRow = { key: string; title: string; meta: string; path?: string; attachedWorkspaceId: string };

const folderName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// What picking a row gives, after its title: a worktree's branch and project, or how many repositories
// a local workspace brings and its project.
function workspaceMeta(found: Choice): string {
  if (found.attaches === "worktree") return [found.branch, found.project].filter(Boolean).join(" · ");
  return `${found.repositories.length === 0 ? "no repositories yet" : `${found.repositories.length} ${found.repositories.length === 1 ? "repository" : "repositories"}`} · ${found.project}`;
}

// A search finds a workspace by its title, project, branch, or a repository it brings.
export function workspaceRows(found: readonly Choice[], has: (...texts: (string | null)[]) => boolean): WorkspaceRow[] {
  return found
    .filter((choice) => has(choice.name, choice.project, choice.branch, ...choice.repositories.map(folderName)))
    .map((choice) => ({ key: choice.workspaceId, title: choice.name, meta: workspaceMeta(choice), ...(choice.attaches === "worktree" ? { path: choice.path } : {}), attachedWorkspaceId: choice.workspaceId }));
}

// An attached local workspace's line under its name: the repositories it brings.
export function broughtLine(attached: Attached): string {
  return attached.folders.length === 0 ? "No repositories yet: it brings the ones its chats change" : attached.folders.map(folderName).join(", ");
}
