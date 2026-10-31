import { expect, test } from "vitest";
import { errorText } from "../client/errors";
import * as contracts from "./contracts";
import { parseLinkCommand, parseLinkUrl, parseTagNames, snapshotSettingsSchema } from "./contracts";

test("several tags split on commas, collapse duplicates, and refuse empty or too many", () => {
  expect(parseTagNames(" Auth ,billing, auth,  ")).toEqual(["Auth", "billing"]);
  expect(() => parseTagNames(" , ")).toThrow("A tag needs a name");
  expect(() => parseTagNames(Array.from({ length: 11 }, (_, i) => `t${i}`).join(","))).toThrow("at most 10 tags");
});

test("links accept web addresses only", () => {
  expect(parseLinkUrl(" https://example.com/a?b=1#c ")).toBe("https://example.com/a?b=1#c");
  expect(parseLinkUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "example.com", "https://", "https://exa mple.com", "https://exa^mple.com", "https://a.b:99999", "https://a.b:1:2", "https://[x.y"]) expect(() => parseLinkUrl(bad), bad).toThrow();
  // Whatever the check lets through, the URL class can parse.
  for (const good of ["https://example.com/a?b=1#c", "http://localhost:3000/x", "https://sub.example-site.co.uk:8443/p", "http://10.0.0.1/x", "https://bücher.de/x"]) expect(() => new URL(parseLinkUrl(good)), good).not.toThrow();
});

test("/tag-link takes the URL first and the rest as the tag", () => {
  expect(parseLinkCommand("https://example.com/spec  Auth   Rewrite")).toEqual({ url: "https://example.com/spec", tag: "Auth Rewrite" });
  expect(() => parseLinkCommand("https://example.com/spec")).toThrow("A tag needs a name");
  expect(() => parseLinkCommand("auth https://example.com")).toThrow("web address");
});

test("settings: 0 means the default, out-of-range values are invalid", () => {
  expect(snapshotSettingsSchema.parse({ terminalLines: 0 })).toMatchObject({ snapshotMaxChars: 40_000, turnsPerAgent: 6, terminalLines: 200, fetchProvider: "auto", maxConcurrentFetches: 2, commentsPerItem: 10, customRoutes: [] });
  expect(snapshotSettingsSchema.parse({ commentsPerItem: 0 }).commentsPerItem).toBe(0);
  // A setting removed in 0.16.0 is dropped from stored values instead of making them invalid.
  expect(snapshotSettingsSchema.parse({ resultsPerSearch: 20 })).not.toHaveProperty("resultsPerSearch");
  expect(snapshotSettingsSchema.parse({})).toMatchObject({ pickerPrefix: "none", shortenLinks: true, agentShowWorkspace: true, agentShowStatus: true, agentShowActivity: true, includeArchivedAgents: false, agentSort: "recent", pillNameMaxChars: 24 });
  expect(snapshotSettingsSchema.safeParse({ pillNameMaxChars: 9 }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ pickerPrefix: "icon" }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ fetchTimeoutSeconds: 5 }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ fetchProvider: "opencode" }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ customRoutes: [{ vendor: "jira", provider: "codex", server: "my-jira", tools: ["get_issue"] }] }).success).toBe(true);
  expect(snapshotSettingsSchema.safeParse({ customRoutes: [{ vendor: "jira", provider: "opencode", server: "x", tools: ["y"] }] }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ customRoutes: [{ vendor: "jira", provider: "codex", server: "x y", tools: ["y"] }] }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ customRoutes: [{ vendor: "jira", provider: "codex", server: "x", tools: [] }] }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ terminalLines: 9 }).success).toBe(false);
  expect(snapshotSettingsSchema.safeParse({ snapshotMaxChars: -1 }).success).toBe(false);
});

test("error toasts show the plugin's message without transport noise", () => {
  expect(errorText(new Error("Request failed: Contextualise settings are invalid (x). requestType=plugin.rpc.invoke.request code=handler_error"))).toBe("Contextualise settings are invalid (x).");
  expect(errorText(new Error('Request failed: [{"code":"custom","message":"A tag needs a name","path":["tags",0]}] requestType=plugin.rpc.invoke.request code=handler_error'))).toBe("A tag needs a name");
  expect(errorText("plain")).toBe("plain");
  expect(errorText(new Error("Request failed: Saved, but the confirmation row could not be added: Request failed: Unknown agent 'a1' requestType=agent.timeline.append.request code=handler_error requestType=plugin.rpc.invoke.request code=handler_error"))).toBe(
    "Saved, but the confirmation row could not be added: Unknown agent 'a1'",
  );
});

test("item references pick their vendor from shape, or from an explicit prefix", () => {
  const { parseItemRef, parseFetchCommand } = contracts;
  expect(parseItemRef("PROJ-123")).toEqual({ vendor: "jira", ref: "PROJ-123" });
  expect(parseItemRef("https://acme.atlassian.net/browse/PROJ-9")).toEqual({ vendor: "jira", ref: "https://acme.atlassian.net/browse/PROJ-9" });
  expect(parseItemRef("https://acme.sentry.io/issues/42/").vendor).toBe("sentry");
  expect(parseItemRef("https://acme.slack.com/archives/C01/p1700000000000100").vendor).toBe("slack");
  expect(parseItemRef("https://www.notion.so/acme/Spec-0123456789abcdef").vendor).toBe("notion");
  expect(parseItemRef("https://acme.notion.site/Spec").vendor).toBe("notion");
  expect(parseItemRef("slack: incident thread from yesterday")).toEqual({ vendor: "slack", ref: "incident thread from yesterday" });
  for (const bad of ["", "proj-123", "https://example.com/x", "http://acme.atlassian.net/browse/P-1", "https://evil.com/.atlassian.net"]) expect(() => parseItemRef(bad), bad).toThrow();
  expect(parseFetchCommand("PROJ-1  Auth   Rewrite")).toEqual({ ref: "PROJ-1", tag: "Auth Rewrite" });
  expect(() => parseFetchCommand("PROJ-1")).toThrow("A tag needs a name");
  expect(() => parseFetchCommand("auth PROJ-1")).toThrow("Jira key");
});

// Paseo validates an RPC's input on both sides, so each input schema must accept its own output.
test("every RPC input schema accepts its own parsed output", () => {
  const samples: Array<[{ name: string; input: { parse(value: unknown): unknown } }, unknown]> = [
    [contracts.addTagRpc, { tags: [" Auth "], agentId: "a", workspaceId: "w" }],
    [contracts.removeTagRpc, { tags: ["auth"], agentId: "a" }],
    [contracts.addLinkRpc, { tag: "auth", url: "https://e.com/x", title: "x" }],
    [contracts.removeLinkRpc, { tag: "auth", url: "https://e.com/x" }],
    [contracts.previewTagRpc, { tag: "auth" }],
    [contracts.fetchItemRpc, { tag: "auth", ref: "PROJ-1", provider: "codex", notifyAgentId: "a" }],
    [contracts.pinAgentRpc, { agentId: "a", pinned: true }],
    [contracts.describeAgentRpc, { agentId: "a" }],
    [contracts.fetchRouteRpc, { ref: "PROJ-1" }],
    [contracts.refreshNoteRpc, { tag: "auth", noteId: "n" }],
    [contracts.removeNoteRpc, { tag: "auth", noteId: "n" }],
    [contracts.searchTagsRpc, { query: "a" }],
  ];
  for (const [rpc, sample] of samples) {
    const once = rpc.input.parse(sample);
    expect(rpc.input.parse(once), rpc.name).toEqual(once);
  }
});
