import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FetchProvider } from "../shared/contracts";

// The MCP server names each fetch provider has configured for this user, read from their own config
// files. Only names are read; commands, URLs, headers, and tokens are not kept.
export interface ConfigPaths {
  claude: string;
  codex: string;
}

export function defaultConfigPaths(home = homedir()): ConfigPaths {
  return { claude: join(home, ".claude.json"), codex: join(home, ".codex", "config.toml") };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function claudeServerNames(json: string): Set<string> {
  const servers: unknown = Reflect.get(Object(JSON.parse(json)), "mcpServers");
  return new Set(servers && typeof servers === "object" ? Object.keys(servers) : []);
}

// Table headers like [mcp_servers.notion] or [mcp_servers."my server"]; nested tables such as
// [mcp_servers.notion.http_headers] name the same server.
export function codexServerNames(toml: string): Set<string> {
  const names = new Set<string>();
  for (const match of toml.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))[\].]/gm)) names.add(match[1] ?? match[2]);
  return names;
}

export async function configuredServers(paths: ConfigPaths = defaultConfigPaths()): Promise<Map<FetchProvider, Set<string>>> {
  const [claude, codex] = await Promise.all([readOptional(paths.claude), readOptional(paths.codex)]);
  return new Map<FetchProvider, Set<string>>([
    ["claude", claude === null ? new Set() : claudeServerNames(claude)],
    ["codex", codex === null ? new Set() : codexServerNames(codex)],
  ]);
}
