import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FETCH_RESULT_KIND, type FetchProvider, type FetchResult, snapshotSettingsSchema } from "../shared/contracts";
import { Fetcher, postFetchResult, type ReportResult, type RunWorker } from "./fetches";
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

function fetcher(runWorker: RunWorker, settings: Record<string, unknown> = {}, report: ReportResult = async () => {}) {
  return new Fetcher({ store, resolveRoot: async () => dir, settings: async () => snapshotSettingsSchema.parse(settings), configuredServers: async () => servers, runWorker, report });
}

// Collects the results a fetcher reports, as [agent, result] pairs.
function reports() {
  const sent: Array<[string, FetchResult]> = [];
  const report: ReportResult = async (_paseo, agentId, result) => {
    sent.push([agentId, result]);
  };
  return { sent, report };
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
  // Workers hold until released, so the overlap does not depend on how fast the starts run.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const slow: RunWorker = async (_p, _r, job, onCreated) => {
    onCreated(job.title);
    running += 1;
    peak = Math.max(peak, running);
    await gate;
    running -= 1;
    return '{"found":true,"title":"t","url":null,"text":"x"}';
  };
  const instance = fetcher(slow, { maxConcurrentFetches: 3 });
  for (const ref of ["P-1", "P-2", "P-3", "P-4", "P-5", "P-6"]) await instance.start(paseo, "bulk", { vendor: "jira", ref });
  await vi.waitFor(() => expect(running).toBe(3));
  expect(peak).toBe(3);
  release();
  await vi.waitFor(async () => expect((await store.read()).bulk.notes.every((note) => note.status === "ready")).toBe(true));
  expect(peak).toBe(3);
});

test("a fetch started from an agent is reported to it when it ends, and its refresh reports to it again", async () => {
  const { sent, report } = reports();
  const instance = fetcher(worker('{"found":true,"title":"Login fails","url":null,"text":"Status: open"}'), {}, report);
  const { noteId } = await instance.start(paseo, "auth", { vendor: "jira", ref: "PROJ-1" }, undefined, "a1");
  await settle();
  expect(sent).toEqual([["a1", { tag: "auth", noteId, vendor: "jira", ref: "PROJ-1", title: "Login fails", status: "ready", error: null, chars: 12 }]]);
  expect((await store.read()).auth.notes[0].notifyAgentId).toBe("a1");
  // A refresh from anywhere (the Tags screen has no agent) reports to the agent stored on the note.
  await instance.refresh(paseo, "auth", noteId);
  await settle();
  expect(sent.map(([agentId, result]) => [agentId, result.noteId])).toEqual([
    ["a1", noteId],
    ["a1", noteId],
  ]);
});

test("no report without an asking agent, for automatic refreshes, or with the setting off", async () => {
  const { sent, report } = reports();
  const reply = '{"found":true,"title":"t","url":null,"text":"x"}';
  const quiet = fetcher(worker(reply), {}, report);
  await quiet.start(paseo, "auth", { vendor: "jira", ref: "PROJ-1" });
  const { noteId } = await quiet.start(paseo, "auth", { vendor: "jira", ref: "PROJ-2" }, undefined, "a1");
  await settle();
  sent.length = 0;
  await quiet.refresh(paseo, "auth", noteId, { auto: true });
  await fetcher(worker(reply), { notifyFetchResults: false }, report).start(paseo, "auth", { vendor: "jira", ref: "PROJ-3" }, undefined, "a1");
  await settle();
  expect(sent).toEqual([]);
});

test("a failed fetch is reported with its reason, and a report that cannot be posted is only logged", async () => {
  const { sent, report } = reports();
  await fetcher(worker(new Error("did not finish in 180 s")), {}, report).start(paseo, "auth", { vendor: "jira", ref: "PROJ-1" }, undefined, "a1");
  await settle();
  expect(sent[0][1]).toMatchObject({ status: "failed", error: "did not finish in 180 s", chars: 0 });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const broken: ReportResult = async () => {
    throw new Error("Unknown agent a2");
  };
  await fetcher(worker('{"found":true,"title":"t","url":null,"text":"x"}'), {}, broken).start(paseo, "auth", { vendor: "jira", ref: "PROJ-2" }, undefined, "a2");
  await settle();
  expect((await store.read()).auth.notes.find((note) => note.ref === "PROJ-2")?.status).toBe("ready");
  expect(logged.mock.calls.some(([line]) => String(line).includes("Unknown agent a2"))).toBe(true);
  logged.mockRestore();
});

test("a result row loads the agent first and has one id per item, so a later result replaces it", async () => {
  const calls: unknown[] = [];
  const fake = {
    agents: {
      ref: (agentId: string) => ({
        timeline: {
          refetch: async (request: unknown) => (calls.push(["read", agentId, request]), { entries: [], hasOlder: false, startCursor: null, error: null }),
          append: async (item: unknown) => (calls.push(["append", agentId, item]), { seq: 1, epoch: "e" }),
        },
      }),
    },
  } as unknown as PaseoApi;
  const result: FetchResult = { tag: "auth", noteId: "n1", vendor: "jira", ref: "PROJ-1", title: "t", status: "ready", error: null, chars: 1 };
  await postFetchResult(fake, "a1", result);
  expect(calls).toEqual([
    ["read", "a1", { direction: "tail", limit: 1, projection: "projected" }],
    ["append", "a1", { type: "plugin", id: "fetch-n1", kind: FETCH_RESULT_KIND, version: 1, data: result }],
  ]);
});

test("only ready items older than the setting's hours are refreshed automatically, and nothing while it is off", async () => {
  const { sent, report } = reports();
  const refetched: string[] = [];
  const run: RunWorker = async (_p, _r, job, onCreated) => {
    refetched.push(job.title);
    onCreated(job.title);
    return '{"found":true,"title":"t","url":null,"text":"x"}';
  };
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  for (const [ref, status, fetchedAt] of [["OLD-1", "ready", hoursAgo(25)], ["NEW-1", "ready", hoursAgo(1)], ["BAD-1", "failed", hoursAgo(48)]] as const) {
    const { noteId } = await store.addNote("auth", { vendor: "jira", ref });
    await store.updateNote("auth", noteId, { status, fetchedAt, notifyAgentId: "a1" });
  }
  expect(await fetcher(run, {}, report).refreshStale(paseo)).toBe(0);
  expect(await fetcher(run, { autoRefreshItems: true, autoRefreshHours: 24 }, report).refreshStale(paseo)).toBe(1);
  await settle();
  expect(refetched).toEqual(["contextualise: fetch jira OLD-1"]);
  expect(sent).toEqual([]);
});
