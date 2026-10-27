import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Fetcher, type RunWorker } from "./fetches";
import type { PaseoApi } from "./paseo-types";
import { TagStore } from "./tag-store";

let dir: string;
let store: TagStore;
const paseo = {} as PaseoApi;
const settle = () => new Promise((done) => setTimeout(done, 20));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "contextualise-fetch-"));
  store = new TagStore(async () => dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A worker that registers its id, then answers with `reply` (or throws it when it is an Error).
function worker(reply: string | Error, agentId = "w1"): RunWorker {
  return async (_paseo, _root, _item, onCreated) => {
    onCreated(agentId);
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

test("a fetch is recorded at once and finished in the background", async () => {
  const fetcher = new Fetcher(store, async () => dir, worker('{"found":true,"title":"Login fails","url":"https://acme.atlassian.net/browse/PROJ-1","text":"Status: open"}'));
  const outcome = await fetcher.start(paseo, "auth", { vendor: "jira", ref: "PROJ-1" });
  expect(outcome.changed).toBe(true);
  await settle();
  expect((await store.read()).auth.notes[0]).toMatchObject({ status: "ready", title: "Login fails", url: "https://acme.atlassian.net/browse/PROJ-1", text: "Status: open", error: null });
});

test("an unreadable item and a failed worker both leave the reason on the note", async () => {
  await new Fetcher(store, async () => dir, worker('{"found":false,"title":"","url":null,"text":"No access to PROJ-2"}')).start(paseo, "auth", { vendor: "jira", ref: "PROJ-2" });
  await new Fetcher(store, async () => dir, worker(new Error("did not finish in 180 s"))).start(paseo, "auth", { vendor: "jira", ref: "PROJ-3" });
  await settle();
  const notes = (await store.read()).auth.notes;
  expect(notes.map((note) => [note.ref, note.status, note.error])).toEqual([
    ["PROJ-2", "failed", "No access to PROJ-2"],
    ["PROJ-3", "failed", "did not finish in 180 s"],
  ]);
});

test("only a registered fetch worker's own read tools are allowed; other agents are left alone", async () => {
  let release: () => void = () => {};
  const held: RunWorker = async (_p, _r, _i, onCreated) => {
    onCreated("w1");
    await new Promise<void>((done) => (release = done));
    return '{"found":false,"title":"","url":null,"text":"stopped"}';
  };
  const fetcher = new Fetcher(store, async () => dir, held);
  await fetcher.start(paseo, "auth", { vendor: "slack", ref: "https://a.slack.com/archives/C1/p1" });
  await settle();
  expect(await fetcher.decide("w1", "/anywhere", "mcp__claude_ai_Slack__slack_read_thread")).toBe("allow");
  expect(await fetcher.decide("w1", "/anywhere", "mcp__claude_ai_Slack__slack_send_message")).toBe("deny");
  expect(await fetcher.decide("someone-else", "/Users/m/project", "mcp__claude_ai_Slack__slack_send_message")).toBeNull();
  release();
  await settle();
  // Once the fetch is over, the worker's id is no longer trusted.
  expect(await fetcher.decide("w1", "/anywhere", "mcp__claude_ai_Slack__slack_read_thread")).toBeNull();
});

test("an unknown agent in the worker folder is denied", async () => {
  vi.useFakeTimers();
  const fetcher = new Fetcher(store, async () => dir);
  const decision = fetcher.decide("stray", join(dir, "workers"), "mcp__notion__notion-fetch");
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await decision).toBe("deny");
  vi.useRealTimers();
});

test("at most two workers run at once", async () => {
  let running = 0;
  let peak = 0;
  const slow: RunWorker = async (_p, _r, item, onCreated) => {
    onCreated(item.ref);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((done) => setTimeout(done, 15));
    running -= 1;
    return '{"found":true,"title":"t","url":null,"text":"x"}';
  };
  const fetcher = new Fetcher(store, async () => dir, slow);
  for (const ref of ["P-1", "P-2", "P-3", "P-4", "P-5"]) await fetcher.start(paseo, "bulk", { vendor: "jira", ref });
  await new Promise((done) => setTimeout(done, 150));
  expect(peak).toBe(2);
  expect((await store.read()).bulk.notes.every((note) => note.status === "ready")).toBe(true);
});
