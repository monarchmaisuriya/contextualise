import type { TagSummary } from "../shared/contracts";

// The pill's text: "Tag" when the agent has none; else its most recent tag and how many more, or
// just the count, as the settings choose.
export function pillLabel(names: readonly string[], style: "names" | "count" = "names", maxChars = 24): string {
  if (names.length === 0) return "Tag";
  if (style === "count") return `${names.length} tag${names.length === 1 ? "" : "s"}`;
  const first = names[0].length > maxChars ? `${names[0].slice(0, maxChars - 1)}…` : names[0];
  return names.length === 1 ? first : `${first} +${names.length - 1}`;
}

// Each agent's tag names, in the order tags.list returns them (most recently tagged first).
export function tagNamesByAgent(tags: readonly TagSummary[]): Map<string, string[]> {
  const byAgent = new Map<string, string[]>();
  for (const tag of tags) for (const agent of tag.agents) byAgent.set(agent.agentId, [...(byAgent.get(agent.agentId) ?? []), tag.name]);
  return byAgent;
}
