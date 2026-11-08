import { describe, expect, it } from "vitest";
import { ChatHistory, type TimelineFetch, type TimelinePage, historyRow, loadHistory, readHistory, browseHistory, searchHistory, ANSWER_MAX_BYTES } from "./chat-history";

type Item = Record<string, unknown>;
const user = (text: string): Item => ({ type: "user_message", text });
const assistant = (text: string): Item => ({ type: "assistant_message", text });
const shell = (command: string, output: string, status = "completed"): Item => ({ type: "tool_call", callId: command, name: "Bash", status, error: status === "failed" ? "exit 1" : null, detail: { type: "shell", command, output, exitCode: status === "failed" ? 1 : 0 } });
const edit = (filePath: string): Item => ({ type: "tool_call", callId: filePath, name: "Edit", status: "completed", error: null, detail: { type: "edit", filePath, unifiedDiff: "-old\n+new" } });

// A fake Paseo timeline: projected rows keyed by seqStart, each with the seq of its latest event.
// An "after" page returns rows changed after the cursor, as Paseo's does, so a row updated later (a
// tool call that finishes, a plugin row replaced) comes back under its old seqStart.
function fakeTimeline(items: Item[], epoch = "e1") {
  const state = { rows: items.map((item, index) => ({ item, seq: index + 1, event: index + 1 })), clock: items.length, epoch, calls: [] as string[] };
  const push = (item: Item) => {
    state.clock += 1;
    state.rows.push({ item, seq: state.clock, event: state.clock });
  };
  const update = (seq: number, item: Item) => {
    state.clock += 1;
    Object.assign(state.rows.find((row) => row.seq === seq)!, { item, event: state.clock });
  };
  const fetch: TimelineFetch = async ({ direction, cursor, limit }) => {
    state.calls.push(`${direction}${cursor ? `:${cursor.seq}` : ""}`);
    const stale = cursor !== undefined && cursor.epoch !== state.epoch;
    const all = state.rows;
    let selected: typeof all;
    if (direction === "tail" || stale) selected = all.slice(-limit);
    else if (direction === "before") selected = all.filter((row) => row.seq < (cursor?.seq ?? 0)).slice(-limit);
    else selected = all.filter((row) => row.event > (cursor?.seq ?? 0)).sort((a, b) => a.event - b.event).slice(0, limit);
    const first = Math.min(...selected.map((row) => row.seq));
    const lastEvent = Math.max(0, ...selected.map((row) => row.event));
    const page: TimelinePage = {
      epoch: state.epoch,
      reset: stale,
      entries: selected.map((row) => ({ item: row.item, timestamp: `2026-11-08T05:${String(row.seq % 60).padStart(2, "0")}:00.000Z`, seqStart: row.seq, seqEnd: row.event })),
      hasOlder: selected.length > 0 && first > 1 && direction !== "after",
      hasNewer: direction === "after" && all.some((row) => row.event > lastEvent),
      startCursor: selected.length ? { epoch: state.epoch, seq: first } : null,
      endCursor: selected.length ? { epoch: state.epoch, seq: direction === "after" ? lastEvent : state.clock } : null,
      error: null,
    };
    return page;
  };
  return { state, fetch, push, update };
}

describe("historyRow", () => {
  it("keeps messages and tool calls whole, leaves out reasoning and the history tools' own calls, and redacts secrets", () => {
    const long = "x".repeat(5_000);
    expect(historyRow({ type: "user_message", text: long }, "t", "1@e")?.text).toBe(`You: ${long}`);
    expect(historyRow({ type: "reasoning", text: "private" }, "t", "1@e")).toBeNull();
    // Claude names Paseo's tools mcp__paseo__history_search; Codex names them paseo.history_search.
    for (const name of ["mcp__paseo__history_search", "paseo.history_load", "history_read"]) expect(historyRow({ type: "tool_call", name, status: "completed", detail: { type: "unknown", input: {}, output: "" } }, "t", "1@e"), name).toBeNull();
    const row = historyRow(shell("npm test", "ECONNRESET at api.ts:12\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789", "failed"), "t", "1@e");
    expect(row).toMatchObject({ kind: "tool", tool: "Bash", failed: true });
    expect(row?.text).toContain("$ npm test");
    expect(row?.text).toContain("ECONNRESET at api.ts:12");
    expect(row?.text).not.toContain("ghp_");
    expect(historyRow(edit("src/queue.ts"), "t", "1@e")?.files).toEqual(["src/queue.ts"]);
    expect(historyRow({ type: "compaction", status: "loading" }, "t", "1@e")).toBeNull();
    expect(historyRow({ type: "compaction", status: "completed", trigger: "auto", preTokens: 150_000 }, "t", "1@e")?.text).toBe("Context compacted (automatic, about 150,000 tokens before)");
    expect(historyRow({ type: "compaction", status: "completed" }, "t", "1@e")?.text).toBe("Context compacted");
  });
});

