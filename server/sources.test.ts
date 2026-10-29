import { expect, test, vi } from "vitest";
import { DOCS_URL, snapshotSettingsSchema, type TagSummary } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import { timeAgo } from "../shared/time";
import { tokenEstimate } from "../shared/tokens";
import { cleanTitle } from "./rows";
import { agentLink, includedParts, Memo, readAgent, rowPrefix, searchAgents, searchTags, searchTerminals } from "./sources";
import { shortenLink } from "../shared/links";
import type { Directory } from "./tags";

const options = snapshotSettingsSchema.parse({ snapshotMaxChars: 40_000, turnsPerAgent: 2, terminalLines: 50, showTokenEstimates: false });
const entry = (type: string, text: string) => ({ item: { type, text } });
const NO_PINS: ReadonlySet<string> = new Set();

interface FakePage {
  entries: ReturnType<typeof entry>[];
  hasOlder: boolean;
  startCursor: { epoch: string; seq: number } | null;
  error: string | null;
}

// A Paseo API that knows only what these tests read: timelines, terminals, and captures.
function fakePaseo(timelines: Record<string, FakePage[] | Error>, terminals: { id: string; workspaceId: string; cwd: string; name: string }[] = []) {
  const refetch = vi.fn();
  const capture = vi.fn(async (_options: unknown) => ({ terminalId: "t1", lines: ["$ npm test", "ok 12 tests"], totalLines: 940, requestId: "r" }));
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        timeline: {
          refetch: async (request: { direction: string }) => {
            refetch(agentId, request.direction);
            const pages = timelines[agentId];
            if (pages instanceof Error) throw pages;
            return pages.shift();
          },
        },
      }),
    },
    terminals: { list: async () => ({ entries: terminals, requestId: "r" }), ref: () => ({ capture }) },
  } as unknown as PaseoApi;
  return { paseo, refetch, capture };
}

function tag(key: string, agentIds: string[]): TagSummary {
  return {
    key,
    name: key,
    hasWorkspaceLabel: false,
    workspaces: [],
    links: [],
    notes: [],
    agents: agentIds.map((agentId) => ({ agentId, workspaceId: "w1", taggedAt: "t", title: agentId, provider: "claude", workspaceName: null, state: "active" as const })),
  };
}

const directory: Directory = {
  workspaces: [{ id: "w1", name: "api", projectDisplayName: "payments", projectRootPath: "/src/payments" }],
  agents: [
    { id: "old", title: "Fix login", provider: "claude", workspaceId: "w1", updatedAt: "2026-10-01", archivedAt: "2026-10-02" },
    { id: "new", title: "Fix logout", provider: "codex", workspaceId: "w1", updatedAt: "2026-10-20" },
    { id: "other", title: "Billing", provider: "claude", workspaceId: "w1", updatedAt: "2026-10-25" },
  ],
};

test("readAgent pages back until it has more user messages than it needs", async () => {
  const { paseo, refetch } = fakePaseo({
    a1: [
      { entries: [entry("user_message", "q3"), entry("assistant_message", "a3")], hasOlder: true, startCursor: { epoch: "e", seq: 5 }, error: null },
      { entries: [entry("user_message", "q2"), entry("assistant_message", "a2")], hasOlder: true, startCursor: { epoch: "e", seq: 3 }, error: null },
      { entries: [entry("user_message", "q1"), entry("assistant_message", "a1")], hasOlder: true, startCursor: { epoch: "e", seq: 1 }, error: null },
    ],
  });
  const reading = await readAgent(paseo, "a1", 2);
  expect(refetch.mock.calls.map(([, direction]) => direction)).toEqual(["tail", "before", "before"]);
  expect(reading).toEqual({ agentId: "a1", turns: [{ user: "q2", replies: ["a2"] }, { user: "q3", replies: ["a3"] }], earlier: 1, olderUnread: true });
});

