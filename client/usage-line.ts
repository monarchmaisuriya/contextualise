import type { KnowledgeUsage } from "../shared/knowledge";
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
