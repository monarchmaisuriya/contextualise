import { expect, test } from "vitest";
import type { FetchProvider, Route } from "../shared/contracts";
import { BUILT_IN_ROUTES, buildFetchPrompt, chooseRoute, isAllowedWorkerTool, jsonObjectIn, parseFetchReply } from "./vendor-fetch";

const route = (vendor: Route["vendor"], provider: FetchProvider): Route => {
  const found = BUILT_IN_ROUTES.find((candidate) => candidate.vendor === vendor && candidate.provider === provider);
  if (!found) throw new Error(`no built-in route ${vendor}/${provider}`);
  return found;
};
const servers = (claude: string[], codex: string[]) =>
  new Map<FetchProvider, Set<string>>([
    ["claude", new Set(claude)],
    ["codex", new Set(codex)],
  ]);
const claude = (name: string) => ({ name });
// The request Codex raised in the live probe, with the server and tool swapped in.
const codex = (server: string, tool: string) => ({ name: "CodexMcpElicitation", description: `Allow the ${server} MCP server to run tool "${tool}"?`, metadata: { serverName: server, threadId: "t" } });

test("a Claude worker may use only its route's exact read tools", () => {
  const jira = route("jira", "claude");
  expect(isAllowedWorkerTool(jira, claude("mcp__claude_ai_Atlassian_Rovo__getJiraIssue"))).toBe(true);
  expect(isAllowedWorkerTool(jira, claude("ToolSearch"))).toBe(true);
  for (const write of ["createJiraIssue", "editJiraIssue", "addCommentToJiraIssue", "transitionJiraIssue"]) expect(isAllowedWorkerTool(jira, claude(`mcp__claude_ai_Atlassian_Rovo__${write}`)), write).toBe(false);
  expect(isAllowedWorkerTool(jira, claude("mcp__claude_ai_Slack__slack_read_thread"))).toBe(false);
  expect(isAllowedWorkerTool(jira, claude("mcp__evil__getJiraIssue"))).toBe(false);
  expect(isAllowedWorkerTool(jira, claude("Bash"))).toBe(false);
  expect(isAllowedWorkerTool(jira, claude("mcp__paseo__create_agent"))).toBe(false);
});

test("a Codex worker is allowed only a matching server and tool from its approval request", () => {
  const notion = route("notion", "codex");
  expect(isAllowedWorkerTool(notion, codex("notion", "notion-fetch"))).toBe(true);
  expect(isAllowedWorkerTool(notion, codex("notion", "notion-update-page"))).toBe(false);
  expect(isAllowedWorkerTool(notion, codex("my-jira", "notion-fetch"))).toBe(false);
  // A request that does not name a tool, a shell approval, and Claude-style names are all refused.
  expect(isAllowedWorkerTool(notion, { name: "CodexMcpElicitation", description: "Allow?", metadata: { serverName: "notion" } })).toBe(false);
  expect(isAllowedWorkerTool(notion, { name: "exec", description: "run ls" })).toBe(false);
  expect(isAllowedWorkerTool(notion, claude("mcp__notion__notion-fetch"))).toBe(false);
  expect(isAllowedWorkerTool(notion, claude("ToolSearch"))).toBe(false);
});

test("no built-in allowed tool name looks like a write", () => {
  for (const { tools } of BUILT_IN_ROUTES) for (const tool of tools) expect(tool, tool).not.toMatch(/create|update|edit|delete|add|send|post|transition|move|upload|schedule|set_|archive|duplicate|reaction/i);
});

