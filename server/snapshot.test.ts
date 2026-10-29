import { expect, test } from "vitest";
import type { AgentMember, TagSummary } from "../shared/contracts";
import type { AgentTimelineItem } from "./paseo-types";
import { describeMembers, lastTurns, matchTags, renderConversation, renderSnapshot, renderTerminal, SNAPSHOT_HEADER } from "./snapshot";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const reply = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const tool = () => ({ type: "tool_call", name: "shell", status: "completed" }) as unknown as AgentTimelineItem;
const thinking = () => ({ type: "reasoning", text: "secret plan" }) as AgentTimelineItem;

function agent(overrides: Partial<AgentMember>): AgentMember {
  return { agentId: "a1", workspaceId: "w1", taggedAt: "2026-10-27T10:00:00Z", title: "Fix login", provider: "claude", workspaceName: null, state: "active", ...overrides };
}

function tag(overrides: Partial<TagSummary> = {}): TagSummary {
  return { key: "auth rewrite", name: "Auth Rewrite", hasWorkspaceLabel: true, workspaces: [], agents: [], links: [], notes: [], ...overrides };
}

test("lastTurns keeps user and agent text only, newest turns, and counts the dropped ones", () => {
  const items = [user("one"), reply("r1"), tool(), user("two"), thinking(), reply("r2"), user("three"), reply("r3a"), tool(), reply("r3b")];
  const { turns, earlier } = lastTurns(items, 2);
  expect(earlier).toBe(1);
  expect(turns).toEqual([
    { user: "two", replies: ["r2"] },
    { user: "three", replies: ["r3a", "r3b"] },
  ]);
});

test("replies before the first user message form their own turn", () => {
  expect(lastTurns([reply("hello"), user("hi")], 5).turns).toEqual([
    { user: null, replies: ["hello"] },
    { user: "hi", replies: [] },
  ]);
});

test("the snapshot labels itself as reference and names every agent's provider", () => {
  const text = renderSnapshot(
    tag({
      workspaces: [{ workspaceId: "w2", name: "api", projectName: "payments", directory: "/src/payments" }],
      agents: [agent({}), agent({ agentId: "a2", title: "Refactor", provider: "codex", state: "archived" })],
    }),
    [
      { agentId: "a1", turns: [{ user: "why does login fail", replies: ["the cookie expired"] }], earlier: 0 },
      { agentId: "a2", turns: [{ user: "split the module", replies: ["done"] }], earlier: 3, olderUnread: true },
    ],
    40_000,
  );
  expect(text).toContain(SNAPSHOT_HEADER);
  expect(text).toContain("Fix login (claude");
  expect(text).toContain("Refactor (codex, archived");
  expect(text).toContain("payments / api");
  expect(text).toContain("why does login fail");
  expect(text).toContain("(3+ earlier turns not included)");
  expect(text).not.toMatch(/Fix login[^#]*earlier turns/);
});

test("missing agents are listed without a conversation", () => {
  const text = renderSnapshot(tag({ agents: [agent({ state: "missing", title: null, provider: null })] }), [], 40_000);
  expect(text).toContain("a1 (missing: Paseo no longer has this agent)");
});

test("a long tag stays within the budget, keeps the newest turns, and says what it cut", () => {
  const long = "x".repeat(3_000);
  const turns = Array.from({ length: 30 }, (_, i) => ({ user: `question ${i}`, replies: [long] }));
  const budget = 10_000;
  const text = renderSnapshot(
    tag({ agents: [agent({}), agent({ agentId: "a2", provider: "codex" })] }),
    [
      { agentId: "a1", turns, earlier: 0 },
      { agentId: "a2", turns, earlier: 0 },
    ],
    budget,
  );
  expect(text.length).toBeLessThanOrEqual(budget);
  expect(text).toContain("question 29");
  expect(text).not.toContain("question 0\n");
  expect(text).toMatch(/\(\d+ earlier turns not included\)/);
  // Both agents get a share; the first does not starve the second.
  expect(text.match(/question 29/g)).toHaveLength(2);
});

test("one reply longer than the whole budget is clipped, not dropped", () => {
  const text = renderSnapshot(tag({ agents: [agent({})] }), [{ agentId: "a1", turns: [{ user: "q", replies: ["y".repeat(50_000)] }], earlier: 0 }], 2_000);
  expect(text.length).toBeLessThanOrEqual(2_000);
  expect(text).toContain("yyy");
  expect(text).toContain("[…]");
});

test("the picker subtitle counts members and names providers", () => {
  expect(
    describeMembers(
      tag({
        workspaces: [{ workspaceId: "w", name: "api", projectName: "p", directory: "/p" }],
        agents: [agent({}), agent({ agentId: "a2", provider: "codex" }), agent({ agentId: "a3", provider: "claude" })],
      }),
    ),
  ).toBe("3 agents: claude, codex; 1 workspace");
  expect(describeMembers(tag({ agents: [agent({})] }))).toBe("1 agent: claude");
  expect(describeMembers(tag({ agents: [agent({ state: "missing", provider: null })] }))).toBe("1 agent: unknown provider");
});

test("matchTags ranks prefix matches before substring matches and lists every match", () => {
  const tags = ["billing auth", "auth rewrite", "auth", "a", "b", "c", "d", "e"].map((name) => tag({ key: name, name }));
  expect(matchTags(tags, "AUTH").map((t) => t.key)).toEqual(["auth rewrite", "auth", "billing auth"]);
  expect(matchTags(tags, "  ")).toHaveLength(8);
});

test("secrets in conversations are replaced before the budget is applied", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
  const text = renderSnapshot(tag({ agents: [agent({})] }), [{ agentId: "a1", turns: [{ user: `use ${token}`, replies: ["password = hunter2hunter2"] }], earlier: 0 }], 40_000);
  expect(text).not.toContain(token);
  expect(text).not.toContain("hunter2hunter2");
  expect(text).toContain("[removed: GitHub token]");
  expect(text).toContain("[removed: password or key assignment]");
});

test("an unreadable agent is shown with its reason while the others still attach", () => {
  const text = renderSnapshot(
    tag({ agents: [agent({}), agent({ agentId: "a2", title: "Broken" })] }),
    [
      { agentId: "a1", turns: [{ user: "hello", replies: ["hi"] }], earlier: 0 },
      { agentId: "a2", error: "session not found" },
    ],
    40_000,
  );
  expect(text).toContain("**User:** hello");
  expect(text).toContain("### Broken (claude, agent a2)\n\n(conversation could not be read: session not found)");
  expect(describeMembers(tag({ agents: [agent({})] }), 1)).toBe("1 agent: claude; 1 unreadable");
});

test("links are listed and counted", () => {
  const withLinks = tag({ links: [{ url: "https://example.com/spec", title: "Spec", taggedAt: "t" }] });
  expect(renderSnapshot(withLinks, [], 40_000)).toContain("## Links\n\n- [Spec](https://example.com/spec)");
  expect(describeMembers(withLinks)).toBe("1 link");
});

test("one agent's conversation has its own heading, workspace, and budget", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ user: `q${i}`, replies: ["a".repeat(500)] }));
  const text = renderConversation(agent({ provider: "codex" }), "payments / api", { agentId: "a1", turns, earlier: 0 }, 2_000);
  expect(text.startsWith("# Fix login (codex, agent a1)")).toBe(true);
  expect(text).toContain("Workspace: payments / api");
  expect(text).toContain("q9");
  expect(text.length).toBeLessThanOrEqual(2_000);
});

