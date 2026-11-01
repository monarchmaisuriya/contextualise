import { expect, test } from "vitest";
import { actionColor, emptyActions, metaPlacement, pageInset, rowBackground, rowFrame, searchWidth, segmentedScrolls, TYPE } from "./rules";

const colors = { surface0: "s0", surface1: "s1", surface2: "s2", border: "b", foreground: "fg", foregroundMuted: "mu", accent: "ac", accentForeground: "af", statusSuccess: "ok", statusWarning: "wa", statusDanger: "da" };

test("three type sizes, none of them 13", () => {
  expect(Object.values(TYPE)).toEqual([16, 14, 12]);
});

test("pages are inset 24 on desktop and 12 on phones", () => {
  expect([pageInset(false), pageInset(true)]).toEqual([24, 12]);
});

test("rows are full touch targets and rounded on phones, flat and denser on desktop", () => {
  expect(rowFrame(true)).toEqual({ minHeight: 44, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 });
  expect(rowFrame(false)).toEqual({ minHeight: 36, borderRadius: 0, paddingVertical: 8, paddingHorizontal: 12 });
});

test("a row is transparent at rest, surface1 on hover, surface2 when pressed or selected", () => {
  expect(rowBackground(colors, {})).toBe("transparent");
  expect(rowBackground(colors, { hovered: true })).toBe("s1");
  expect(rowBackground(colors, { pressed: true })).toBe("s2");
  expect(rowBackground(colors, { selected: true })).toBe("s2");
  expect(rowBackground(colors, { selected: true, hovered: true })).toBe("s2");
});

test("row meta stacks under the title on phones and sits in a right column on desktop", () => {
  expect(metaPlacement(true)).toBe("below");
  expect(metaPlacement(false)).toBe("right");
});

test("the segmented control scrolls sideways on phones instead of wrapping", () => {
  expect(segmentedScrolls(true)).toBe(true);
  expect(segmentedScrolls(false)).toBe(false);
});

test("the search field is capped at 420 on desktop and full width on phones", () => {
  expect(searchWidth(false)).toEqual({ width: "100%", maxWidth: 420 });
  expect(searchWidth(true)).toEqual({ width: "100%" });
});

test("destructive actions read in the danger color, others in the foreground", () => {
  expect(actionColor(colors, { danger: true })).toBe("da");
  expect(actionColor(colors, {})).toBe("fg");
});

test("an empty state offers at most two actions", () => {
  expect(emptyActions(undefined)).toEqual([]);
  expect(emptyActions(["a", "b", "c"])).toEqual(["a", "b"]);
});
