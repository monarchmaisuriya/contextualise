import { describe, expect, it } from "vitest";
import { usageLine } from "./usage-line";

describe("usageLine", () => {
  it("says how many agents used project knowledge and how, over the last days", () => {
    expect(usageLine({ days: 7, agentsGiven: 15, agentsUsed: 12, calls: { knowledge_search: 30, knowledge_read: 18, knowledge_outline: 0, knowledge_history: 2 } })).toBe(
      "Last 7 days: 12 of 15 agents used project knowledge (30 searches, 18 reads, 2 history lookups).",
    );
  });

  it("says so plainly when agents got the tools but none used them", () => {
    expect(usageLine({ days: 7, agentsGiven: 1, agentsUsed: 0, calls: { knowledge_search: 0, knowledge_read: 0, knowledge_outline: 0, knowledge_history: 0 } })).toBe("Last 7 days: 0 of 1 agent used project knowledge.");
  });

  it("shows nothing before any agent got the tools", () => {
    expect(usageLine({ days: 7, agentsGiven: 0, agentsUsed: 0, calls: { knowledge_search: 0, knowledge_read: 0, knowledge_outline: 0, knowledge_history: 0 } })).toBeNull();
  });
});
