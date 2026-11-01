import type { KnowledgeOverview, KnowledgeUsage } from "../shared/knowledge";
import { plural } from "./plural";

// One line on how agents used a project's knowledge tools lately, or null before any agent got them.
export function usageLine(usage: KnowledgeUsage): string | null {
  if (usage.agentsGiven === 0) return null;
  const calls = [
    plural(usage.calls.knowledge_search, "search").replace(/searchs$/, "searches"),
    plural(usage.calls.knowledge_read, "read"),
    plural(usage.calls.knowledge_outline, "outline"),
    plural(usage.calls.knowledge_history, "history lookup"),
  ].filter((part) => !part.startsWith("0 "));
  return `Last ${usage.days} days: ${usage.agentsUsed} of ${plural(usage.agentsGiven, "agent")} used project knowledge${calls.length > 0 ? ` (${calls.join(", ")})` : ""}.`;
}

// What a new agent in the project gets now, from the overview the server would give it.
export function overviewLine(overview: KnowledgeOverview): string {
  switch (overview.state) {
    case "off":
      return "Nothing: project knowledge is off here, so new agents start without it.";
    case "unavailable":
      return "A notice that project knowledge is unavailable; Preview says why.";
    case "given":
      return overview.text === null ? "The knowledge tools only: the overview is set to 0 lines in Settings." : `A ${overview.lines}-line overview and the knowledge tools.`;
  }
}
