import type { TagSummary } from "../shared/contracts";
import { plural } from "./plural";

export type Sort = "recent" | "name" | "size";
export const SORT_LABELS: Record<Sort, string> = { recent: "Recent", name: "Name", size: "Size" };
const SORTS: readonly Sort[] = ["recent", "name", "size"];

// One sort control: each tap moves to the next order.
export function nextSort(sort: Sort): Sort {
  return SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length];
}

const size = (tag: TagSummary) => tag.agents.length + tag.workspaces.length + tag.links.length + tag.notes.length;

// "recent" keeps the server's order (most recently tagged first).
export function sortTags(tags: readonly TagSummary[], sort: Sort): TagSummary[] {
  if (sort === "recent") return [...tags];
  return [...tags].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : size(b) - size(a) || a.name.localeCompare(b.name)));
}

export function filterTags(tags: readonly TagSummary[], filter: string): TagSummary[] {
  const wanted = filter.trim().toLowerCase();
  if (wanted === "") return [...tags];
  return tags.filter((tag) =>
    [tag.name, ...tag.agents.map((agent) => agent.title ?? ""), ...tag.links.map((link) => link.title), ...tag.notes.map((note) => `${note.title} ${note.ref}`)].some((text) => text.toLowerCase().includes(wanted)),
  );
}

// The totals live in the filter box's placeholder instead of a row of their own.
export function filterPlaceholder(tags: readonly TagSummary[]): string {
  const agents = new Set(tags.flatMap((tag) => tag.agents.map((agent) => agent.agentId))).size;
  const items = tags.reduce((sum, tag) => sum + tag.notes.length, 0);
  return `Filter ${[plural(tags.length, "tag"), agents > 0 ? plural(agents, "agent") : null, items > 0 ? plural(items, "item") : null].filter(Boolean).join(", ")}`;
}
