import type { TaskRecord } from "./store";

// Missing facts are not removals. A tool call's terminal outcome cannot return to running.
export function mergeTaskLineage(previous: TaskRecord | null, next: TaskRecord): TaskRecord {
  const children = new Map((previous?.subtasks ?? []).map((child) => [child.callId, child]));
  for (const child of next.subtasks ?? []) {
    const old = children.get(child.callId);
    const wins = !old || (old.status === "running" && child.status !== "running") || ((old.status === "running") === (child.status === "running") && child.observedAt > old.observedAt);
    const winner = wins ? { ...old, ...child } : { ...old };
    // Conflicting known identities keep the existing authoritative association.
    if (old?.childAgentId || child.childAgentId) winner.childAgentId = old?.childAgentId ?? child.childAgentId;
    if (old?.nativeSessionRef || child.nativeSessionRef) winner.nativeSessionRef = old?.nativeSessionRef ?? child.nativeSessionRef;
    children.set(child.callId, winner as typeof child);
  }
  const ordered = [...children.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.callId.localeCompare(b.callId));
  const newerParent = next.lineageObservedAt && (!previous?.lineageObservedAt || next.lineageObservedAt > previous.lineageObservedAt);
  return {
    ...next,
    ...(previous?.parentAgentId !== undefined && (!newerParent || next.parentAgentId === undefined) ? { parentAgentId: previous.parentAgentId, lineageObservedAt: previous.lineageObservedAt } : {}),
    ...(ordered.length > 0 ? { subtasks: ordered.slice(0, 100) } : {}),
    ...(ordered.length > 100 || previous?.subtasksTruncated || next.subtasksTruncated ? { subtasksTruncated: true } : {}),
  };
}
