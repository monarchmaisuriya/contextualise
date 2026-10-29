import { shortenLink } from "../shared/links";
import type { DirectoryWorkspace } from "./tags";

// Text for picker rows. Paseo draws a plugin row on one line: the title, which never shrinks, then
// the subtitle in muted text, cut where the popup ends. So titles are kept short and say the most
// in their first words, and subtitles lead with what tells rows apart (time, then git).

// Agent titles are often the first prompt, with Markdown and links in it; a row shows one plain line.
export function cleanTitle(title: string, shortenLinks: boolean): string {
  const plain = title
    .replace(/^\s*#+\s*/, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return shortenLinks ? plain.replace(/https?:\/\/\S+/gi, shortenLink) : plain;
}

// Cut at a word boundary when one is near the end, so "Astra finding AS…" not "Astra findi…".
export function capTitle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const space = text[cut.length] === " " ? cut.length : cut.lastIndexOf(" ");
  const kept = space >= maxChars * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s·,;:]+$/, "")}…`;
}

// The name Paseo shows for a workspace: its title (generated, or set by the user), else its name.
export function workspaceTitle(workspace: Pick<DirectoryWorkspace, "name" | "title">): string {
  return workspace.title?.trim() || workspace.name;
}

// "project / workspace", or just the project for a plain folder named like it.
export function workspaceLabel(workspace: DirectoryWorkspace): string {
  const title = workspaceTitle(workspace);
  return title === workspace.projectDisplayName ? title : `${workspace.projectDisplayName} / ${title}`;
}

// A worktree is one task, so its title names the task; a plain folder's title only names the first
// thing done there. A title equal to the worktree's slug or branch is no title at all.
function taskTitle(workspace: DirectoryWorkspace | undefined): string | null {
  if (!workspace || workspace.workspaceKind !== "worktree") return null;
  const title = workspace.title?.trim();
  if (!title || title === workspace.worktreeSlug || title === workspace.gitRuntime?.currentBranch) return null;
  return title;
}

// An agent's row title: its worktree's title when the worktree is its task ("title · prompt" when
// several agents share it), else its own cleaned prompt. `includesWorkspace` keeps the subtitle
// from naming the workspace twice.
export function agentTitle(
  agent: { title: string | null; id: string },
  workspace: DirectoryWorkspace | undefined,
  sharing: number,
  options: { maxChars: number; shortenLinks: boolean },
): { title: string; includesWorkspace: boolean } {
  const prompt = cleanTitle(agent.title ?? "", options.shortenLinks);
  const task = taskTitle(workspace);
  if (task) return { title: capTitle(sharing > 1 && prompt ? `${task} · ${prompt}` : task, options.maxChars), includesWorkspace: true };
  return { title: capTitle(prompt || agent.id, options.maxChars), includesWorkspace: false };
}

// What Paseo knows about the workspace's git state, in reading order; nothing it did not send.
export function gitParts(workspace: DirectoryWorkspace | undefined): string[] {
  if (!workspace) return [];
  const parts: string[] = [];
  const branch = workspace.gitRuntime?.currentBranch;
  if (branch) parts.push(branch);
  const diff = workspace.diffStat;
  if (diff && diff.additions + diff.deletions > 0) parts.push(`+${diff.additions} −${diff.deletions}`);
  else if (workspace.gitRuntime?.isDirty) parts.push("uncommitted");
  const pr = workspace.githubRuntime?.pullRequest;
  if (pr?.number) {
    const state = pr.isDraft ? " draft" : pr.state.toLowerCase() === "merged" ? " merged" : pr.state.toLowerCase() === "closed" ? " closed" : "";
    parts.push(`PR #${pr.number}${state}`);
  }
  return parts;
}

// Words that find an agent: its prompt, its workspace's title and project, branch, and pull request.
export function workspaceSearchText(workspace: DirectoryWorkspace | undefined): string {
  if (!workspace) return "";
  const pr = workspace.githubRuntime?.pullRequest;
  return [workspaceLabel(workspace), workspace.name, workspace.gitRuntime?.currentBranch, pr?.number ? `#${pr.number} ${pr.number}` : null, pr?.title].filter(Boolean).join(" ");
}
