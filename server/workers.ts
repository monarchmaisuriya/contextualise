import { mkdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ItemRef } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import { buildFetchPrompt, FETCH_OUTPUT_SCHEMA } from "./vendor-fetch";

// Fetch workers are Claude agents because Claude agents carry the user's claude.ai connectors
// (Jira, Sentry, Slack) and their local Notion server (checked live). Built-in tools and Paseo's own
// tool server are disallowed outright; the mode makes every remaining tool call ask, and the
// plugin's permission hook allows only the named read tools of the vendor being fetched.
const FETCH_MODEL = "claude-sonnet-5-5";
const FETCH_MODE = "default";
const BLOCKED_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "Skill", "SlashCommand", "mcp__paseo",
];
const LOCKDOWN_OPTIONS = { disallowedTools: BLOCKED_TOOLS, settings: { permissions: { deny: BLOCKED_TOOLS } } };
export const FETCH_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 15_000;
const PERMISSION_BACKOFF_MS = 2_000;
const MAX_PERMISSION_WAITS = 30;
export const WORKER_WORKSPACE_TITLE = "Contextualise background fetches";

export function workersDir(root: string): string {
  return join(root, "workers");
}

export function isWorkerCwd(root: string, cwd: string): boolean {
  const dir = resolve(workersDir(root));
  const target = resolve(cwd);
  return target === dir || target.startsWith(`${dir}${sep}`);
}

// Sonnet when Paseo lists it, since fetching needs no larger model; otherwise Claude's default.
async function fetchModel(paseo: PaseoApi): Promise<string> {
  const { models } = await paseo.providers.listModels("claude");
  if (models?.some((model) => model.id === FETCH_MODEL)) return `claude/${FETCH_MODEL}`;
  const chosen = models?.find((model) => model.isDefault) ?? models?.[0];
  if (!chosen) throw new Error("Paseo lists no Claude models; fetching needs a Claude agent");
  return `claude/${chosen.id}`;
}

const workspaceLookups = new Map<string, Promise<string>>();

// One hidden workspace on the worker folder, found again on later runs and never archived: Paseo
// shows a project in the sidebar once its last workspace is archived (seen by Memorise).
export function workerWorkspace(paseo: PaseoApi, root: string): Promise<string> {
  const dir = workersDir(root);
  const next = (workspaceLookups.get(dir) ?? Promise.resolve("")).catch(() => "").then(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const real = await realpath(dir);
    let cursor: string | undefined;
    do {
      const { entries, pageInfo } = await paseo.workspaces.list({ includeBackground: true, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      const found = entries.find((workspace) => [workspace.workspaceDirectory, workspace.projectRootPath].some((folder) => folder !== undefined && (resolve(folder) === real || resolve(folder) === resolve(dir))));
      if (found) return found.id;
      cursor = pageInfo.hasMore && pageInfo.nextCursor ? pageInfo.nextCursor : undefined;
    } while (cursor);
    const created = await paseo.workspaces.create({ source: { kind: "directory", path: dir }, background: true, title: WORKER_WORKSPACE_TITLE });
    return created.id;
  });
  workspaceLookups.set(dir, next);
  return next;
}

// Runs one fetch worker to its final message. The worker is archived afterwards whatever happens.
export async function runFetchWorker(paseo: PaseoApi, root: string, item: ItemRef, onCreated: (agentId: string) => void): Promise<string> {
  const workspaceId = await workerWorkspace(paseo, root);
  let handle: Awaited<ReturnType<PaseoApi["agents"]["create"]>> | null = null;
  try {
    handle = await paseo.workspaces.ref(workspaceId).agents.create({
      title: `contextualise: fetch ${item.vendor} ${item.ref}`.slice(0, 120),
      config: { provider: await fetchModel(paseo), modeId: FETCH_MODE, options: LOCKDOWN_OPTIONS },
      prompt: buildFetchPrompt(item),
      outputSchema: FETCH_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });
    onCreated(handle.id);
    const deadline = Date.now() + FETCH_TIMEOUT_MS;
    let permissionWaits = 0;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`did not finish in ${Math.round(FETCH_TIMEOUT_MS / 1000)} s`);
      const result = await handle.waitForFinish(Math.min(left, POLL_MS));
      if (result.status === "timeout") continue;
      // A tool request is pending; the permission hook answers it. Wait before asking again.
      if (result.status === "permission") {
        permissionWaits += 1;
        if (permissionWaits > MAX_PERMISSION_WAITS) throw new Error("kept waiting on tool permissions; stopped");
        await new Promise((done) => setTimeout(done, PERMISSION_BACKOFF_MS));
        continue;
      }
      if (result.status === "error") throw new Error(result.error ?? "the worker failed");
      if (!result.lastMessage) throw new Error("the worker finished without a reply");
      return result.lastMessage;
    }
  } finally {
    await handle?.archive().catch((error: unknown) => console.error(`[contextualise] could not archive fetch worker ${handle?.id}: ${String(error)}`));
  }
}
