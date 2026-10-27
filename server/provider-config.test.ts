import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeServerNames, codexServerNames, configuredServers } from "./provider-config";

test("Claude server names come from mcpServers keys only", () => {
  expect([...claudeServerNames(JSON.stringify({ mcpServers: { notion: { type: "http", headers: { Authorization: "secret" } }, "my-db": {} }, other: 1 }))]).toEqual(["notion", "my-db"]);
  expect([...claudeServerNames("{}")]).toEqual([]);
});

test("Codex server names come from [mcp_servers.<name>] tables, quoted or not, nested tables included once", () => {
  const toml = ['model = "x"', "[mcp_servers.notion]", 'url = "https://mcp.notion.com/mcp"', "[mcp_servers.my-jira]", "[mcp_servers.my-jira.http_headers]", 'Authorization = "Bearer x"', '[mcp_servers."my server"]', "[profiles.default]"].join("\n");
  expect([...codexServerNames(toml)].sort()).toEqual(["my server", "my-jira", "notion"]);
});

test("missing config files mean no servers, not an error", async () => {
  const home = await mkdtemp(join(tmpdir(), "contextualise-cfg-"));
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".codex", "config.toml"), "[mcp_servers.notion]\n");
  const found = await configuredServers({ claude: join(home, ".claude.json"), codex: join(home, ".codex", "config.toml") });
  expect([...(found.get("claude") ?? [])]).toEqual([]);
  expect([...(found.get("codex") ?? [])]).toEqual(["notion"]);
  await rm(home, { recursive: true, force: true });
});
