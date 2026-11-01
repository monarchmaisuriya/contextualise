import type { AgentLive, TagSummary } from "../shared/contracts";
import { plural } from "./plural";

export type Sort = "recent" | "name" | "size";
export const SORT_LABELS: Record<Sort, string> = { recent: "Recent", name: "Name", size: "Size" };
export const SORTS: readonly Sort[] = ["recent", "name", "size"];

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

// The tag whose detail shows. A chosen tag stays chosen while it exists, even when the filter hides
// it; with none chosen, a desktop window shows the first listed tag and a phone shows the list.
export function selectedTag(all: readonly TagSummary[], shown: readonly TagSummary[], chosen: string | null, compact: boolean): TagSummary | undefined {
  const kept = chosen === null ? undefined : all.find((tag) => tag.key === chosen);
  return kept ?? (compact ? undefined : shown[0]);
}

const OTHER_TAGS_SHOWN = 24;

// The popover's one field both names tags to add ("auth, billing") and filters the tags offered:
// only the part after the last comma filters, so the next name narrows the chips as it is typed.
// The agent's own tags never filter away, so removing one is always a press away.
export function popoverTags(tags: readonly TagSummary[], agentId: string, typed: string): { mine: TagSummary[]; others: TagSummary[] } {
  const wanted = (typed.split(",").pop() ?? "").trim().toLowerCase();
  const mine = tags.filter((tag) => tag.agents.some((member) => member.agentId === agentId));
  const others = tags.filter((tag) => !mine.includes(tag) && tag.name.toLowerCase().includes(wanted)).slice(0, OTHER_TAGS_SHOWN);
  return { mine, others };
}

// What a tag's agents are doing now: how many need M and how many run, for the tag's line. Empty
// when none is live, so the line says what it said before.
export function liveLine(tag: Pick<TagSummary, "agents">): string {
  const live = tag.agents.flatMap((agent) => (agent.live ? [agent.live] : []));
  const needsYou = live.filter((agent) => agent.needsYou === "permission" || agent.needsYou === "error").length;
  const running = live.filter((agent) => agent.status === "running").length;
  return [...(needsYou > 0 ? [`${needsYou} need${needsYou === 1 ? "s" : ""} you`] : []), ...(running > 0 ? [`${running} running`] : [])].join(" · ");
}

// One agent's state in words, most urgent first, as Paseo's sidebar orders them; null when idle.
export function agentStatus(live: AgentLive | undefined): { text: string; urgent: boolean } | null {
  if (!live) return null;
  if (live.needsYou === "permission") return { text: "needs permission", urgent: true };
  if (live.needsYou === "error") return { text: "stopped with an error", urgent: true };
  if (live.status === "running") return { text: "running", urgent: false };
  if (live.needsYou === "finished") return { text: "finished, not looked at", urgent: false };
  return null;
}
