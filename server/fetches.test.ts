import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type FetchProvider, snapshotSettingsSchema } from "../shared/contracts";
import { Fetcher, type RunWorker } from "./fetches";
import type { PaseoApi } from "./paseo-types";
import { TagStore } from "./tag-store";

let dir: string;
let store: TagStore;
const paseo = {} as PaseoApi;
const settle = () => new Promise((done) => setTimeout(done, 20));
const servers = new Map<FetchProvider, Set<string>>([
  ["claude", new Set()],
  ["codex", new Set(["notion"])],
]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "contextualise-fetch-"));
  store = new TagStore(async () => dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fetcher(runWorker: RunWorker, settings: Record<string, unknown> = {}) {
  return new Fetcher({ store, resolveRoot: async () => dir, settings: async () => snapshotSettingsSchema.parse(settings), configuredServers: async () => servers, runWorker });
}

// A worker that registers its id, then answers with `reply` (or throws it when it is an Error).
function worker(reply: string | Error, agentId = "w1"): RunWorker {
  return async (_paseo, _root, _job, onCreated) => {
    onCreated(agentId);
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

test("a fetch is recorded at once, finished in the background, and remembers its agent", async () => {
  const jobs: unknown[] = [];
  const run: RunWorker = async (_p, _r, job, onCreated) => {
    jobs.push(job);
    onCreated("w1");
    return '{"found":true,"title":"Login fails","url":"https://acme.atlassian.net/browse/PROJ-1","text":"Status: open"}';
  };
  const outcome = await fetcher(run, { commentsPerItem: 3, fetchTimeoutSeconds: 60, claudeFetchModel: "claude-sonnet-5-5" }).start(paseo, "auth", { vendor: "jira", ref: "PROJ-1" });
  expect(outcome).toMatchObject({ changed: true, provider: "claude", server: "claude_ai_Atlassian_Rovo" });
  await settle();
  expect((await store.read()).auth.notes[0]).toMatchObject({ status: "ready", title: "Login fails", provider: "claude", error: null });
  expect(jobs[0]).toMatchObject({ model: "claude-sonnet-5-5", timeoutMs: 60_000 });
  expect(String((jobs[0] as { prompt: string }).prompt)).toContain("up to 3");
});

test("with no usable connector the fetch fails at once and nothing is saved", async () => {
  await expect(fetcher(worker("{}"), { fetchProvider: "codex" }).start(paseo, "auth", { vendor: "sentry", ref: "https://a.sentry.io/issues/1/" })).rejects.toThrow("No Codex agent has a Sentry connector");
  expect(await store.read()).toEqual({});
});

test("an unreadable item and a failed worker both leave the reason on the note", async () => {
  await fetcher(worker('{"found":false,"title":"","url":null,"text":"No access to PROJ-2"}')).start(paseo, "auth", { vendor: "jira", ref: "PROJ-2" });
  await fetcher(worker(new Error("did not finish in 180 s"))).start(paseo, "auth", { vendor: "jira", ref: "PROJ-3" });
  await settle();
  expect((await store.read()).auth.notes.map((note) => [note.ref, note.status, note.error])).toEqual([
    ["PROJ-2", "failed", "No access to PROJ-2"],
    ["PROJ-3", "failed", "did not finish in 180 s"],
  ]);
});

test("the stored copy is capped by the setting", async () => {
  await fetcher(worker(JSON.stringify({ found: true, title: "Long", url: null, text: "y".repeat(5_000) })), { noteMaxChars: 1_000 }).start(paseo, "auth", { vendor: "jira", ref: "PROJ-4" });
  await settle();
  expect((await store.read()).auth.notes[0].text.length).toBe(1_000);
});

test("only a registered worker's own route is allowed; other agents are left alone", async () => {
  let release: () => void = () => {};
  const held: RunWorker = async (_p, _r, _j, onCreated) => {
    onCreated("w1");
    await new Promise<void>((done) => (release = done));
    return '{"found":false,"title":"","url":null,"text":"stopped"}';
  };
  const instance = fetcher(held, { fetchProvider: "codex" });
  await instance.start(paseo, "auth", { vendor: "notion", ref: "https://www.notion.so/a" });
  await settle();
  const ask = (server: string, tool: string) => ({ name: "CodexMcpElicitation", description: `Allow the ${server} MCP server to run tool "${tool}"?`, metadata: { serverName: server } });
  expect(await instance.decide("w1", "/anywhere", ask("notion", "notion-fetch"))).toBe("allow");
  expect(await instance.decide("w1", "/anywhere", ask("notion", "notion-create-pages"))).toBe("deny");
  expect(await instance.decide("someone-else", "/Users/m/project", ask("notion", "notion-create-pages"))).toBeNull();
  release();
  await settle();
  expect(await instance.decide("w1", "/anywhere", ask("notion", "notion-fetch"))).toBeNull();
});

test("an unknown agent in the worker folder is denied", async () => {
  vi.useFakeTimers();
  const decision = fetcher(worker("{}")).decide("stray", join(dir, "workers"), { name: "mcp__notion__notion-fetch" });
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await decision).toBe("deny");
  vi.useRealTimers();
});

test("no more workers run at once than the setting allows", async () => {
  let running = 0;
  let peak = 0;
  const slow: RunWorker = async (_p, _r, job, onCreated) => {
    onCreated(job.title);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((done) => setTimeout(done, 15));
    running -= 1;
    return '{"found":true,"title":"t","url":null,"text":"x"}';
  };
  const instance = fetcher(slow, { maxConcurrentFetches: 3 });
  for (const ref of ["P-1", "P-2", "P-3", "P-4", "P-5", "P-6"]) await instance.start(paseo, "bulk", { vendor: "jira", ref });
  await new Promise((done) => setTimeout(done, 200));
  expect(peak).toBe(3);
  expect((await store.read()).bulk.notes.every((note) => note.status === "ready")).toBe(true);
});
