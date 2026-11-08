import type { WorkspaceLinksPayload } from "../shared/linked-projects";

type Choice = WorkspaceLinksPayload["workspaces"][number];

// The Workspaces tab's list. A local workspace whose chats changed more than one repository offers
// each of them; those rows sit under one heading with the workspace's title, so one workspace does
// not read as several. Every other workspace is one row. The heading is not a choice.
export type WorkspaceItem =
  | { kind: "heading"; key: string; title: string; meta: string }
  | { kind: "row"; key: string; title: string; meta: string; path: string; attachedWorkspaceId?: string; nested: boolean };

// What a single row attaches, after its title: a worktree's branch and project, a repository's folder
// name and project, or a local workspace's whole folder.
function workspaceMeta(found: Choice): string {
  if (found.attaches === "worktree") return [found.branch, found.project].filter(Boolean).join(" · ");
  if (found.attaches === "repository") return `${folderName(found.path)} · ${found.project}`;
  return `all of ${found.project}`;
}

const folderName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Groups by workspace in the order the daemon sent them. Whether a workspace is grouped is decided on
// the whole list, before `matches` narrows it, so a search keeps the heading over what is left.
export function workspaceItems(found: readonly Choice[], matches: (choice: Choice) => boolean): WorkspaceItem[] {
  const byWorkspace = new Map<string, Choice[]>();
  for (const choice of found) byWorkspace.set(choice.workspaceId, [...(byWorkspace.get(choice.workspaceId) ?? []), choice]);
  const items: WorkspaceItem[] = [];
  for (const [workspaceId, choices] of byWorkspace) {
    const shown = choices.filter(matches);
    if (shown.length === 0) continue;
    const attachedWorkspaceId = (choice: Choice) => (choice.attaches === "repository" ? undefined : choice.workspaceId);
    if (choices.length === 1) {
      const [choice] = shown;
      items.push({ kind: "row", key: `${workspaceId}|${choice.path}`, title: choice.name, meta: workspaceMeta(choice), path: choice.path, attachedWorkspaceId: attachedWorkspaceId(choice), nested: false });
      continue;
    }
    items.push({ kind: "heading", key: workspaceId, title: choices[0].name, meta: `${choices.length} repositories · ${choices[0].project}` });
    for (const choice of shown) items.push({ kind: "row", key: `${workspaceId}|${choice.path}`, title: folderName(choice.path), meta: choice.path, path: choice.path, attachedWorkspaceId: attachedWorkspaceId(choice), nested: true });
  }
  return items;
}
