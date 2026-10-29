import { normalizeTagName, tagKey, type AgentInfo, type AgentMember, type PinnedAgent, type TagSummary, type WorkspaceMember } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import { workspaceTitle } from "./rows";
import type { StoredPin, StoredTags } from "./tag-store";

const PAGE_LIMIT = 200;

// The parts of Paseo's workspace descriptor Contextualise reads. Git and pull request details are
// present only when Paseo has them.
export interface DirectoryWorkspace {
  id: string;
  name: string;
  title?: string | null;
  projectDisplayName: string;
  workspaceDirectory?: string;
  projectRootPath: string;
  labels?: string[];
  workspaceKind?: string;
  worktreeSlug?: string;
  gitRuntime?: { currentBranch?: string | null; isDirty?: boolean | null } | null;
  diffStat?: { additions: number; deletions: number } | null;
  githubRuntime?: { pullRequest?: { number?: number; state: string; isDraft?: boolean; title?: string } | null } | null;
}

export interface DirectoryAgent {
  id: string;
  title: string | null;
  provider: string;
  archivedAt?: string | null;
  workspaceId?: string;
  cwd?: string;
  updatedAt?: string;
  status?: string;
  // Paseo's own background agents.
  internal?: boolean;
}

export interface Directory {
  workspaces: DirectoryWorkspace[];
  agents: DirectoryAgent[];
}

// Every workspace and every agent (archived included) the daemon knows, paged to the end.
export async function readDirectory(paseo: PaseoApi): Promise<Directory> {
  const workspaces: DirectoryWorkspace[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await paseo.workspaces.list({ page: { limit: PAGE_LIMIT, cursor } });
    workspaces.push(...page.entries);
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  const agents: DirectoryAgent[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: PAGE_LIMIT, cursor } });
    agents.push(...page.entries.map((entry) => entry.agent));
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  return { workspaces, agents };
}

// What the daemon knows about one agent; `fallbackWorkspaceId` is where it was when it was tagged.
export function describeAgent(directory: Directory, agentId: string, fallbackWorkspaceId: string | null = null): AgentInfo {
  const agent = directory.agents.find((candidate) => candidate.id === agentId);
  const workspaceId = agent?.workspaceId ?? fallbackWorkspaceId;
  const workspace = workspaceId ? directory.workspaces.find((candidate) => candidate.id === workspaceId) : undefined;
  return {
    agentId,
    title: agent?.title ?? null,
    provider: agent?.provider ?? null,
    workspaceId: agent ? (agent.workspaceId ?? null) : null,
    workspaceName: workspace ? workspaceTitle(workspace) : null,
    state: !agent ? "missing" : agent.archivedAt ? "archived" : "active",
  };
}

// One list of tags: every workspace label name joined with the agents, links, and fetched items
// under the same name. Most recently tagged first; tags that exist only as workspace labels follow, by name.
export function mergeTags(stored: StoredTags, directory: Directory): TagSummary[] {
  const byKey = new Map<string, TagSummary>();
  const entry = (name: string) => {
    const key = tagKey(name);
    let tag = byKey.get(key);
    if (!tag) {
      tag = { key, name: normalizeTagName(name), hasWorkspaceLabel: false, workspaces: [], agents: [], links: [], notes: [] };
      byKey.set(key, tag);
    }
    return tag;
  };

  // Labels are merged first, so a tag that is also a label is spelled the way the label is.
  for (const workspace of directory.workspaces) {
    for (const label of workspace.labels ?? []) {
      const tag = entry(label);
      tag.hasWorkspaceLabel = true;
      const member: WorkspaceMember = {
        workspaceId: workspace.id,
        name: workspaceTitle(workspace),
        projectName: workspace.projectDisplayName,
        directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
      };
      tag.workspaces.push(member);
    }
  }

  for (const storedTag of Object.values(stored)) {
    const tag = entry(storedTag.name);
    for (const member of storedTag.agents) {
      const { title, provider, workspaceName, state } = describeAgent(directory, member.agentId, member.workspaceId);
      const summary: AgentMember = { agentId: member.agentId, workspaceId: member.workspaceId, taggedAt: member.taggedAt, title, provider, workspaceName, state };
      tag.agents.push(summary);
    }
    tag.links.push(...storedTag.links);
    tag.notes.push(...storedTag.notes);
  }

  const lastTagged = (tag: TagSummary) => [...tag.agents.map((m) => m.taggedAt), ...tag.links.map((m) => m.taggedAt), ...tag.notes.map((m) => m.addedAt)].reduce((latest, at) => (at > latest ? at : latest), "");
  return [...byKey.values()].sort((a, b) => lastTagged(b).localeCompare(lastTagged(a)) || a.name.localeCompare(b.name));
}

// Pinned agents as the Tags screen shows them: what the daemon still knows about each, in pin order.
export function mergePins(pins: readonly StoredPin[], directory: Directory): PinnedAgent[] {
  return pins.map(({ agentId, pinnedAt }) => ({ ...describeAgent(directory, agentId), pinnedAt }));
}
