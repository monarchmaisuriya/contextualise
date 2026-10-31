import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageLog } from "./usage";

const DAY = 24 * 60 * 60 * 1000;

describe("UsageLog", () => {
  let dir: string;
  let now: number;
  let log: UsageLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "contextualise-usage-"));
    now = Date.parse("2026-11-01T12:00:00.000Z");
    log = new UsageLog(async () => dir, () => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts agents given the tools, agents that used them, and calls per tool, over the last 7 days", async () => {
    for (let i = 0; i < 3; i += 1) await log.recordGiven("github.com/acme/api");
    await log.recordCall("github.com/acme/api", "knowledge_search", "token-a");
    await log.recordCall("github.com/acme/api", "knowledge_read", "token-a");
    await log.recordCall("github.com/acme/api", "knowledge_search", "token-b");
    await log.recordGiven("github.com/acme/other");
    expect(await log.lastDays("github.com/acme/api")).toEqual({ days: 7, agentsGiven: 3, agentsUsed: 2, calls: { knowledge_search: 2, knowledge_read: 1, knowledge_outline: 0, knowledge_history: 0 } });
  });

  it("leaves days older than 7 out of the total and drops days older than 30 from the file", async () => {
    await log.recordGiven("p");
    now += 8 * DAY;
    await log.recordGiven("p");
    expect((await log.lastDays("p")).agentsGiven).toBe(1);
    now += 31 * DAY;
    await log.recordGiven("p");
    const [file] = readdirSync(dir);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, file), "utf8")).days)).toEqual(["2026-12-10"]);
  });

  it("never writes a token, only a short hash of it", async () => {
    await log.recordCall("p", "knowledge_search", "secret-token-value");
    const [file] = readdirSync(dir);
    expect(readFileSync(join(dir, file), "utf8")).not.toContain("secret-token-value");
  });

  it("loses no count when calls arrive together", async () => {
    await Promise.all(Array.from({ length: 20 }, () => log.recordCall("p", "knowledge_search", "t")));
    expect((await log.lastDays("p")).calls.knowledge_search).toBe(20);
  });

  it("still answers after a write failed", async () => {
    await log.recordGiven("p");
    chmodSync(dir, 0o500);
    await expect(log.recordGiven("p")).rejects.toThrow();
    chmodSync(dir, 0o700);
    expect((await log.lastDays("p")).agentsGiven).toBe(1);
  });

  it("starts a fresh count from a damaged file and says so", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await log.recordGiven("p");
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file), "{not json");
    await log.recordGiven("p");
    expect((await log.lastDays("p")).agentsGiven).toBe(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("usage"));
  });
});