describe("ChatHistory", () => {
  it("reads the whole timeline once, then only rows after the last one read", async () => {
    const { state, fetch, push } = fakeTimeline([user("start"), ...Array.from({ length: 450 }, (_, n) => assistant(`step ${n}`))]);
    const history = new ChatHistory();
    const first = await history.rows("a1", fetch);
    expect(first.rows).toHaveLength(451);
    expect(first.rows[0]).toMatchObject({ id: "1@e1", text: "You: start" });
    push(user("more"));
    state.calls.length = 0;
    const second = await history.rows("a1", fetch);
    expect(second.rows.at(-1)).toMatchObject({ id: "452@e1", text: "You: more" });
    expect(second.rows).toHaveLength(452);
    expect(state.calls).toEqual(["after:451"]);
  });

  it("replaces a row Paseo updated under its old key, and keeps every row it did not change", async () => {
    const { fetch, push, update } = fakeTimeline([user("start"), shell("npm test", "", "running"), assistant("waiting"), user("next")]);
    const history = new ChatHistory();
    await history.rows("a1", fetch);
    update(2, shell("npm test", "ECONNRESET at api.ts:12", "failed"));
    push(assistant("it failed"));
    const { rows } = await history.rows("a1", fetch);
    expect(rows.map((row) => row.id)).toEqual(["1@e1", "2@e1", "3@e1", "4@e1", "6@e1"]);
    expect(rows[1]).toMatchObject({ failed: true });
    expect(rows[1].text).toContain("ECONNRESET");
  });

  it("drops the oldest rows past the byte limit, and says so", async () => {
    const { fetch } = fakeTimeline(Array.from({ length: 10 }, (_, n) => user(`${n}`.repeat(1_000))));
    const read = await new ChatHistory(20_000, 9_000).rows("a1", fetch);
    expect(read.capped).toBe(true);
    expect(read.rows.length).toBeLessThan(10);
    expect(read.rows.at(-1)?.text).toContain("9999");
  });

  it("rebuilds when Paseo reloaded the timeline under a new epoch, and says so", async () => {
    const { state, fetch } = fakeTimeline([user("before restart")]);
    const history = new ChatHistory();
    await history.rows("a1", fetch);
    state.epoch = "e2";
    state.rows = [{ item: user("before restart"), seq: 1, event: 1 }, { item: user("after restart"), seq: 2, event: 2 }];
    const again = await history.rows("a1", fetch);
    expect(again.reloaded).toBe(true);
    expect(again.rows.map((row) => row.id)).toEqual(["1@e2", "2@e2"]);
  });

  it("stops at the row cap and says so", async () => {
    const { fetch } = fakeTimeline(Array.from({ length: 30 }, (_, n) => user(`m${n}`)));
    const read = await new ChatHistory(10).rows("a1", fetch);
    expect(read.rows).toHaveLength(10);
    expect(read.capped).toBe(true);
    expect(read.rows[0].text).toBe("You: m20");
  });
});

