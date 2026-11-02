import { expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { actionColor, emptyActions, metaPlacement, pageInset, rowBackground, rowFrame, searchWidth, segmentedScrolls, TEXT } from "./rules";

const colors = { surface0: "s0", surface1: "s1", surface2: "s2", border: "b", foreground: "fg", foregroundMuted: "mu", accent: "ac", accentForeground: "af", statusSuccess: "ok", statusWarning: "wa", statusDanger: "da" };

test("every kind of text uses a size from Paseo's own scale", () => {
  const paseoScale = [12, 14, 15, 16, 18, 20, 22, 26];
  for (const kind of Object.values(TEXT)) expect(paseoScale).toContain(kind.fontSize);
});

test("headings and notes are smaller than rows, reading text matches Paseo's Markdown, the title leads", () => {
  expect(TEXT.heading.fontSize).toBeLessThan(TEXT.body.fontSize);
  expect(TEXT.note.fontSize).toBeLessThan(TEXT.body.fontSize);
  expect([TEXT.prose.fontSize, TEXT.prose.lineHeight]).toEqual([15, 21]);
  expect(TEXT.title.fontSize).toBeGreaterThan(TEXT.prose.fontSize);
});

test("every line height leaves room for descenders", () => {
  for (const kind of Object.values(TEXT)) expect(kind.lineHeight).toBeGreaterThanOrEqual(kind.fontSize * 1.25);
});

test("no client file sets a font size of its own: text names a kind from TEXT", () => {
  const client = join(__dirname, "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
  const raw = files(client)
    .filter((file) => file.endsWith(".tsx") || (file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith("rules.ts")))
    .filter((file) => /fontSize:\s*\d/.test(readFileSync(file, "utf8")));
  expect(raw).toEqual([]);
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
