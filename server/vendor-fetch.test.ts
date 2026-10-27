import { expect, test } from "vitest";
import { buildFetchPrompt, isAllowedWorkerTool, parseFetchReply, VENDOR_TOOLS } from "./vendor-fetch";

test("a fetch worker may use only its own vendor's named read tools", () => {
  expect(isAllowedWorkerTool("jira", "mcp__claude_ai_Atlassian_Rovo__getJiraIssue")).toBe(true);
  expect(isAllowedWorkerTool("jira", "ToolSearch")).toBe(true);
  for (const write of ["mcp__claude_ai_Atlassian_Rovo__createJiraIssue", "mcp__claude_ai_Atlassian_Rovo__editJiraIssue", "mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue", "mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue"]) {
    expect(isAllowedWorkerTool("jira", write), write).toBe(false);
  }
  expect(isAllowedWorkerTool("slack", "mcp__claude_ai_Slack__slack_send_message")).toBe(false);
  expect(isAllowedWorkerTool("slack", "mcp__claude_ai_Slack__slack_read_thread")).toBe(true);
  expect(isAllowedWorkerTool("notion", "mcp__notion__notion-update-page")).toBe(false);
  expect(isAllowedWorkerTool("notion", "mcp__notion__notion-fetch")).toBe(true);
  // Another vendor's read tool, a look-alike server, and built-in tools are all refused.
  expect(isAllowedWorkerTool("jira", "mcp__claude_ai_Slack__slack_read_thread")).toBe(false);
  expect(isAllowedWorkerTool("jira", "mcp__evil__getJiraIssue")).toBe(false);
  expect(isAllowedWorkerTool("sentry", "Bash")).toBe(false);
  expect(isAllowedWorkerTool("sentry", "mcp__paseo__create_agent")).toBe(false);
});

test("no allowed tool name looks like a write", () => {
  for (const { tools } of Object.values(VENDOR_TOOLS)) for (const tool of tools) expect(tool, tool).not.toMatch(/create|update|edit|delete|add|send|post|transition|move|upload|schedule|set_|archive|duplicate|reaction/i);
});

test("the prompt names the reference, the connector, and its tools, and asks for JSON only", () => {
  const prompt = buildFetchPrompt({ vendor: "sentry", ref: "https://acme.sentry.io/issues/42/" });
  expect(prompt).toContain("https://acme.sentry.io/issues/42/");
  expect(prompt).toContain("claude_ai_Sentry");
  expect(prompt).toContain("get_sentry_resource");
  expect(prompt).toContain("Reply with only the JSON object.");
});

test("worker replies are read from plain or fenced JSON and checked", () => {
  expect(parseFetchReply('{"found":true,"title":"T","url":"https://x","text":"body"}')).toEqual({ found: true, title: "T", url: "https://x", text: "body" });
  expect(parseFetchReply('Here it is:\n```json\n{"found":false,"title":"","url":null,"text":"no access"}\n```')).toEqual({ found: false, title: "", url: null, text: "no access" });
  expect(() => parseFetchReply("I could not do it")).toThrow("no JSON object");
  expect(() => parseFetchReply('{"found":"yes","title":1}')).toThrow("did not match");
});
