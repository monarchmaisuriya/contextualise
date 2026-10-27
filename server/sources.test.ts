import { expect, test, vi } from "vitest";
import { DOCS_URL, snapshotSettingsSchema, type TagSummary } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import { agentLink, includedParts, Memo, readAgent, searchAgents, searchTags, searchTerminals } from "./sources";
import type { Directory } from "./tags";

const options = snapshotSettingsSchema.parse({ snapshotMaxChars: 40_000, turnsPerAgent: 2, terminalLines: 50 });
const entry = (type: string, text: string) => ({ item: { type, text } });

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
    agents: agentIds.map((agentId) => ({ agentId, workspaceId: "w1", taggedAt: "t", title: agentId, provider: "claude", state: "active" as const })),
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
    ["Tag", "auth", "2 agents: claude; 1 unreadable"],
    ["Tag", "billing", "1 agent: claude"],
  ]);
  expect(items[0].text).toContain("(conversation could not be read: socket closed)");
  expect(items[0].url).toBe(DOCS_URL);
});

test("agent search matches every word, puts archived agents last, and links to the agent", async () => {
  const page = () => [{ entries: [entry("user_message", "hi")], hasOlder: false, startCursor: null, error: null }];
  const { paseo } = fakePaseo({ old: page(), new: page(), other: page() });
  const items = await searchAgents(paseo, new Memo(30_000), directory, "srv_1", "fix log", options);
  expect(items.map((item) => item.id)).toEqual(["new", "old"]);
  expect(items[0]).toMatchObject({ identifier: "Agent", title: "Fix logout", subtitle: "codex · payments / api", url: agentLink("srv_1", "new"), resourceType: "agent" });
  expect(items[1].subtitle).toBe("claude · payments / api · archived");
  expect(items[0].text).toContain("**User:** hi");
  expect((await searchAgents(paseo, new Memo(30_000), directory, "srv_1", "payments", options)).map((item) => item.id)).toEqual(["other", "new", "old"]);
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
  expect(items[0]).toMatchObject({ identifier: "Terminal", title: "tests", subtitle: "payments / api · 940 lines", resourceType: "terminal" });
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
  const noAgents = snapshotSettingsSchema.parse({ includeAgents: false });
  expect(includedParts(full, noAgents).agents).toEqual([]);
  const [item] = await searchTags(paseo, new Memo(30_000), [full], "", noAgents);
  expect(item.subtitle).toBe("1 link");
  expect(item.text).not.toContain("hello");
  expect(refetch).not.toHaveBeenCalled();
  const [noLinks] = await searchTags(paseo, new Memo(30_000), [full], "", snapshotSettingsSchema.parse({ includeLinks: false }));
  expect(noLinks.text).not.toContain("## Links");
});