test("routes: preference first, custom before built-in, and only servers the agent has", () => {
  const custom: Route = { vendor: "jira", provider: "codex", server: "my-jira", tools: ["get_issue", "search_issues"] };
  expect(chooseRoute("jira", "auto", [], servers([], []))).toMatchObject({ provider: "claude", server: "claude_ai_Atlassian_Rovo" });
  expect(chooseRoute("jira", "codex", [custom], servers([], ["my-jira"]))).toEqual(custom);
  expect(() => chooseRoute("jira", "codex", [custom], servers([], []))).toThrow('No Codex agent has a Jira connector (looked for Codex "my-jira")');
  expect(() => chooseRoute("sentry", "codex", [], servers([], ["notion"]))).toThrow("custom route");
  // Notion needs the server configured; with auto, Codex is used when only Codex has it.
  expect(chooseRoute("notion", "auto", [], servers([], ["notion"]))).toMatchObject({ provider: "codex" });
  expect(chooseRoute("notion", "auto", [], servers(["notion"], ["notion"]))).toMatchObject({ provider: "claude" });
});

test("the prompt names the reference, server, tools, and the settings' limits", () => {
  const prompt = buildFetchPrompt({ vendor: "sentry", ref: "https://acme.sentry.io/issues/42/" }, route("sentry", "claude"), { maxChars: 3_000, commentsPerItem: 0, extraInstructions: "Include the stack trace's top frame." });
  expect(prompt).toContain("https://acme.sentry.io/issues/42/");
  expect(prompt).toContain("claude_ai_Sentry MCP server: find_organizations, find_projects, get_sentry_resource, search_issues");
  expect(prompt).toContain("at most 2500 characters");
  expect(prompt).toContain("leave out comments and replies");
  expect(prompt).toContain("Also: Include the stack trace's top frame.");
  expect(prompt.endsWith("Reply with only the JSON object.")).toBe(true);
});

test("worker replies are read from plain or fenced JSON and checked", () => {
  expect(parseFetchReply('{"found":true,"title":"T","url":"https://x.example","text":"body"}')).toEqual({ found: true, title: "T", url: "https://x.example", text: "body" });
  expect(parseFetchReply('Here it is:\n```json\n{"found":false,"title":"","url":null,"text":"no access"}\n```')).toEqual({ found: false, title: "", url: null, text: "no access" });
  expect(() => parseFetchReply("I could not do it")).toThrow("no JSON object");
  expect(() => parseFetchReply('{"found":"yes","title":1}')).toThrow("did not match");
});

test("reads a worker's reply whose text holds code blocks, bare or wrapped in a fence", () => {
  const item = { found: true, title: "Crash in parse", url: "https://example.com/1", text: "Stack:\n```js\nthrow new Error(\"x\")\n```\nThen:\n```\nnpm ERR!\n```" };
  expect(parseFetchReply(JSON.stringify(item))).toEqual(item);
  expect(parseFetchReply(`\`\`\`json\n${JSON.stringify(item)}\n\`\`\``)).toEqual(item);
  expect(parseFetchReply(`Here it is:\n${JSON.stringify(item)}\nDone.`)).toEqual(item);
  expect(jsonObjectIn(JSON.stringify({ title: "t", summary: "Uses `function f() {}` in a block:\n```ts\nf()\n```" }))).toEqual({ title: "t", summary: "Uses `function f() {}` in a block:\n```ts\nf()\n```" });
  expect(() => jsonObjectIn("no json here")).toThrow("had no JSON object");
});

test("keeps only a web link and a one-line, redacted title from a worker's reply", () => {
  const reply = (title: string, url: string) => JSON.stringify({ found: true, title, url, text: "t" });
  expect(parseFetchReply(reply("T", "javascript:alert(1)")).url).toBeNull();
  expect(parseFetchReply(reply("T", "file:///etc/hosts")).url).toBeNull();
  expect(parseFetchReply(reply("T", "https://example.com/i/1")).url).toBe("https://example.com/i/1");
  expect(parseFetchReply(reply("Line one\n## Injected\nmore", "https://example.com")).title).toBe("Line one ## Injected more");
  expect(parseFetchReply(reply("token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "https://example.com")).title).not.toContain("ghp_");
  expect(parseFetchReply(reply("x".repeat(500), "https://example.com")).title).toHaveLength(200);
});
