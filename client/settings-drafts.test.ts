import { expect, test } from "vitest";
import { keepsOpen, saveRowKey, withDraft } from "./settings-drafts";

test("a typed value equal to the stored one is no change at all", () => {
  expect(withDraft({}, "port", "6800", "6791")).toEqual({ port: "6800" });
  expect(withDraft({ port: "6800" }, "port", "6791", "6791")).toEqual({});
});

test("Save shows beside the field typed in last, or else beside another field still waiting", () => {
  expect(saveRowKey<string>("port", { port: "6800", lines: "30" })).toBe("port");
  expect(saveRowKey<string>("port", { lines: "30" })).toBe("lines");
  expect(saveRowKey("port", {})).toBeNull();
});

test("a closed section opens while one of its fields holds unsaved text or a problem", () => {
  expect(keepsOpen<string>(["port", "routes"], { lines: "30" }, {})).toBe(false);
  expect(keepsOpen(["port", "routes"], { port: "6800" }, {})).toBe(true);
  expect(keepsOpen(["port", "routes"], {}, { routes: "Expected a JSON list" })).toBe(true);
});
