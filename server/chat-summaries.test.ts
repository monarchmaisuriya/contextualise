import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { TimelineFetch, TimelinePage } from "./chat-history";
import { type ChatSummary, PIECE_BYTES, piecesOf, SUMMARY_MAX_CHARS, type SummarizeDeps, summarizeChat, SummaryStore, unitOf } from "./chat-summaries";

type Item = Record<string, unknown>;
const user = (text: string): Item => ({ type: "user_message", text });
const agent = (text: string): Item => ({ type: "assistant_message", text });

// A chat's timeline, paged like Paseo's: newest page first, then older pages before a cursor.
function timeline(items: Item[], options: { epoch?: string; time?: (index: number) => string } = {}): TimelineFetch & { reads: number } {
  const epoch = options.epoch ?? "e1";
  const time = options.time ?? ((index: number) => `2026-11-11T10:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`);
  const fetch = (async ({ direction, cursor, limit }) => {
    fetch.reads += 1;
    const rows = items.map((item, index) => ({ item, timestamp: time(index), seqStart: index + 1 }));
    const selected = direction === "before" ? rows.filter((row) => row.seqStart < (cursor?.seq ?? 0)).slice(-limit) : rows.slice(-limit);
    const first = selected[0]?.seqStart ?? 0;
    const page: TimelinePage = { epoch, reset: false, entries: selected, hasOlder: first > 1, hasNewer: false, startCursor: selected.length ? { epoch, seq: first } : null, endCursor: selected.length ? { epoch, seq: selected.at(-1)!.seqStart } : null, error: null };
    return page;
  }) as TimelineFetch & { reads: number };
  fetch.reads = 0;
  return fetch;
}

const reply = (summary: Partial<ChatSummary>) => JSON.stringify({ goal: "", done: [], decisions: [], open: [], facts: [], ...summary });

