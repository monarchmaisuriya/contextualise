import { expect, test } from "vitest";
import { LOCKDOWN } from "./workers";

// Modes Paseo 0.13 accepts (from its error for "read-only"), and the lockdown each worker needs.
test("fetch workers start in a mode Paseo accepts, locked down", () => {
  expect(["auto", "auto-review"]).toContain(LOCKDOWN.codex.modeId);
  expect(LOCKDOWN.codex.options).toMatchObject({ sandbox_mode: "read-only", web_search: "disabled" });
  expect(LOCKDOWN.claude.modeId).toBe("default");
  expect(LOCKDOWN.claude.options).toMatchObject({ disallowedTools: expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch", "mcp__paseo"]) });
});