test("readAgent turns a failed read into a reason instead of throwing", async () => {
  const { paseo } = fakePaseo({ thrown: new Error("socket closed"), reported: [{ entries: [], hasOlder: false, startCursor: null, error: "session not found" }] });
  expect(await readAgent(paseo, "thrown", 2)).toEqual({ agentId: "thrown", error: "socket closed" });
  expect(await readAgent(paseo, "reported", 2)).toEqual({ agentId: "reported", error: "session not found" });
});

test("a broken agent does not stop the other tags or its own tag from attaching", async () => {
  const { paseo } = fakePaseo({
    good: [{ entries: [entry("user_message", "hello")], hasOlder: false, startCursor: null, error: null }],
    broken: new Error("socket closed"),
  });
  const items = await searchTags(paseo, new Memo(30_000), [tag("auth", ["good", "broken"]), tag("billing", ["good"])], "", options);
  expect(items.map((item) => [item.identifier, item.title, item.subtitle])).toEqual([
    ["", "auth", "2 agents: claude; 1 unreadable"],
    ["", "billing", "1 agent: claude"],
  ]);
  expect(items[0].text).toContain("(conversation could not be read: socket closed)");
  expect(items[0].url).toBe(DOCS_URL);
});

test("agent search matches every word, puts archived agents last, and links to the agent", async () => {
  const page = () => [{ entries: [entry("user_message", "hi")], hasOlder: false, startCursor: null, error: null }];
  const { paseo } = fakePaseo({ old: page(), new: page(), other: page() });
  const items = await searchAgents(paseo, new Memo(30_000), directory, NO_PINS, "srv_1", "fix log", options);
  expect(items.map((item) => item.id)).toEqual(["new", "old"]);
  expect(items[0]).toMatchObject({ identifier: "", title: "Fix logout", url: agentLink("srv_1", "new"), resourceType: "agent" });
  expect(items[0].subtitle).toMatch(/^\d+ d ago · payments \/ api$/);
  expect(items[1].subtitle).toMatch(/^\d+ d ago · payments \/ api · archived$/);
  expect(items[0].text).toContain("**User:** hi");
  expect((await searchAgents(paseo, new Memo(30_000), directory, NO_PINS, "srv_1", "payments", options)).map((item) => item.id)).toEqual(["other", "new", "old"]);
});

test("agent links use Paseo's own agent link shape", () => {
  expect(agentLink("srv 1", "a/b")).toBe("paseo://h/srv%201/agent/a%2Fb");
});

test("terminal search captures the newest lines from the setting and says how long the output is", async () => {
  const { paseo, capture } = fakePaseo({}, [
    { id: "t1", workspaceId: "w1", cwd: "/src/payments", name: "tests" },
    { id: "t2", workspaceId: "w1", cwd: "/src/payments", name: "dev server" },
  ]);
  const items = await searchTerminals(paseo, new Memo(30_000), directory, "test", options);
  expect(items).toHaveLength(1);
  expect(capture).toHaveBeenCalledWith({ start: -50, stripAnsi: true });
  expect(items[0]).toMatchObject({ identifier: "", title: "tests", subtitle: "payments / api · 940 lines", resourceType: "terminal" });
  expect(items[0].text).toContain("ok 12 tests");
});

test("Memo reuses a result within its window and forgets failures", async () => {
  const memo = new Memo(30_000);
  const build = vi.fn(async () => "value");
  await memo.get("k", build);
  await memo.get("k", build);
  expect(build).toHaveBeenCalledTimes(1);
  const failing = vi.fn(async () => {
    throw new Error("nope");
  });
  await expect(memo.get("f", failing)).rejects.toThrow("nope");
  await expect(memo.get("f", failing)).rejects.toThrow("nope");
  expect(failing).toHaveBeenCalledTimes(2);
});

