import { mkdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { FetchProvider, Route } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import { FETCH_OUTPUT_SCHEMA } from "./vendor-fetch";

// How each provider's worker is locked down (checked live). Claude: built-in tools and Paseo's own
// tool server are disallowed outright, and in mode "default" every MCP tool call asks. Codex: mode
// "auto" with a read-only sandbox and web search off; every MCP tool its server does not mark
// read-only asks. Either way the plugin's permission hook allows only the
// route's named read tools and denies the rest.
const BLOCKED_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "Skill", "SlashCommand", "mcp__paseo",
];
export const LOCKDOWN: Record<FetchProvider, { modeId: string; options: Record<string, unknown> }> = {
  claude: { modeId: "default", options: { disallowedTools: BLOCKED_TOOLS, settings: { permissions: { deny: BLOCKED_TOOLS } } } },
  // Paseo accepts only auto, auto-review, and full-access for Codex; "auto" with a read-only sandbox
  // still asks before every MCP tool not marked read-only (checked live).
  codex: { modeId: "auto", options: { sandbox_mode: "read-only", web_search: "disabled" } },
};
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

// The configured model when Paseo lists it for the provider; empty means the provider's default.
// A configured model that Paseo does not list is an error, not a silent switch to another model.
async function fetchModel(paseo: PaseoApi, provider: FetchProvider, configured: string): Promise<string> {
  const { models } = await paseo.providers.listModels(provider);
  if (configured) {
    if (models?.some((model) => model.id === configured)) return `${provider}/${configured}`;
    throw new Error(`Paseo lists no ${provider} model "${configured}"; change it in Settings > Contextualise > Fetching (the models there are used for every background agent)`);
  }
  const chosen = models?.find((model) => model.isDefault) ?? models?.[0];
  if (!chosen) throw new Error(`Paseo lists no ${provider} models`);
  return `${provider}/${chosen.id}`;
}

export interface FetchJob {
  route: Route;
  title: string;
  prompt: string;
  model: string;
  timeoutMs: number;
}

// Any background agent: a locked-down Claude or Codex agent in the hidden worker workspace that
// answers one prompt in the shape of `outputSchema`, then is archived.
export interface WorkerJob {
  provider: FetchProvider;
  title: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  outputSchema: Record<string, unknown>;
}

const workspaceLookups = new Map<string, Promise<string>>();

// Paseo's client waits for ever on workspace and agent creation, so every step of starting a worker
// is held to the job's deadline.
function beforeDeadline<T>(work: Promise<T>, deadline: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`did not start: ${what} took longer than the worker's time limit`)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// One hidden workspace on the worker folder, found again on later runs and never archived: Paseo
// shows a project in the sidebar once its last workspace is archived (seen by Memorise).
// Lookups for one folder run one after another; each is held to its caller's deadline, so one that
// hangs does not hold up the next.
export function workerWorkspace(paseo: PaseoApi, root: string, deadline: number): Promise<string> {
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
  const bounded = beforeDeadline(next, deadline, "finding the worker workspace");
  workspaceLookups.set(dir, bounded);
  return bounded;
}

// Runs one fetch worker to its final message.
export function runFetchWorker(paseo: PaseoApi, root: string, job: FetchJob, onCreated: (agentId: string) => void): Promise<string> {
  const { route, ...rest } = job;
  return runWorker(paseo, root, { ...rest, provider: route.provider, outputSchema: FETCH_OUTPUT_SCHEMA as unknown as Record<string, unknown> }, onCreated);
}

// Runs one background agent to its final message, within `job.timeoutMs` from the call, starting
// included. The agent is archived afterwards whatever happens, also when it is created too late.
export async function runWorker(paseo: PaseoApi, root: string, job: WorkerJob, onCreated: (agentId: string) => void): Promise<string> {
  const deadline = Date.now() + job.timeoutMs;
  const workspaceId = await workerWorkspace(paseo, root, deadline);
  let handle: Awaited<ReturnType<PaseoApi["agents"]["create"]>> | null = null;
  try {
    const { modeId, options } = LOCKDOWN[job.provider];
    const provider = await beforeDeadline(fetchModel(paseo, job.provider, job.model), deadline, "listing models");
    const creating = paseo.workspaces.ref(workspaceId).agents.create({ title: job.title.slice(0, 120), config: { provider, modeId, options }, prompt: job.prompt, outputSchema: job.outputSchema });
    try {
      handle = await beforeDeadline(creating, deadline, "creating the agent");
    } catch (error) {
      void creating.then(
        (late) => late.archive().catch((archiveError: unknown) => console.error(`[contextualise] could not archive late background agent ${late.id}: ${String(archiveError)}`)),
        () => undefined,
      );
      throw error;
    }
    onCreated(handle.id);
    let permissionWaits = 0;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`did not finish in ${Math.round(job.timeoutMs / 1000)} s`);
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
    await handle?.archive().catch((error: unknown) => console.error(`[contextualise] could not archive background agent ${handle?.id}: ${String(error)}`));
  }
}
