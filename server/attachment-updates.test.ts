import { execFileSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { attachmentUpdates, chatSubject, fileSubject, folderSubject, grantsIn, GRANT_LINE, SeenStore, type Subject, tagNotesSubject, terminalSubject } from "./attachment-updates";
import type { TimelineFetch, TimelinePage } from "./chat-history";
import type { UpdatesGrant } from "./knowledge/auth";

type Item = Record<string, unknown>;
const user = (text: string): Item => ({ type: "user_message", text });
const agent = (text: string): Item => ({ type: "assistant_message", text });

// A chat's timeline; item i is at 10:00 plus i minutes.
function timeline(items: Item[], epoch = "e1"): TimelineFetch {
  return async ({ direction, cursor, limit }) => {
    const rows = items.map((item, index) => ({ item, timestamp: new Date(Date.parse("2026-11-11T10:00:00.000Z") + index * 60_000).toISOString(), seqStart: index + 1 }));
    const selected = direction === "before" ? rows.filter((row) => row.seqStart < (cursor?.seq ?? 0)).slice(-limit) : rows.slice(-limit);
    const first = selected[0]?.seqStart ?? 0;
    const page: TimelinePage = { epoch, reset: false, entries: selected, hasOlder: first > 1, hasNewer: false, startCursor: selected.length ? { epoch, seq: first } : null, endCursor: selected.length ? { epoch, seq: selected.at(-1)!.seqStart } : null, error: null };
    return page;
  };
}

describe("attachmentUpdates", () => {
  let store: SeenStore;
  let items: Item[];
  // "good.<chat>.<id>" is a signed grant for that chat; "old.<chat>.<id>" one past its deadline.
  const verify = (grant: string): UpdatesGrant | null => {
    const [state, agentId, id] = grant.split(".");
    if (state !== "good" && state !== "old") return null;
    return { kind: "chat-updates", agentId, upTo: "2026-11-11T10:01:30.000Z", id: id ?? agentId, expires: state === "good" ? "2026-11-12T00:00:00.000Z" : "2026-11-10T00:00:00.000Z" };
  };
  const now = () => new Date("2026-11-11T12:00:00.000Z");
  const subjects = async (grants: readonly UpdatesGrant[]): Promise<Subject[]> => grants.map((grant) => chatSubject(`chat:${(grant as { agentId: string }).agentId}`, `Chat "${(grant as { agentId: string }).agentId}"`, { time: (grant as { upTo: string }).upTo }, () => timeline(items)));
  const call = (grants: string[], extra: Partial<Parameters<typeof attachmentUpdates>[2]> = {}, chat = "receiver") => attachmentUpdates(chat, grants, { store, verify, subjects, now, ...extra });

  beforeEach(() => {
    const file = join(mkdtempSync(join(tmpdir(), "contextualise-updates-")), "attachment-seen.json");
    store = new SeenStore(async () => file);
    items = [user("first"), agent("first reply"), user("second, after the attachment"), agent("second reply")];
  });

  it("returns what came after the attachment, then nothing, and remembers the grant across calls", async () => {
    const first = await call(["good.c1"]);
    expect(first).toContain('## Chat "c1"\nuser: second, after the attachment\nagent: second reply');
    expect(first).not.toContain("first reply");
    expect(await call([])).toContain("Nothing new in this chat's 1 attachment since you last asked.");
    items.push(user("third"));
    expect(await call([])).toContain('## Chat "c1"\nuser: third');
  });

  it("refuses a grant Contextualise did not write and reads nothing for it", async () => {
    const answer = await call(["forged.c1"]);
    expect(answer).toContain("1 grant refused");
    expect(answer).toContain("Nothing new in this chat's 0 attachments");
  });

  it("sends whole items within the budget, and the rest on the next call, none repeated or skipped", async () => {
    items = [user("old"), ...Array.from({ length: 12 }, (_, index) => agent(`reply ${index} ${"r".repeat(900)}`))];
    const seen: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const answer = await call(round === 0 ? ["good.c1"] : [], { budget: 4_096 });
      seen.push(...[...answer.matchAll(/agent: (reply \d+) r+/g)].map((match) => match[1]));
      expect(Buffer.byteLength(answer, "utf8")).toBeLessThan(4_096 + 1_200);
      if (!answer.includes("not shown yet")) break;
    }
    // Item 0 is before the grant's time (10:01:30): replies 1 to 11 follow it.
    expect(seen).toEqual(Array.from({ length: 11 }, (_, index) => `reply ${index + 1}`));
  });

  it("sends an item larger than the whole budget alone rather than cut it", async () => {
    items = [user("old"), agent("x"), agent(`huge ${"h".repeat(6_000)}`), agent("after")];
    const first = await call(["good.c1"], { budget: 2_048 });
    expect(first).toContain(`huge ${"h".repeat(6_000)}`);
    expect(first).toContain("1 more new item not shown yet");
    expect(await call([], { budget: 2_048 })).toContain("agent: after");
  });

  it("refuses a grant past its deadline, and one another chat redeemed first", async () => {
    expect(await call(["old.c1.x"])).toContain("1 grant refused: it expired before it was first used.");
    await call(["good.c1.shared"], {}, "first-chat");
    expect(await call(["good.c1.shared"], {}, "second-chat")).toContain("1 grant refused: it belongs to another chat.");
    // The chat that redeemed it keeps it.
    items.push(user("more"));
    expect(await call([], {}, "first-chat")).toContain("user: more");
  });

  it("keeps a new grant even when reading the attachments fails, so it is followed next turn", async () => {
    await expect(call(["good.c1"], { subjects: async () => Promise.reject(new Error("daemon busy")) })).rejects.toThrow("daemon busy");
    expect(await call([])).toContain('## Chat "c1"');
  });

  it("leaves an attachment slower than its limit for the next call, seen where it was", async () => {
    const slow: Subject = { key: "slow", read: () => new Promise(() => undefined) };
    const answer = await call(["good.c1"], { subjects: async (grants) => [slow, ...(await subjects(grants))], waitMs: 50 });
    expect(answer).toContain("Could not read slow: it took longer than 0.05 seconds");
    expect(answer).toContain("user: second, after the attachment");
  });

  it("finds the grant lines in an attachment's text", () => {
    expect(grantsIn(`Some chat\n\n${GRANT_LINE} abc.def\nand ${GRANT_LINE} ghi_1.jk-2`)).toEqual(["abc.def", "ghi_1.jk-2"]);
  });
});