test("switched-off parts of a tag are left out of both the subtitle and the text", async () => {
  const full = { ...tag("auth", ["good"]), links: [{ url: "https://e.com/", title: "Spec", taggedAt: "t" }] };
  const { paseo, refetch } = fakePaseo({ good: [{ entries: [entry("user_message", "hello")], hasOlder: false, startCursor: null, error: null }] });
  const noAgents = snapshotSettingsSchema.parse({ includeAgents: false, showTokenEstimates: false });
  expect(includedParts(full, noAgents).agents).toEqual([]);
  const [item] = await searchTags(paseo, new Memo(30_000), [full], "", noAgents);
  expect(item.subtitle).toBe("1 link");
  expect(item.text).not.toContain("hello");
  expect(refetch).not.toHaveBeenCalled();
  const [noLinks] = await searchTags(paseo, new Memo(30_000), [full], "", snapshotSettingsSchema.parse({ includeLinks: false }));
  expect(noLinks.text).not.toContain("## Links");
});

test("each source returns as many results as the setting allows, so the picker can scroll", async () => {
  const many = { workspaces: directory.workspaces, agents: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, title: `Agent ${i}`, provider: "claude", workspaceId: "w1", updatedAt: `2026-10-${String(i + 1).padStart(2, "0")}` })) };
  const page = () => [{ entries: [entry("user_message", "hi")], hasOlder: false, startCursor: null, error: null }];
  const { paseo } = fakePaseo(Object.fromEntries(many.agents.map((agent) => [agent.id, page()])));
  expect(await searchAgents(paseo, new Memo(30_000), many, NO_PINS, "srv", "", options)).toHaveLength(20);
  expect(await searchAgents(paseo, new Memo(30_000), many, NO_PINS, "srv", "", snapshotSettingsSchema.parse({ resultsPerSearch: 25 }))).toHaveLength(25);
  const tags = Array.from({ length: 12 }, (_, i) => tag(`t${i}`, []));
  expect(await searchTags(paseo, new Memo(30_000), tags, "", options)).toHaveLength(12);
  expect(await searchTags(paseo, new Memo(30_000), tags, "", snapshotSettingsSchema.parse({ resultsPerSearch: 5 }))).toHaveLength(5);
});

test("agent titles lose Markdown marks and extra spaces, so the picker shows more of them", () => {
  expect(cleanTitle("verify this - **Ticket, your call:** Shopline   produ `x`", true)).toBe("verify this - Ticket, your call: Shopline produ x");
  expect(cleanTitle("  ## Plan __things__  ", true)).toBe("Plan things");
  expect(cleanTitle("   ", true)).toBe("");
  expect(cleanTitle("scan https://acme.atlassian.net/browse/PROJ-5896 now", true)).toBe("scan acme.atlassian.net/browse/PROJ-5896 now");
  expect(cleanTitle("scan https://acme.atlassian.net/browse/PROJ-5896 now", false)).toBe("scan https://acme.atlassian.net/browse/PROJ-5896 now");
});

test("times read as short relative phrases", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  expect(timeAgo("2026-10-27T11:59:40Z", now)).toBe("just now");
  expect(timeAgo("2026-10-27T11:55:00Z", now)).toBe("5 min ago");
  expect(timeAgo("2026-10-27T09:00:00Z", now)).toBe("3 h ago");
  expect(timeAgo("2026-10-20T12:00:00Z", now)).toBe("7 d ago");
  expect(timeAgo("not a date", now)).toBe("");
});

test("a running agent says so in its picker row", async () => {
  const page = () => [{ entries: [entry("user_message", "hi")], hasOlder: false, startCursor: null, error: null }];
  const { paseo } = fakePaseo({ r: page() });
  const running = { workspaces: directory.workspaces, agents: [{ id: "r", title: "**Live** task", provider: "claude", workspaceId: "w1", status: "running", updatedAt: new Date().toISOString() }] };
  const [item] = await searchAgents(paseo, new Memo(30_000), running, NO_PINS, "srv", "", options);
  expect(item.title).toBe("Live task");
  expect(item.subtitle).toBe("just now · payments / api · running");
});

