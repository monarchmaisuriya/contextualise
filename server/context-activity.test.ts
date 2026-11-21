import { afterEach, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { ContextActivity, receipt, textSize } from "./context-activity";

afterEach(() => vi.useRealTimers());

it("measures final Unicode text in distinct character and UTF-8 units", () => {
  expect(textSize("a😀é")).toEqual({ characters: 4, bytes: 7, tokens: 1 });
});

it("expires stopped activity on the timer without another read", () => {
  vi.useFakeTimers();
  const activity = new ContextActivity();
  activity.control("start");
  activity.record(receipt("hello", "project", "prepared"));
  activity.control("stop");
  vi.advanceTimersByTime(30 * 60_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(activity.snapshot().events).toEqual([]);
  activity.stop();
});

it("bounds retained events and isolates project views", () => {
  const activity = new ContextActivity();
  activity.control("start");
  Array.from({ length: 205 }, () => activity.record(receipt("x", "entry", "prepared"), "a"));
  activity.record(receipt("other", "entry", "prepared"), "b");
  expect(activity.snapshot().events).toHaveLength(200);
  expect(activity.snapshot().evicted).toBe(6);
  expect(activity.snapshot("b").events).toHaveLength(1);
  expect(activity.snapshot("unknown").events).toEqual([]);
  activity.stop();
});

it("detects same scoped results without retaining query or response", async () => {
  const activity = new ContextActivity();
  activity.control("start");
  await activity.observe("knowledge", "knowledge_search", "caller-a", { query: "ordinary private query" }, async () => "private response", (text) => ({ text }), "a");
  await activity.observe("knowledge", "knowledge_search", "caller-a", { query: "ordinary private query" }, async () => "private response", (text) => ({ text }), "a");
  await activity.observe("knowledge", "knowledge_search", "caller-b", { query: "ordinary private query" }, async () => "private response", (text) => ({ text }), "a");
  expect(activity.snapshot().events.map((event) => event.repeated)).toEqual([false, true, false]);
  expect(inspect(activity, { depth: 6 })).not.toContain("ordinary private query");
  expect(inspect(activity, { depth: 6 })).not.toContain("private response");
  activity.stop();
});

it("discards an in-flight observation after clear", async () => {
  const activity = new ContextActivity();
  activity.control("start");
  let finish!: (value: string) => void;
  const pending = activity.observe("history", "history_search", "a", {}, () => new Promise<string>((resolve) => { finish = resolve; }), (text) => ({ text }));
  activity.control("clear");
  finish("late private result");
  expect(await pending).toBe("late private result");
  expect(activity.snapshot().events).toEqual([]);
  activity.stop();
});

it("returns retrieval unchanged if its observer rejects malformed metadata", async () => {
  const activity = new ContextActivity();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  activity.control("start");
  const value = await activity.observe("history", "history_search", "a", {}, async () => "original", () => { throw new Error("observation only"); });
  expect(value).toBe("original");
  expect(activity.snapshot().events).toEqual([]);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
  activity.stop();
});

it("records only after explicit start and clears without retaining payload text", () => {
  const activity = new ContextActivity();
  activity.record(receipt("ordinary prose /private/customer/file", "chat", "prepared"), "project-a");
  expect(activity.snapshot().events).toEqual([]);
  activity.control("start");
  activity.record(receipt("ordinary prose /private/customer/file", "chat", "prepared"), "project-a");
  expect(activity.snapshot("project-a").events).toHaveLength(1);
  expect(JSON.stringify(activity.snapshot())).not.toContain("customer");
  activity.control("clear");
  expect(activity.snapshot()).toMatchObject({ recording: false, events: [] });
  activity.stop();
});
