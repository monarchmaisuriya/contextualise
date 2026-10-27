import type { TagSummary } from "../shared/contracts";

const NAME_MAX_CHARS = 24;

// The pill's text: "Tag" when the agent has none, else its most recent tag and how many more.
export function pillLabel(names: readonly string[]): string {
  if (names.length === 0) return "Tag";
  const first = names[0].length > NAME_MAX_CHARS ? `${names[0].slice(0, NAME_MAX_CHARS - 1)}…` : names[0];
  return names.length === 1 ? first : `${first} +${names.length - 1}`;
}

// Each agent's tag names, in the order tags.list returns them (most recently tagged first).
export function tagNamesByAgent(tags: readonly TagSummary[]): Map<string, string[]> {
  const byAgent = new Map<string, string[]>();
  for (const tag of tags) for (const agent of tag.agents) byAgent.set(agent.agentId, [...(byAgent.get(agent.agentId) ?? []), tag.name]);
  return byAgent;
}