test("terminal output keeps the newest lines that fit, redacted, and says how many were cut", () => {
  const lines = [...Array.from({ length: 300 }, (_, i) => `line-${i}`), "AWS=AKIAABCDEFGHIJKLMNOP", ""];
  const text = renderTerminal({ name: "dev server", cwd: "/src/api" }, "payments / api", lines, 900, 1_500);
  expect(text.startsWith("# Terminal: dev server in payments / api")).toBe(true);
  expect(text).toContain("line-299");
  expect(text).not.toContain("line-0\n");
  expect(text).toContain("[removed: AWS access key]");
  expect(text).toMatch(/\(last \d+ of 900 lines\)/);
  expect(text.length).toBeLessThanOrEqual(1_500);
  expect(text.trimEnd().endsWith("```")).toBe(true);
});

test("fetched items are listed with their source, redacted, and counted; pending and failed ones say so", () => {
  const note = (over: Record<string, unknown>) => ({ id: "n", vendor: "jira" as const, ref: "PROJ-1", title: "PROJ-1", url: null, status: "ready" as const, text: "", error: null, addedAt: "t", fetchedAt: "2026-10-27T10:00:00Z", provider: "claude" as const, notifyAgentId: null, ...over });
  const withNotes = tag({
    notes: [
      note({ title: "Login fails", url: "https://acme.atlassian.net/browse/PROJ-1", text: "Token: xoxb-1234567890-abcdefghij" }),
      note({ id: "n2", vendor: "slack", ref: "https://a.slack.com/archives/C1/p1", status: "fetching" }),
      note({ id: "n3", vendor: "sentry", ref: "https://acme.sentry.io/issues/9/", status: "failed", error: "no access" }),
    ],
  });
  const text = renderSnapshot(withNotes, [], 40_000);
  expect(text).toContain("## Fetched items");
  expect(text).toContain("### Login fails (Jira PROJ-1 (https://acme.atlassian.net/browse/PROJ-1), fetched 2026-10-27)");
  expect(text).toContain("[removed: Slack token]");
  expect(text).toContain("(still being fetched)");
  expect(text).toContain("(fetch failed: no access)");
  expect(describeMembers(withNotes)).toBe("3 items");
});
