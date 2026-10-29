import { isAbsolute, relative, resolve, sep } from "node:path";
import { cleanTitle } from "../rows";
import { redactSecrets } from "../secrets";
import type { AgentTimelineItem } from "../paseo-types";
import type { TaskRecord } from "./store";

const REQUEST_MAX_CHARS = 500;
const TITLE_MAX_CHARS = 80;
const COMMAND_MAX_CHARS = 200;
const MAX_COMMANDS = 20;
const MAX_FILES = 50;

export interface TimelineEntry {
  item: AgentTimelineItem;
  timestamp: string;
}

export interface TaskInput {
  agent: { id: string; provider: string; cwd: string; title: string | null };
  outcome: TaskRecord["outcome"];
  entries: readonly TimelineEntry[];
  // The repository root: changed files are recorded relative to it, and files outside it are left out.
  top: string;
  now: string;
}

function oneLine(text: string, max: number): string {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function repoPath(filePath: string, cwd: string, top: string): string | null {
  const path = relative(top, isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
  return path === "" || path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path) ? null : path.split(sep).join("/");
}

// A finished task, from the agent's timeline alone: what was asked first, the files it changed, the
// commands it ran with their exit codes, and how its last turn ended. No model reads the session,
// so nothing leaves the plugin; secret-shaped text is removed before it is stored.
export function buildTask(input: TaskInput): Omit<TaskRecord, "citations"> | null {
  const { agent, entries, top } = input;
  const firstUser = entries.find((entry) => entry.item.type === "user_message");
  if (!firstUser || firstUser.item.type !== "user_message") return null;
  const files = new Set<string>();
  const commands: TaskRecord["commands"] = [];
  for (const { item } of entries) {
    if (item.type !== "tool_call") continue;
    const detail = item.detail as { type?: string; command?: string; exitCode?: number | null; filePath?: string } | undefined;
    if ((detail?.type === "edit" || detail?.type === "write") && detail.filePath) {
      const path = repoPath(detail.filePath, agent.cwd, top);
      if (path) files.add(path);
    } else if (detail?.type === "shell" && detail.command) {
      commands.push({ command: oneLine(detail.command, COMMAND_MAX_CHARS), exitCode: detail.exitCode ?? null });
    }
  }
  const request = oneLine(firstUser.item.text, REQUEST_MAX_CHARS);
  return {
    id: `task:${agent.id}`,
    agentId: agent.id,
    provider: agent.provider,
    // The first request often starts with Markdown ("**Handoff: …**"); a title is plain text.
    title: oneLine(cleanTitle(agent.title?.trim() || request, true), TITLE_MAX_CHARS),
    request,
    outcome: input.outcome,
    files: [...files].slice(0, MAX_FILES),
    commands: commands.slice(-MAX_COMMANDS),
    startedAt: firstUser.timestamp,
    endedAt: input.now,
  };
}

// A task needs checking when a file it changed has changed again (or is gone) since it was recorded.
export function taskNeedsCheck(task: Pick<TaskRecord, "citations">, current: ReadonlyMap<string, string>): boolean {
  return task.citations.some((citation) => current.get(citation.path) !== citation.blob);
}