describe("terminalSubject", () => {
  // A terminal: `output` is everything printed; it keeps the last `kept` lines, and reports `total`
  // lines, which some terminals stop counting past their scrollback.
  let output: string[];
  let kept: number;
  let capped: number | null;
  const terminals = { capture: async (_id: string, start: number) => ({ lines: output.slice(Math.max(0, output.length + start, output.length - kept)), totalLines: capped === null ? output.length : Math.min(output.length, capped) }) };

  it("gives the lines after those seen from one capture, says what scrolled out of view, and starts again after a clear", async () => {
    output = Array.from({ length: 130 }, (_, index) => `line ${index + 1}`);
    kept = 10_000;
    capped = null;
    const subject = terminalSubject("terminal:t1", 'Terminal "dev"', "t1", 100, terminals);
    const first = await subject.read(undefined);
    expect(first.items.map((item) => item.text).join("\n")).toBe(Array.from({ length: 30 }, (_, index) => `line ${index + 101}`).join("\n"));
    const seen = first.seen(first.items.length);
    expect(seen).toMatchObject({ lines: 130 });
    output = [...output, ...Array.from({ length: 50 }, (_, index) => `more ${index}`)];
    kept = 20;
    const second = await subject.read(seen);
    expect(second.note).toContain("30 earlier new lines are no longer in view");
    expect(second.seen(second.items.length)).toMatchObject({ lines: 180 });
    output = ["fresh"];
    kept = 10_000;
    const third = await subject.read({ lines: 180 });
    expect(third.note).toContain("cleared or restarted");
    expect(third.items[0].text).toBe("fresh");
  });

  it("notices new output when the line count stops growing because the scrollback is full", async () => {
    output = Array.from({ length: 1_000 }, (_, index) => `line ${index}`);
    kept = 1_000;
    capped = 1_000;
    const subject = terminalSubject("terminal:t1", 'Terminal "dev"', "t1", 1_000, terminals);
    const quiet = await subject.read(undefined);
    expect(quiet.items).toEqual([]);
    const seen = quiet.seen(0);
    output = [...output, "build finished"];
    const changed = await subject.read(seen);
    expect(changed.note).toContain("its scrollback is likely full");
    expect(changed.items.at(-1)!.text.endsWith("build finished")).toBe(true);
    expect((await subject.read(changed.seen(changed.items.length))).items).toEqual([]);
  });
});

