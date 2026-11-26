import { expect, test } from "vitest";
import { attachTabs, shownTab } from "./attach-tabs";

test("offers Project files only once something is attached, and falls back to Projects when nothing is", () => {
  expect(attachTabs(0).map((tab) => tab.value)).toEqual(["projects", "workspaces"]);
  expect(attachTabs(2).map((tab) => tab.value)).toEqual(["projects", "workspaces", "files"]);
  expect(shownTab("files", 0)).toBe("projects");
  expect(shownTab("files", 1)).toBe("files");
  expect(shownTab("workspaces", 0)).toBe("workspaces");
});

test("keeps the chosen tab while the links load, so the popover does not jump", () => {
  expect(shownTab("files", null)).toBe("files");
  expect(attachTabs(null).map((tab) => tab.value)).toContain("files");
});

test("offers Chats only to a composer-capable pill and preserves the panel fallback", () => {
  expect(attachTabs(0, true).map((tab) => tab.value)).toEqual(["projects", "workspaces", "chats"]);
  expect(attachTabs(1, true).map((tab) => tab.value)).toEqual(["projects", "workspaces", "chats", "files"]);
  expect(attachTabs(1).map((tab) => tab.value)).not.toContain("chats");
  expect(shownTab("chats", 0)).toBe("projects");
  expect(shownTab("chats", null, true)).toBe("chats");
});
