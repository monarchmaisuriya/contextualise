import { normalizeTagName, tagKey, type AgentMember, type TagSummary, type WorkspaceMember } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import type { StoredTags } from "./tag-store";

const PAGE_LIMIT = 200;

export interface DirectoryWorkspace {
  id: string;
  name: string;
  projectDisplayName: string;
  workspaceDirectory?: string;
  projectRootPath: string;
  labels?: string[];
}

export interface DirectoryAgent {
  id: string;
  title: string | null;
  provider: string;
  archivedAt?: string | null;
  workspaceId?: string;
  cwd?: string;
  updatedAt?: string;
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

// One list of tags: every workspace label name joined with the agents and links tagged under the
// same name. Most recently tagged first; tags that exist only as workspace labels follow, by name.
export function mergeTags(stored: StoredTags, directory: Directory): TagSummary[] {
  const byKey = new Map<string, TagSummary>();
  const entry = (name: string) => {
    const key = tagKey(name);
    let tag = byKey.get(key);
    if (!tag) {
      tag = { key, name: normalizeTagName(name), hasWorkspaceLabel: false, workspaces: [], agents: [], links: [] };
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
        name: workspace.name,
        projectName: workspace.projectDisplayName,
        directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
      };
      tag.workspaces.push(member);
    }
  }

  const agentsById = new Map(directory.agents.map((agent) => [agent.id, agent]));
  for (const storedTag of Object.values(stored)) {
    const tag = entry(storedTag.name);
    for (const member of storedTag.agents) {
      const agent = agentsById.get(member.agentId);
      const summary: AgentMember = {
        agentId: member.agentId,
        workspaceId: member.workspaceId,
        taggedAt: member.taggedAt,
        title: agent?.title ?? null,
        provider: agent?.provider ?? null,
        state: !agent ? "missing" : agent.archivedAt ? "archived" : "active",
      };
      tag.agents.push(summary);
    }
    tag.links.push(...storedTag.links);
  }

  const lastTagged = (tag: TagSummary) => [...tag.agents, ...tag.links].reduce((latest, member) => (member.taggedAt > latest ? member.taggedAt : latest), "");
  return [...byKey.values()].sort((a, b) => lastTagged(b).localeCompare(lastTagged(a)) || a.name.localeCompare(b.name));
}
