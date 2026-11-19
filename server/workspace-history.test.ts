import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type AttachedChat } from "./attached-history";
import type { TimelineFetch, TimelinePage } from "./chat-history";
import { HistoryOff } from "./history-tools";
import type { PaseoApi } from "./paseo-types";
import { workspaceHistoryTools } from "./workspace-history";

type Tool = { name: string; execute(input: Record<string, unknown>, context: unknown): Promise<{ text: string; isError?: boolean }> };

describe("workspace history", () => {
  let chats: AttachedChat[];
  let off: HistoryOff;
  let enabled: boolean;
  let tools: Tool[];
  let rows: TimelinePage["entries"];
  let epoch: string;
  let reads: string[];
  let broken: Set<string>;
  const paseo = { agents: { ref: (id: string) => ({ timeline: { refetch: async ({ direction, cursor, limit }: Parameters<TimelineFetch>[0]) => {
    reads.push(id);
    if (broken.has(id)) throw new Error("chat unavailable");
    const selected = direction === "before" ? rows.filter((row) => row.seqStart < cursor!.seq).slice(-limit) : direction === "after" ? rows.filter((row) => (row.seqEnd ?? row.seqStart) > cursor!.seq).slice(0, limit) : rows.slice(-limit);
    const first = selected[0];
    const last = selected.at(-1);
    return { epoch, reset: !!cursor && cursor.epoch !== epoch, entries: selected, hasOlder: !!first && rows[0].seqStart < first.seqStart, hasNewer: !!last && rows.at(-1)!.seqStart > last.seqStart, startCursor: first ? { epoch, seq: first.seqStart } : null, endCursor: last ? { epoch, seq: last.seqEnd ?? last.seqStart } : null, error: null };
  } } }) } } as unknown as PaseoApi;
  const context = { agent: { id: "caller", workspaceId: "w1" }, paseo };
  const call = (name: string, input: Record<string, unknown> = {}) => tools.find((tool) => tool.name === name)!.execute(input, context);

  beforeEach(() => {
    chats = [{ id: "chat-a", title: "Import work", workspace: "this workspace" }];
    const file = join(mkdtempSync(join(tmpdir(), "workspace-history-off-")), "off.json");
    off = new HistoryOff(async () => file);
    enabled = true;
    rows = [{ item: { type: "user_message", text: "Use staging list 42" }, timestamp: "2026-11-19T00:00:00Z", seqStart: 10, seqEnd: 12 }];
    epoch = "e1";
    reads = [];
    broken = new Set();
    tools = workspaceHistoryTools({ off, enabled: async () => enabled, chats: async () => chats }) as Tool[];
  });

  it("offers discovery beside compatible search load and read tools", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["workspace_history_chats", "workspace_history_search", "workspace_history_load", "workspace_history_read"]);
  });

  it("finds old rows beyond the memory cache through resumable bounded scans", async () => {
    rows = Array.from({ length: 20_002 }, (_, index) => ({ item: { type: "user_message", text: index === 0 ? "oldest unique decision" : "later" }, timestamp: "2026-11-19T00:00:00Z", seqStart: index * 3 + 10 }));
    let result = await call("workspace_history_search", { query: "oldest unique" });
    expect(result.text).toContain("Partial scan");
    expect(reads.length).toBe(4);
    // Traversal assertion: repeat the public continuation protocol until complete.
    for (let page = 0; page < 30 && result.text.includes("Partial scan"); page += 1) {
      const cursor = /cursor: (\S+)/.exec(result.text)![1];
      result = await call("workspace_history_search", { query: "oldest unique", cursor });
    }
    expect(result.text).toContain("oldest unique decision");
    expect(result.text).toContain("Scan complete");
    expect((await call("workspace_history_load", { ids: ["chat-a:10@e1"] })).text).toContain("You: oldest unique decision");
  });

  it("continues within a source page without skipping matches when activity order changes", async () => {
    rows = [{ item: { type: "user_message", text: "first" }, timestamp: "2026-11-19T00:00:00Z", seqStart: 10 }, { item: { type: "assistant_message", text: "second" }, timestamp: "2026-11-19T00:00:00Z", seqStart: 20 }];
    const first = await call("workspace_history_search", { limit: 1 });
    expect(first.text).toContain("second");
    expect(first.text).not.toContain(" · first");
    const cursor = /cursor: (\S+)/.exec(first.text)![1];
    chats = [{ id: "chat-b", title: "Now newest", workspace: "this workspace" }, ...chats];
    const second = await call("workspace_history_search", { limit: 1, cursor });
    expect(second.text).toContain("first");
    expect(second.text).not.toContain(" · second");
    const third = await call("workspace_history_search", { limit: 1, cursor: /cursor: (\S+)/.exec(second.text)![1] });
    expect(third.text).toContain("chat-b:20@e1");
  });

  it("loads a noncontiguous projected row directly and pages unicode after whole-row redaction", async () => {
    const secret = `sk-${"A1b2".repeat(12)}`;
    rows[0].item = { type: "assistant_message", text: `password=${secret}\n${"界🙂".repeat(10_000)}` };
    const loaded = await call("workspace_history_load", { ids: ["chat-a:10@e1"] });
    expect(loaded.text).toContain("too long to load here");
    expect(loaded.text).not.toContain(secret);
    const read = await call("workspace_history_read", { id: "chat-a:10@e1" });
    expect(read.text).toContain("Next: workspace_history_read");
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(16 * 1024);
    expect(read.text).not.toContain(secret);
  });

  it("refuses changed filters stale epochs and items outside the current eligible scope", async () => {
    const first = await call("workspace_history_search", { query: "staging", limit: 1 });
    const cursor = /cursor: (\S+)/.exec(first.text)![1];
    expect((await call("workspace_history_search", { query: "production", cursor })).text).toContain("filters changed");
    epoch = "e2";
    expect((await call("workspace_history_search", { query: "staging", cursor })).text).toContain("reloaded");
    expect((await call("workspace_history_read", { id: "chat-a:10@e1" })).text).toContain("reloaded");
    reads = [];
    await off.set("chat-a", true);
    expect((await call("workspace_history_read", { id: "chat-a:10@e1" })).isError).toBe(true);
    expect((await call("workspace_history_load", { ids: ["outsider:10@e1"] })).isError).toBe(true);
    expect(reads).toEqual([]);
  });

  it("discovers every eligible chat without depending on summaries and obeys the caller opt-out", async () => {
    expect((await call("workspace_history_chats", { query: "import" })).text).toContain("chat-a: Import work");
    await off.set("caller", true);
    expect((await call("workspace_history_chats")).isError).toBe(true);
    expect((await call("workspace_history_search")).isError).toBe(true);
    expect(reads).toEqual([]);
  });

  it("does not skip matches whose metadata fills a response before the requested result count", async () => {
    chats[0].title = "界".repeat(80);
    rows = Array.from({ length: 50 }, (_, index) => ({ item: { type: "user_message", text: `match ${index} ${"界".repeat(200)}` }, timestamp: "2026-11-19T00:00:00Z", seqStart: index * 3 + 10 }));
    let response = await call("workspace_history_search", { query: "match", limit: 50 });
    const ids = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      for (const match of response.text.matchAll(/- (chat-a:\d+@e1) ·/g)) ids.add(match[1]);
      const cursor = /cursor: (\S+)/.exec(response.text)?.[1];
      if (!cursor) break;
      response = await call("workspace_history_search", { query: "match", limit: 50, cursor });
    }
    expect(ids.size).toBe(50);
    expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(16 * 1024);
  });

  it("validates malformed cursors and public limit boundaries before any timeline read", async () => {
    const search = tools.find((tool) => tool.name === "workspace_history_search")! as Tool & { input: { safeParse(value: unknown): { success: boolean } } };
    expect(search.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(search.input.safeParse({ limit: -1 }).success).toBe(false);
    expect(search.input.safeParse({ limit: 51 }).success).toBe(false);
    expect(search.input.safeParse({ failed: "fasle" }).success).toBe(false);
    expect((await call("workspace_history_search", { cursor: "not-a-cursor" })).isError).toBe(true);
    enabled = false;
    expect((await call("workspace_history_search")).isError).toBe(true);
    expect(reads).toEqual([]);
  });

  it("returns earlier matches and resumes at a later failed source", async () => {
    chats.push({ id: "chat-b", title: "Unavailable chat", workspace: "this workspace" });
    broken.add("chat-b");
    const first = await call("workspace_history_search", { query: "staging" });
    expect(first.text).toContain("Use staging list 42");
    expect(first.text).toContain("chat unavailable");
    const cursor = /cursor: (\S+)/.exec(first.text)![1];
    reads = [];
    broken.clear();
    const next = await call("workspace_history_search", { query: "staging", cursor });
    expect(next.text).toContain("chat-b:10@e1");
    expect(reads).toEqual(["chat-b"]);
  });

  it("matches title words beyond the shortened display title", async () => {
    chats[0].title = `${"long ".repeat(30)}needle-at-end`;
    expect((await call("workspace_history_chats", { query: "needle-at-end" })).text).toContain("chat-a:");
  });
});
