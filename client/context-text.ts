import type { ContextEvent } from "../shared/context";

export function unexpiredEvents(events: readonly ContextEvent[], now: number): ContextEvent[] {
  return events.filter((event) => Date.parse(event.at) + 30 * 60_000 > now);
}

export function activityTotals(events: readonly ContextEvent[]) {
  const calls = events.filter((event) => event.state === "returned");
  const durations = calls.flatMap((event) => event.durationMs === null ? [] : [event.durationMs]).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  return { calls: calls.length, bytes: events.reduce((sum, event) => sum + event.bytes, 0), empty: calls.filter((event) => event.outcome === "empty").length, failed: calls.filter((event) => event.outcome === "error").length, repeated: calls.filter((event) => event.repeated).length, medianMs: durations.length === 0 ? null : durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2 };
}

export function sizeLine(size: { tokens: number; characters: number; bytes: number }) {
  return `~${size.tokens.toLocaleString("en-US")} tokens · ${size.characters.toLocaleString("en-US")} characters · ${size.bytes.toLocaleString("en-US")} bytes`;
}

export const SOURCE_LABELS = { map: "Project map", chat: "Chat attachment", tag: "Tag attachment", terminal: "Terminal attachment", project: "Project attachment", entry: "Selected entries", knowledge: "Project knowledge", history: "History retrieval", updates: "Attachment updates" } as const;