test("an agent in a titled worktree shows the worktree's title, then time and git, and is found by branch and pull request", async () => {
  const page = () => [{ entries: [entry("user_message", "hi")], hasOlder: false, startCursor: null, error: null }];
  const { paseo } = fakePaseo({ t: page() });
  const worktree = {
    workspaces: [{ id: "w2", name: "glorious-tiger", title: "Review PR 5854", projectDisplayName: "payments", projectRootPath: "/src/payments", workspaceKind: "worktree", worktreeSlug: "glorious-tiger", gitRuntime: { currentBranch: "review-5854", isDirty: true }, diffStat: { additions: 12, deletions: 3 }, githubRuntime: { pullRequest: { number: 5854, state: "open", isDraft: false, title: "Fix refresh tokens" } } }],
    agents: [{ id: "t", title: "scan https://github.com/acme/api/pull/5854 and review it", provider: "claude", workspaceId: "w2", updatedAt: new Date().toISOString() }],
  };
  const [item] = await searchAgents(paseo, new Memo(30_000), worktree, NO_PINS, "srv", "", options);
  expect(item.title).toBe("Review PR 5854");
  expect(item.subtitle).toBe("just now · review-5854 · +12 −3 · PR #5854");
  for (const query of ["5854", "review-5854", "refresh tokens", "glorious"]) expect(await searchAgents(paseo, new Memo(30_000), worktree, NO_PINS, "srv", query, options), query).toHaveLength(1);
  const quiet = await searchAgents(fakePaseo({ t: page() }).paseo, new Memo(30_000), worktree, NO_PINS, "srv", "", snapshotSettingsSchema.parse({ showTokenEstimates: false, agentShowGit: false }));
  expect(quiet[0].subtitle).toBe("just now");
});

test("long links shrink to host and the last two path parts; short ones only lose the scheme", () => {
  expect(shortenLink("https://app.notion.com/p/acme/Backend-architecture-review-0123456789abcdef")).toBe("app.notion.com/…/acme/Backend-architecture-review-0123456789abcdef");
  expect(shortenLink("https://github.com/acme/tasks-service-v2/pull/12?x=1")).toBe("github.com/acme/tasks-service-v2/pull/12");
  expect(shortenLink("https://github.com/acme/tasks-service-v2-service/pull/1234/files")).toBe("github.com/…/1234/files");
  expect(shortenLink("https://www.example.com/a")).toBe("example.com/a");
  expect(shortenLink("https://acme.sentry.io/issues/123/")).toBe("acme.sentry.io/issues/123");
});

test("row prefixes: none by default (rows start with the title), or words", () => {
  expect(rowPrefix("agent", "claude", "none")).toBe("");
  expect(rowPrefix("tag", undefined, "none")).toBe("");
  expect(rowPrefix("agent", "codex/gpt-6", "word")).toBe("Codex");
  expect(rowPrefix("agent", "claude", "word")).toBe("Claude");
  expect(rowPrefix("tag", undefined, "word")).toBe("Tag");
  expect(rowPrefix("terminal", undefined, "word")).toBe("Terminal");
  expect(rowPrefix("agent", "claude", "none")).toBe("");
});

test("agent rows follow the settings: subtitle parts, archived agents, and sort", async () => {
  const page = () => [{ entries: [entry("user_message", "hi")], hasOlder: false, startCursor: null, error: null }];
  // A fresh fake per search: each fake timeline page is used up once read.
  const run = (settings: Record<string, unknown>) => searchAgents(fakePaseo({ old: page(), new: page(), other: page() }).paseo, new Memo(30_000), directory, NO_PINS, "srv", "", snapshotSettingsSchema.parse({ showTokenEstimates: false, ...settings }));
  expect((await run({ includeArchivedAgents: false })).map((item) => item.id)).toEqual(["other", "new"]);
  // Archived agents stay last whatever the sort.
  expect((await run({ agentSort: "title" })).map((item) => item.title)).toEqual(["Billing", "Fix logout", "Fix login"]);
  expect((await run({ agentShowWorkspace: false, agentShowActivity: false })).map((item) => item.subtitle)).toEqual(["", "", "archived"]);
  expect((await run({ agentShowStatus: false, agentShowActivity: false }))[2].subtitle).toBe("payments / api");
  expect((await run({ pickerPrefix: "word" }))[0].identifier).toBe("Claude");
});

