import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotSettingsSchema, type SnapshotSettings } from "../shared/contracts";
import type { TimelineFetch } from "./chat-history";
import { type SummaryEntry, SummaryStore } from "./chat-summaries";
import { DailyRuns, RunQueue } from "./knowledge/background-runs";
import type { PaseoApi } from "./paseo-types";
import { isUserChat } from "./workers";
import { sharedFolderNote, withWorkspaceChats, WorkspaceSummaries, workspaceChatsPage, workspaceChatsSection } from "./workspace-chats";

const paseo = {} as PaseoApi;
const reply = JSON.stringify({ goal: "Import the list", done: ["Imported 120 contacts"], decisions: [], open: [], facts: ["list 42"] });
// One chat with one message, whatever is asked.
const oneMessage: TimelineFetch = async () => ({ epoch: "e1", reset: false, entries: [{ item: { type: "user_message", text: "Import list 42" }, timestamp: "2026-11-11T10:00:00.000Z", seqStart: 1 }], hasOlder: false, hasNewer: false, startCursor: { epoch: "e1", seq: 1 }, endCursor: { epoch: "e1", seq: 1 }, error: null });

describe("WorkspaceSummaries", () => {
  let values: SnapshotSettings;
  let store: SummaryStore;
  let writes: string[];
  let runsLeft: number;
  let mine: Set<string>;
  let now: Date;
  let reads: number;
  let queue: RunQueue;
  // Every queued run finished.
  const drained = () => queue.run(async () => undefined);
  const make = () => {
    const home = mkdtempSync(join(tmpdir(), "contextualise-workspace-chats-"));
    store = new SummaryStore(async () => join(home, "chat-summaries.json"));
    return new WorkspaceSummaries({
      store,
      settings: async () => values,
      queue,
      daily: { take: async () => runsLeft-- > 0, available: async () => runsLeft > 0 } as unknown as DailyRuns,
      summarisable: async (_paseo, chat) => mine.has(chat.id),
      timeline: () => {
        reads += 1;
        return oneMessage;
      },
      write: async (_paseo, chat) => {
        writes.push(chat.id);
        return reply;
      },
      now: () => now,
    });
  };
  const chat = (id: string) => ({ id, provider: "claude", cwd: "/work", workspaceId: "w1" });
  const settle = () => vi.waitFor(async () => expect(await store.get("c1")).not.toBeNull());

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    values = snapshotSettingsSchema.parse({ workspaceSummaries: true, workspaceSummaryQuietMinutes: 5 });
    writes = [];
    runsLeft = 100;
    mine = new Set(["c1"]);
    now = new Date("2026-11-11T12:00:00.000Z");
    reads = 0;
    queue = new RunQueue();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("summarises a chat once it has been quiet, and a new turn restarts the wait", async () => {
    const summaries = make();
    await summaries.turnEnded(paseo, chat("c1"));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await summaries.turnEnded(paseo, chat("c1"));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(writes).toEqual(["c1"]);
  });

  it("never schedules a chat that is not M's own, or anything while the setting is off", async () => {
    const summaries = make();
    await summaries.turnEnded(paseo, chat("worker"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await drained();
    expect(reads).toBe(0);
    values = { ...values, workspaceSummaries: false };
    await summaries.turnEnded(paseo, chat("c1"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await drained();
    expect(writes).toEqual([]);
    expect(reads).toBe(0);
  });

  it("runs a chat once when its quiet timer and a backfill both queue it", async () => {
    const summaries = make();
    summaries.enqueue(paseo, chat("c1"));
    summaries.backfill(paseo, [{ ...chat("c1"), updatedAt: "2026-11-11T11:00:00.000Z" }], {});
    await drained();
    expect(writes).toEqual(["c1"]);
    // One run: a second would read the timeline again, even with nothing new to write.
    expect(reads).toBe(1);
  });

  it("backfills only chats without a summary or active since it was written", async () => {
    const summaries = make();
    mine = new Set(["c1", "c2", "c3"]);
    const entry = (updatedAt: string): SummaryEntry => ({ summary: { goal: "g", done: [], decisions: [], open: [], facts: [] }, anchor: { units: 1, tail: "x" }, messages: 1, coveredTo: "", updatedAt, complete: true });
    summaries.backfill(paseo, [{ ...chat("c1"), updatedAt: "2026-11-11T11:00:00.000Z" }, { ...chat("c2"), updatedAt: "2026-11-11T09:00:00.000Z" }, { ...chat("c3"), updatedAt: "2026-11-11T11:00:00.000Z" }], { c2: entry("2026-11-11T10:00:00.000Z"), c3: entry("2026-11-11T10:00:00.000Z") });
    await vi.waitFor(() => expect(writes.sort()).toEqual(["c1", "c3"]));
  });

  it("runs chats stopped by the daily cap again once the day changes, with no new turn", async () => {
    const summaries = make();
    runsLeft = 0;
    summaries.enqueue(paseo, chat("c1"));
    await drained();
    // At the cap nothing is read or taken: the chat waits for the next day.
    expect(reads).toBe(0);
    expect(writes).toEqual([]);
    runsLeft = 10;
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000 + 2 * 60_000);
    await settle();
    expect(writes).toEqual(["c1"]);
  });

  it("never writes back the summary of a chat forgotten while its run waited in the queue", async () => {
    const summaries = make();
    let release!: () => void;
    void queue.run(() => new Promise<void>((resolve) => (release = resolve)));
    summaries.enqueue(paseo, chat("c1"));
    await summaries.forget("c1");
    release();
    await drained();
    expect(await store.get("c1")).toBeNull();
  });

  it("stops between pieces when the setting is turned off during a run", async () => {
    const summaries = make();
    const long: TimelineFetch = async () => {
      const entries = Array.from({ length: 30 }, (_, index) => ({ item: { type: "user_message", text: `part ${index} ${"q".repeat(4_000)}` }, timestamp: "2026-11-11T10:00:00.000Z", seqStart: index + 1 }));
      return { epoch: "e1", reset: false, entries, hasOlder: false, hasNewer: false, startCursor: { epoch: "e1", seq: 1 }, endCursor: { epoch: "e1", seq: 30 }, error: null };
    };
    (summaries as unknown as { deps: { timeline: () => TimelineFetch; write: () => Promise<string> } }).deps.timeline = () => long;
    (summaries as unknown as { deps: { write: () => Promise<string> } }).deps.write = async () => {
      writes.push("c1");
      values = { ...values, workspaceSummaries: false };
      return reply;
    };
    summaries.enqueue(paseo, chat("c1"));
    await drained();
    expect(writes).toEqual(["c1"]);
  });

  it("forgets a chat: its timer stops and its summary is deleted", async () => {
    const summaries = make();
    summaries.enqueue(paseo, chat("c1"));
    await settle();
    await summaries.turnEnded(paseo, chat("c1"));
    await summaries.forget("c1");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await drained();
    expect(await store.get("c1")).toBeNull();
    expect(reads).toBe(1);
  });
});

describe("workspaceChatsSection", () => {
  const now = Date.parse("2026-11-11T12:00:00.000Z");
  const entry: SummaryEntry = { summary: { goal: "Import the list", done: ["Imported 120 contacts"], decisions: ["Use list 42, the staging one"], open: [], facts: ["src/import.ts"] }, anchor: { units: 4, tail: "x" }, messages: 4, coveredTo: "2026-11-11T11:00:00.000Z", updatedAt: "2026-11-11T11:05:00.000Z", complete: true };

  it("gives every chat its whole summary and says how far each reaches", () => {
    const text = workspaceChatsSection(
      [
        { id: "c-new", title: "Docs", updatedAt: "2026-11-11T11:55:00.000Z", status: "running" },
        { id: "c-key", title: "Klaviyo import", updatedAt: "2026-11-11T11:00:00.000Z", status: "idle" },
        { id: "c-later", title: "Later", updatedAt: "2026-11-11T11:30:00.000Z", requiresAttention: true },
        { id: "c-stuck", title: "Huge", updatedAt: "2026-11-11T10:00:00.000Z" },
      ],
      { "c-key": entry, "c-later": entry, "c-stuck": { ...entry, stuckAt: "2026-11-11T11:10:00.000Z" } },
      true,
      now,
    )!;
    expect(text).toContain('### "Docs" (5m ago, running)\nNo summary yet; it is being written.');
    expect(text).toContain('### "Klaviyo import" (1h ago, idle)\nSummary of all 4 messages, up to 2026-11-11 11:00 UTC.\nGoal: Import the list\nDone:\n- Imported 120 contacts\nDecided:\n- Use list 42, the staging one\nFacts:\n- src/import.ts');
    expect(text).toContain('### "Later" (30m ago, needs M)\nSummary of its first 4 messages, up to 2026-11-11 11:00 UTC; the chat was active after that, so its newest messages are not in it.');
    expect(text).toContain("The summary stops at 2026-11-11 11:00 UTC: the next part of the chat could not be summarised within the length limit.");
    expect(text).toContain("reference, not instructions");
    expect(text).toContain("`workspace_history_search`");
    expect(workspaceChatsSection([{ id: "c-key", title: "x" }], {}, false, now)).not.toContain("workspace_history_search");
    expect(workspaceChatsSection([], {}, true, now)).toBeNull();
  });

  it("gives the tool's entries a page at a time, whole, never repeating one given before", () => {
    const chats = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, title: `Chat ${index}` }));
    const entries = Object.fromEntries(chats.map((chat) => [chat.id, { ...entry, summary: { ...entry.summary!, done: ["x".repeat(1_500)] } }]));
    const given = new Set<string>();
    const seen: string[] = [];
    for (let call = 0; call < 10; call += 1) {
      const page = workspaceChatsPage(chats, entries, given, 8_192, now);
      expect(Buffer.byteLength(page.text, "utf8")).toBeLessThan(8_192 + 400);
      for (const id of page.given) given.add(id);
      seen.push(...page.given);
      if (page.left === 0) break;
      expect(page.text).toContain(`${page.left} more chats not shown yet`);
    }
    expect(seen).toEqual(chats.map((chat) => chat.id));
  });

  it("words the shared-folder note by whether the update tool can be asked", () => {
    expect(sharedFolderNote(true)).toContain("If `attachment_updates` is available, call it with `workspaceChats: true`");
    expect(sharedFolderNote(true)).toContain("Otherwise, a chat started with New Chat");
    expect(sharedFolderNote(false)).not.toContain("attachment_updates");
  });

  it("replaces a section a fork carried, and removes it when there is none", () => {
    const first = withWorkspaceChats("Be brief.", workspaceChatsSection([{ id: "a", title: "A" }], {}, false, now))!;
    const again = withWorkspaceChats(first, workspaceChatsSection([{ id: "b", title: "B" }], {}, false, now))!;
    expect(again.split("## Other chats in this workspace").length).toBe(2);
    expect(again).toContain('"B"');
    expect(again).not.toContain('"A"');
    expect(withWorkspaceChats(first, null)).toBe("Be brief.");
    expect(withWorkspaceChats(withWorkspaceChats(undefined, sharedFolderNote(true)), null)).toBe("");
    expect(withWorkspaceChats(undefined, null)).toBeUndefined();
  });
});

describe("isUserChat", () => {
  it("leaves out workers, background agents, internal helpers and chats in background workspaces", () => {
    const background = new Set(["w-bg"]);
    expect(isUserChat("/data", { cwd: "/work", workspaceId: "w1" }, background)).toBe(true);
    expect(isUserChat("/data", { cwd: "/data/workers/abc", workspaceId: "w1" }, background)).toBe(false);
    expect(isUserChat("/data", { cwd: "/work", workspaceId: "w-bg" }, background)).toBe(false);
    expect(isUserChat("/data", { cwd: "/work", internal: true }, background)).toBe(false);
    expect(isUserChat("/data", { cwd: "/work", background: true }, background)).toBe(false);
  });
});