describe("history tools", () => {
  const rows = [user("Fix the retry"), shell("npm test", "ECONNRESET at api.ts:12", "failed"), edit("src/queue.ts"), assistant("Fixed: retries now back off."), user("Also the docs")].map((item, index) => historyRow(item, `2026-11-08T05:0${index}:00.000Z`, `${index + 1}@e1`)!);

  it("searches every word, newest first, by text, tool, file, and failure", () => {
    expect(searchHistory(rows, { query: "econnreset" }).text).toContain("2@e1 · tool Bash, failed");
    expect(searchHistory(rows, { query: "retry fix" }).text).toContain("1@e1 · you");
    expect(searchHistory(rows, { files: ["src/queue.ts"] }).text).toContain("3@e1");
    expect(searchHistory(rows, { failed: true }).text).toContain("2@e1");
    expect(searchHistory(rows, { tools: ["Edit"] }).text).not.toContain("2@e1");
    const all = searchHistory(rows, {}).text;
    expect(all.indexOf("5@e1")).toBeLessThan(all.indexOf("1@e1"));
    expect(searchHistory(rows, { query: "nothing like this" }).text).toContain("No history matches");
  });

  it("loads at most three matches when asked, and names the rest", () => {
    const answer = searchHistory(rows, { load: true }).text;
    expect(answer).toContain("=== 5@e1");
    expect(answer).toContain("=== 3@e1");
    expect(answer).not.toContain("=== 2@e1");
    expect(answer).toContain('history_load({ ids: ["2@e1", "1@e1"] })');
  });

  it("browses around an item", () => {
    expect(browseHistory(rows, { id: "3@e1", direction: "before", count: 2 }).text).toMatch(/1@e1[\s\S]*2@e1/);
    expect(browseHistory(rows, { id: "3@e1", direction: "after", count: 5 }).text).toContain("5@e1");
    expect(browseHistory(rows, { id: "9@e1", direction: "around" }).text).toContain("No history item 9@e1");
  });

  it("loads items whole when they fit, and hands back a handle to read a larger one in pages, exactly", () => {
    const big = historyRow(user(`${"abcdefghij".repeat(2_000)}END`), "2026-11-08T06:00:00.000Z", "9@e1")!;
    const all = [...rows, big];
    const answer = loadHistory(all, ["1@e1", "9@e1"]).text;
    expect(Buffer.byteLength(answer, "utf8")).toBeLessThanOrEqual(ANSWER_MAX_BYTES);
    expect(answer).toContain("You: Fix the retry");
    expect(answer).toContain('history_read({ id: "9@e1" })');
    let text = "";
    for (let offset = 0, guard = 0; offset >= 0 && guard < 10; guard += 1) {
      const page = readHistory(all, { id: "9@e1", offset });
      expect(Buffer.byteLength(page.text, "utf8")).toBeLessThanOrEqual(ANSWER_MAX_BYTES);
      text += page.body;
      offset = page.next ?? -1;
    }
    expect(text).toBe(big.text);
  });

  it("keeps every answer within its budget, loading text after many references, and room for notes", () => {
    const many = Array.from({ length: 40 }, (_, n) => historyRow(user(`retry ${n} ${"detail ".repeat(300)}`), "2026-11-08T05:00:00.000Z", `${n + 1}@e1`)!);
    const answer = searchHistory(many, { query: "retry", load: true }).text;
    expect(Buffer.byteLength(answer, "utf8")).toBeLessThanOrEqual(ANSWER_MAX_BYTES);
    expect(answer).toContain("=== 40@e1 · you");
    expect(answer).toContain("detail detail");
    const big = historyRow(user("y".repeat(40_000)), "t", "1@e1")!;
    expect(Buffer.byteLength(readHistory([big], { id: "1@e1" }, 10_000).text, "utf8")).toBeLessThanOrEqual(10_000);
    expect(Buffer.byteLength(loadHistory([big, ...many.slice(0, 2)], ["1@e1", "2@e1", "3@e1"], 8_000).text, "utf8")).toBeLessThanOrEqual(8_000);
  });

  it("always moves on by a whole character, even one character at a time on an emoji", () => {
    const row = historyRow(user("a😀b"), "t", "1@e1")!;
    const start = row.text.indexOf("😀");
    const page = readHistory([row], { id: "1@e1", offset: start, limit: 1 });
    expect(page.body).toBe("😀");
    expect(page.next).toBe(start + 2);
  });

  it("refuses an id from before a reload", () => {
    expect(loadHistory(rows, ["1@old"]).text).toContain("history was reloaded");
    expect(readHistory(rows, { id: "1@old" }).text).toContain("history was reloaded");
  });

  it("judges an id from several chats' rows against its own chat's timeline only", () => {
    const mixed = [{ ...historyRow(user("from a"), "t", "1@e1")!, id: "chat-a:1@e1" }, { ...historyRow(user("from b"), "t", "1@e7")!, id: "chat-b:1@e7" }];
    expect(loadHistory(mixed, ["chat-b:9@e7"]).text).toContain("No history item chat-b:9@e7.");
    expect(loadHistory(mixed, ["chat-b:1@e6"]).text).toContain("history was reloaded");
    expect(loadHistory(mixed, ["chat-b:1@e7"]).text).toContain("You: from b");
  });
});
