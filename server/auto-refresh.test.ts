import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AutoRefresh } from "./auto-refresh";
import type { PaseoApi } from "./paseo-types";

const paseo = {} as PaseoApi;
const QUARTER_HOUR = 15 * 60_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("no timer runs while automatic refresh is off", () => {
  const auto = new AutoRefresh(async () => 0);
  auto.apply(false);
  expect(vi.getTimerCount()).toBe(0);
  auto.apply(true);
  auto.apply(true);
  expect(vi.getTimerCount()).toBe(1);
  auto.apply(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("every 15 minutes it refreshes stale items with the Paseo handle it was given", async () => {
  const refreshStale = vi.fn(async (_paseo: PaseoApi) => 0);
  const auto = new AutoRefresh(refreshStale);
  auto.apply(true);
  await vi.advanceTimersByTimeAsync(QUARTER_HOUR);
  // No handler or event has run yet, so there is no handle to fetch with.
  expect(refreshStale).not.toHaveBeenCalled();
  auto.use(paseo);
  await vi.advanceTimersByTimeAsync(QUARTER_HOUR);
  expect(refreshStale).toHaveBeenCalledWith(paseo);
  auto.stop();
  await vi.advanceTimersByTimeAsync(QUARTER_HOUR);
  expect(refreshStale).toHaveBeenCalledTimes(1);
});

test("a failed check is logged and the next one still runs", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const refreshStale = vi.fn(async () => {
    throw new Error("settings are invalid");
  });
  const auto = new AutoRefresh(refreshStale);
  auto.use(paseo);
  auto.apply(true);
  await vi.advanceTimersByTimeAsync(2 * QUARTER_HOUR);
  expect(refreshStale).toHaveBeenCalledTimes(2);
  expect(logged.mock.calls.some(([line]) => String(line).includes("settings are invalid"))).toBe(true);
  auto.stop();
  logged.mockRestore();
});
