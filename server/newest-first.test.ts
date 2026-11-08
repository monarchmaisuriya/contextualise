import { expect, test } from "vitest";
import { newestFirst } from "./newest-first";

test("puts the newest first, by ISO time or epoch milliseconds", () => {
  const rows = [{ id: "a", at: "2026-11-01T00:00:00.000Z" }, { id: "b", at: "2026-11-08T00:00:00.000Z" }, { id: "c", at: "2026-11-05T00:00:00.000Z" }];
  expect(newestFirst(rows, (row) => row.at).map((row) => row.id)).toEqual(["b", "c", "a"]);
  expect(newestFirst([{ id: "x", at: 1 }, { id: "y", at: 3 }], (row) => row.at).map((row) => row.id)).toEqual(["y", "x"]);
});

test("keeps the order it was given for ties and for items without a time, which go last", () => {
  const rows = [{ id: "none1" }, { id: "old", at: "2026-11-01T00:00:00.000Z" }, { id: "tie1", at: "2026-11-08T00:00:00.000Z" }, { id: "none2", at: "" }, { id: "tie2", at: "2026-11-08T00:00:00.000Z" }, { id: "bad", at: "not a time" }];
  expect(newestFirst(rows, (row) => row.at).map((row) => row.id)).toEqual(["tie1", "tie2", "old", "none1", "none2", "bad"]);
});