describe("summarizeChat", () => {
  let store: SummaryStore;
  let prompts: string[];
  let runsLeft: number;
  let answer: (prompt: string, index: number) => string;
  const deps = (): SummarizeDeps => ({
    store,
    takeRun: async () => runsLeft-- > 0,
    write: async (prompt) => {
      prompts.push(prompt);
      return answer(prompt, prompts.length);
    },
    now: () => new Date("2026-11-11T12:00:00.000Z"),
  });
  // What each prompt carried as the next part of the chat.
  const parts = () => prompts.map((prompt) => prompt.slice(prompt.indexOf("<next_part>\n") + 12, prompt.indexOf("\n</next_part>")));

  beforeEach(() => {
    const file = join(mkdtempSync(join(tmpdir(), "contextualise-summaries-")), "chat-summaries.json");
    store = new SummaryStore(async () => file);
    prompts = [];
    runsLeft = 1_000;
    answer = (_prompt, index) => reply({ goal: "Ship the import", done: [`step ${index}`] });
  });

  it("reaches back to the first message of a long chat, oldest piece first, and counts every message", async () => {
    // More than 2,000 items and more than one piece: the old reader stopped at 10 pages of 200.
    const items = Array.from({ length: 2_400 }, (_, index) => (index % 2 === 0 ? user(`request ${index} ${"x".repeat(30)}`) : agent(`reply ${index}`)));
    expect(await summarizeChat("c1", timeline(items), deps())).toBe("done");
    expect(prompts.length).toBeGreaterThan(1);
    expect(parts()[0].startsWith("user: request 0 ")).toBe(true);
    expect(parts().at(-1)).toContain("agent: reply 2399");
    // Every unit was sent exactly once.
    expect(parts().join("\n").split("\n")).toHaveLength(2_400);
    const entry = (await store.get("c1"))!;
    expect(entry).toMatchObject({ messages: 2_400, anchor: { units: 2_400 }, summary: { goal: "Ship the import" } });
    expect(entry.stuckAt).toBeUndefined();
  });

  it("sends only what was added since, with the summary so far, and nothing when nothing was added", async () => {
    const items = [user("Import the list"), agent("Imported 120 contacts")];
    await summarizeChat("c1", timeline(items), deps());
    prompts = [];
    expect(await summarizeChat("c1", timeline(items), deps())).toBe("current");
    expect(prompts).toEqual([]);
    items.push(user("Now the second list"), { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "npm run import", exitCode: 0 } }, agent("Done"));
    expect(await summarizeChat("c1", timeline(items), deps())).toBe("done");
    expect(parts()).toEqual(["user: Now the second list\nran: npm run import (exit 0)\nagent: Done"]);
    expect(prompts[0]).toContain('"goal":"Ship the import"');
    expect((await store.get("c1"))!).toMatchObject({ messages: 4, anchor: { units: 5 } });
  });

  it("finds its place in a timeline Paseo rebuilt with new ids and times, and starts again when the chat was rewound", async () => {
    const items = [user("one"), agent("two"), user("three"), agent("four")];
    await summarizeChat("c1", timeline(items), deps());
    prompts = [];
    // Rebuilt: other epoch, ids and times; the same content.
    expect(await summarizeChat("c1", timeline(items, { epoch: "e9", time: () => "2026-11-11T11:00:00.000Z" }), deps())).toBe("current");
    // One unit added after a rebuild: only it is sent.
    expect(await summarizeChat("c1", timeline([...items, user("five")], { epoch: "e9" }), deps())).toBe("done");
    expect(parts()).toEqual(["user: five"]);
    prompts = [];
    // Rewound: the place is gone, so the whole chat is summarised again, from its first message.
    expect(await summarizeChat("c1", timeline([user("one"), agent("two"), user("three, said again")]), deps())).toBe("done");
    expect(parts()[0].startsWith("user: one")).toBe(true);
    expect(prompts[0]).toContain("<summary_so_far>\nnone");
    expect((await store.get("c1"))!.messages).toBe(3);
  });

  it("sends each unit once when many share one time across a piece boundary", async () => {
    const items = Array.from({ length: 30 }, (_, index) => user(`same time ${index} ${"y".repeat(4_000)}`));
    await summarizeChat("c1", timeline(items, { time: () => "2026-11-11T10:00:00.000Z" }), deps());
    expect(prompts.length).toBeGreaterThan(1);
    const sent = parts().join("\n");
    for (let index = 0; index < 30; index += 1) expect(sent.split(`same time ${index} `)).toHaveLength(2);
  });

  it("keeps the pieces already summarised when a run fails, and carries on from there", async () => {
    const items = Array.from({ length: 40 }, (_, index) => user(`message ${index} ${"z".repeat(4_000)}`));
    answer = (_prompt, index) => {
      if (index === 3) throw new Error("worker timed out");
      return reply({ goal: "Long chat", done: [`piece ${index}`] });
    };
    await expect(summarizeChat("c1", timeline(items), deps())).rejects.toThrow("worker timed out");
    const kept = (await store.get("c1"))!;
    expect(kept.anchor!.units).toBeGreaterThan(0);
    const firstRun = parts();
    prompts = [];
    answer = () => reply({ goal: "Long chat" });
    expect(await summarizeChat("c1", timeline(items), deps())).toBe("done");
    // The second run starts where the saved summary stopped: the failed piece is sent again, the two before are not.
    expect(parts()[0]).toBe(firstRun[2]);
    expect((await store.get("c1"))!.messages).toBe(40);
  });

  it("never cuts a summary: after three replies over the limit it keeps the last good one, says it stops there, and waits a day", async () => {
    const items = [user("first"), agent("first reply")];
    await summarizeChat("c1", timeline(items), deps());
    const good = (await store.get("c1"))!;
    answer = () => reply({ goal: "g".repeat(SUMMARY_MAX_CHARS + 1) });
    prompts = [];
    expect(await summarizeChat("c1", timeline([...items, user("more")]), deps())).toBe("stuck");
    expect(prompts).toHaveLength(3);
    const stuck = (await store.get("c1"))!;
    expect(stuck.summary).toEqual(good.summary);
    expect(stuck.anchor).toEqual(good.anchor);
    expect(stuck.stuckAt).toBe("2026-11-11T12:00:00.000Z");
    prompts = [];
    expect(await summarizeChat("c1", timeline([...items, user("more"), agent("and more")]), deps())).toBe("stuck");
    expect(prompts).toEqual([]);
  });

  it("records a chat whose first piece cannot be summarised, so it is not tried again on every quiet period", async () => {
    answer = () => "not json at all";
    expect(await summarizeChat("c1", timeline([user("hello")]), deps())).toBe("stuck");
    expect(await store.get("c1")).toMatchObject({ summary: null, anchor: null, messages: 0 });
    prompts = [];
    expect(await summarizeChat("c1", timeline([user("hello"), agent("hi")]), deps())).toBe("stuck");
    expect(prompts).toEqual([]);
  });

  it("splits one message longer than a piece into labelled parts and sends them all", async () => {
    const long = "w".repeat(PIECE_BYTES * 2);
    await summarizeChat("c1", timeline([user(long), agent("ok")]), deps());
    expect(parts()[0].startsWith("(part 1 of 3) user: ")).toBe(true);
    expect(parts().join("").replace(/\(part \d of 3\) /g, "").split("w").length - 1).toBe(PIECE_BYTES * 2);
    expect((await store.get("c1"))!.messages).toBe(2);
  });

  it("removes secrets from what the model wrote before storing it", async () => {
    const key = `pk_${"a1B2c3D4".repeat(5)}`;
    answer = () => reply({ goal: "Import", facts: [`KEY=${key}`] });
    await summarizeChat("c1", timeline([user("go")]), deps());
    expect(JSON.stringify(await store.get("c1"))).not.toContain(key);
  });

  it("stops at today's cap without changing the summary", async () => {
    runsLeft = 0;
    expect(await summarizeChat("c1", timeline([user("go")]), deps())).toBe("capped");
    expect(await store.get("c1")).toBeNull();
  });

  it("does not write back a summary removed while its run was in flight", async () => {
    answer = () => {
      void store.remove("c1");
      return reply({ goal: "late" });
    };
    expect(await summarizeChat("c1", timeline([user("go")]), deps())).toBe("removed");
    expect(await store.get("c1")).toBeNull();
  });
});

