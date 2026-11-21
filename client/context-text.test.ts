import { expect, it } from "vitest";
import { activityTotals, sizeLine, unexpiredEvents } from "./context-text";
import type { ContextEvent } from "../shared/context";

const event: ContextEvent = { id: 1, at: "2026-11-21T10:00:00Z", state: "returned", source: "knowledge", included: 1, omitted: 0, freshness: "unknown", characters: 4, bytes: 7, tokens: 1, outcome: "ok", durationMs: 10, repeated: false };

it("distinguishes prepared size from retrieval totals and computes the even median", () => {
  expect(activityTotals([event, { ...event, id: 2, durationMs: 30, outcome: "empty", repeated: true }, { ...event, id: 3, state: "prepared", durationMs: null }])).toEqual({ calls: 2, bytes: 21, empty: 1, failed: 0, repeated: 1, medianMs: 20 });
});

it("does not present unavailable handler time as zero", () => {
  expect(activityTotals([]).medianMs).toBeNull();
  expect(sizeLine({ characters: 4, bytes: 7, tokens: 1 })).toBe("~1 tokens · 4 characters · 7 bytes");
});

it("removes expired cached events and their contribution even after recording stops", () => {
  const retained = unexpiredEvents([event], Date.parse("2026-11-21T10:30:00Z"));
  expect(retained).toEqual([]);
  expect(activityTotals(retained).calls).toBe(0);
});
