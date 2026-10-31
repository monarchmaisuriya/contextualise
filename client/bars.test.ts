import { describe, expect, it } from "vitest";
import { barsCarryInformation } from "./bars";

describe("barsCarryInformation", () => {
  it("draws bars only when the values in a group differ", () => {
    expect(barsCarryInformation([5, 9, 5])).toBe(true);
    expect(barsCarryInformation([1, 1, 1, 1])).toBe(false);
    expect(barsCarryInformation([7])).toBe(false);
    expect(barsCarryInformation([])).toBe(false);
  });
});