describe("summarizeChat, after review", () => {
  let store: SummaryStore;
  let file: string;
  let prompts: string[];
  let now: Date;
  let answer: () => string;
  const deps = (): SummarizeDeps => ({ store, takeRun: async () => true, write: async (prompt) => (prompts.push(prompt), answer()), now: () => now });
  const parts = () => prompts.map((prompt) => prompt.slice(prompt.indexOf("<next_part>\n") + 12, prompt.indexOf("\n</next_part>")));
  const shell = (command: string, exitCode: number): Item => ({ type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command, exitCode } });
  const edit = (filePath: string): Item => ({ type: "tool_call", name: "Edit", status: "completed", detail: { type: "edit", filePath } });
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), "contextualise-summaries-")), "chat-summaries.json");
    store = new SummaryStore(async () => file);
    prompts = [];
    now = new Date("2026-11-11T12:00:00.000Z");
    answer = () => reply({ goal: "Fix the test" });
  });

  it("never skips new messages when the chat repeats the units its summary ends on", async () => {
    const items = [user("fix it"), edit("a.ts"), shell("npm test", 1), edit("a.ts")];
    await summarizeChat("c1", timeline(items), deps());
    items.push(user("IMPORTANT NEW REQUEST"), shell("npm test", 1), edit("a.ts"), shell("npm test", 1), edit("a.ts"), agent("end"));
    prompts = [];
    await summarizeChat("c1", timeline(items), deps());
    expect(parts()).toEqual(["user: IMPORTANT NEW REQUEST\nran: npm test (exit 1)\nedit: a.ts\nran: npm test (exit 1)\nedit: a.ts\nagent: end"]);
    // The same after Paseo rebuilt the timeline: the place is found by position, not by the repeated pattern.
    const rebuilt = [...items, user("one more")];
    prompts = [];
    await summarizeChat("c1", timeline(rebuilt, { epoch: "e2" }), deps());
    expect(parts()).toEqual(["user: one more"]);
  });

  it("marks a summary complete only once it reaches the end of the chat", async () => {
    const items = Array.from({ length: 30 }, (_, index) => user(`message ${index} ${"z".repeat(4_000)}`));
    let calls = 0;
    answer = () => {
      calls += 1;
      if (calls === 2) throw new Error("worker timed out");
      return reply({ goal: "Long" });
    };
    await expect(summarizeChat("c1", timeline(items), deps())).rejects.toThrow("worker timed out");
    expect((await store.get("c1"))!.complete).toBe(false);
    await summarizeChat("c1", timeline(items), deps());
    expect((await store.get("c1"))!.complete).toBe(true);
  });

  it("does not try a stuck piece again while the chat has not grown, even a day later", async () => {
    answer = () => reply({ goal: "g".repeat(SUMMARY_MAX_CHARS + 1) });
    const items = [user("hello")];
    expect(await summarizeChat("c1", timeline(items), deps())).toBe("stuck");
    prompts = [];
    now = new Date("2026-11-13T12:00:00.000Z");
    expect(await summarizeChat("c1", timeline(items), deps())).toBe("stuck");
    expect(prompts).toEqual([]);
    // Grown and a day later: tried again.
    expect(await summarizeChat("c1", timeline([...items, agent("hi")]), deps())).toBe("stuck");
    expect(prompts).toHaveLength(3);
  });

  it("never writes over a summaries file it cannot read", async () => {
    writeFileSync(file, "{ not json");
    await expect(summarizeChat("c1", timeline([user("go")]), deps())).rejects.toThrow("move it aside");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("piecesOf", () => {
  it("never exceeds a piece's size and covers only whole units", () => {
    const units = [unitOf({ type: "user_message", text: "a".repeat(100) } as never, "t")!, unitOf({ type: "user_message", text: "b".repeat(PIECE_BYTES) } as never, "t")!];
    const pieces = piecesOf(units);
    for (const piece of pieces) expect(Buffer.byteLength(piece.text, "utf8")).toBeLessThanOrEqual(PIECE_BYTES);
    // The long unit fills two pieces: the first of them ends inside it, so it covers only the first unit.
    expect(pieces.map((piece) => piece.units)).toEqual([1, 1, 2]);
  });
});
