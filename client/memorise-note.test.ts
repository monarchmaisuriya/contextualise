import { describe, expect, it } from "vitest";
import { MEMORISE_INSTALL_COMMAND, memoriseNote } from "./memorise-note";

describe("memoriseNote", () => {
  it("says nothing when Memorise is available", () => {
    expect(memoriseNote("available")).toBeNull();
  });

  it.each([
    ["not-installed", /^Install Memorise to add /, MEMORISE_INSTALL_COMMAND],
    ["disabled", /^Turn on Memorise/, null],
    ["needs-update", /^Update Memorise to 0\.10 or later/, "paseo plugin update memorise"],
  ] as const)("asks to act when Memorise is %s", (state, text, command) => {
    const note = memoriseNote(state);
    expect(note?.text).toMatch(text);
    expect(note?.text).toContain("related memories in search");
    expect(note?.command).toBe(command);
  });
});