describe("tagNotesSubject", () => {
  it("says an item that finished fetching after a later one was said", async () => {
    const note = (id: string, addedAt: string, status: "ready" | "fetching") => ({ id, vendor: "jira", ref: id, title: id, url: null, status, text: `${id} body`, error: null, addedAt, fetchedAt: null, provider: null, notifyAgentId: null });
    let notes = [note("A", "2026-11-11T10:01:00.000Z", "fetching"), note("B", "2026-11-11T10:02:00.000Z", "ready")];
    const tag = async () => ({ key: "k", name: "k", hasWorkspaceLabel: true, workspaces: [], agents: [], links: [], notes }) as never;
    const subject = tagNotesSubject("tag:k:items", "Tag", tag, "2026-11-11T10:00:00.000Z");
    const first = await subject.read(undefined);
    expect(first.items.map((item) => item.text.split("\n")[0])).toEqual(["New item: B"]);
    notes = [note("A", "2026-11-11T10:01:00.000Z", "ready"), notes[1]];
    const second = await subject.read(first.seen(1));
    expect(second.items.map((item) => item.text.split("\n")[0])).toEqual(["New item: A"]);
  });
});

describe("fileSubject and folderSubject", () => {
  it("says a file changed after it was attached, once", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "contextualise-file-")), "notes.md");
    writeFileSync(file, "v1");
    utimesSync(file, new Date("2026-11-11T09:00:00.000Z"), new Date("2026-11-11T09:00:00.000Z"));
    const subject = fileSubject("file:x", file, "2026-11-11T10:00:00.000Z");
    expect((await subject.read(undefined)).items).toEqual([]);
    utimesSync(file, new Date("2026-11-11T11:00:00.000Z"), new Date("2026-11-11T11:00:00.000Z"));
    const changed = await subject.read(undefined);
    expect(changed.items[0].text).toContain("Changed at 2026-11-11T11:00:00.000Z");
    expect((await subject.read(changed.seen(1))).items).toEqual([]);
  });

  it("lists new commits once, in order, and uncommitted changes when they change", async () => {
    const repo = mkdtempSync(join(tmpdir(), "contextualise-folder-"));
    const sh = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-11T09:00:00Z", GIT_COMMITTER_DATE: "2026-11-11T09:00:00Z" } });
    sh("init", "-q");
    sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "before the chat");
    const subject = folderSubject("folder:r", 'Project "r"', repo, "2026-11-11T10:00:00.000Z");
    const empty = await subject.read(undefined);
    expect(empty.items).toEqual([]);
    let seen = empty.seen(0);
    writeFileSync(join(repo, "a.ts"), "x");
    execFileSync("git", ["-C", repo, "add", "a.ts"]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add a"]);
    writeFileSync(join(repo, "b.ts"), "y");
    const read = await subject.read(seen);
    expect(read.items.map((item) => item.text.split("\n")[0])).toEqual([expect.stringMatching(/^Commit [0-9a-f]+ add a$/), "Uncommitted changes now:"]);
    expect(read.items[0].text).toContain("files: a.ts");
    seen = read.seen(read.items.length);
    expect((await subject.read(seen)).items).toEqual([]);
    // A rewritten history (the commit seen is gone) goes on from the new head, and says so.
    execFileSync("git", ["-C", repo, "add", "b.ts"]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--amend", "-m", "add a and b"]);
    const rewritten = await subject.read(seen);
    expect(rewritten.note).toContain("history was rewritten");
    const after = rewritten.seen(rewritten.items.length);
    writeFileSync(join(repo, "c.ts"), "z");
    execFileSync("git", ["-C", repo, "add", "c.ts"]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add c"]);
    expect((await subject.read(after)).items.map((item) => item.text.split("\n")[0])).toEqual([expect.stringMatching(/^Commit [0-9a-f]+ add c$/)]);
  });
});