test("pinned agents come first, say so, and stay listed when archived", async () => {
  const page = () => [{ entries: [entry("user_message", "hi")], hasOlder: false, startCursor: null, error: null }];
  const run = (pins: string[], settings: Record<string, unknown> = {}) => searchAgents(fakePaseo({ old: page(), new: page(), other: page() }).paseo, new Memo(30_000), directory, new Set(pins), "srv", "", snapshotSettingsSchema.parse({ showTokenEstimates: false, agentShowActivity: false, ...settings }));
  const pinned = await run(["new"]);
  expect(pinned.map((item) => item.id)).toEqual(["new", "other", "old"]);
  expect(pinned[0].subtitle).toBe("pinned · payments / api");
  expect(pinned[1].subtitle).toBe("payments / api");
  // An archived agent M pinned is kept even when archived agents are hidden, and still comes first.
  expect((await run(["old"], { includeArchivedAgents: false })).map((item) => item.id)).toEqual(["old", "other", "new"]);
  // A pin for an agent Paseo no longer has changes nothing in the list.
  expect((await run(["gone"])).map((item) => item.id)).toEqual(["other", "new", "old"]);
});

test("rows end with a token estimate while the setting is on", async () => {
  const page = () => [{ entries: [entry("user_message", "x".repeat(4_000))], hasOlder: false, startCursor: null, error: null }];
  const on = snapshotSettingsSchema.parse({ agentShowActivity: false });
  const [agent] = await searchAgents(fakePaseo({ other: page() }).paseo, new Memo(30_000), { workspaces: directory.workspaces, agents: [directory.agents[2]] }, NO_PINS, "srv", "", on);
  expect(agent.subtitle).toBe(`payments / api · ${tokenEstimate(agent.text.length)}`);
  expect(agent.subtitle).toMatch(/~1k tokens$/);
  const [tagItem] = await searchTags(fakePaseo({ good: page() }).paseo, new Memo(30_000), [tag("auth", ["good"])], "", on);
  expect(tagItem.subtitle).toBe(`1 agent: claude · ${tokenEstimate(tagItem.text.length)}`);
  const terminals = fakePaseo({}, [{ id: "t1", workspaceId: "w1", cwd: "/src", name: "tests" }]).paseo;
  const [terminal] = await searchTerminals(terminals, new Memo(30_000), directory, "", on);
  expect(terminal.subtitle).toBe(`payments / api · 940 lines · ${tokenEstimate(terminal.text.length)}`);
});

test("token estimates read as short approximate counts", () => {
  expect(tokenEstimate(0)).toBe("~0 tokens");
  expect(tokenEstimate(3_400)).toBe("~850 tokens");
  expect(tokenEstimate(4_000)).toBe("~1k tokens");
  expect(tokenEstimate(4_800)).toBe("~1.2k tokens");
  expect(tokenEstimate(48_000)).toBe("~12k tokens");
});

test("a workspace whose name is its project's name is shown once", async () => {
  const page = () => [{ entries: [entry("user_message", "hi")], hasOlder: false, startCursor: null, error: null }];
  const folder = { workspaces: [{ id: "w1", name: "checkout-web", projectDisplayName: "checkout-web", projectRootPath: "/src/checkout-web" }], agents: [{ id: "a", title: "Fix", provider: "claude", workspaceId: "w1" }] };
  const [item] = await searchAgents(fakePaseo({ a: page() }).paseo, new Memo(30_000), folder, NO_PINS, "srv", "", snapshotSettingsSchema.parse({ showTokenEstimates: false, agentShowActivity: false }));
  expect(item.subtitle).toBe("checkout-web");
});
