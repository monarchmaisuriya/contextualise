import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { PaseoApi } from "./paseo-types";
import { HISTORY_ROW_KIND } from "../shared/history";
import { ANSWER_MAX_BYTES, browseHistory, ChatHistory, type HistoryRow, loadHistory, readHistory, searchHistory, type TimelineFetch, type TimelinePage } from "./chat-history";

// The history tools as Paseo tools, the prompt note that points a chat at them, the row added after a
// compaction, and /history. Paseo adds a plugin's tools to a chat at session_open; Claude and Codex
// reach them through Paseo's MCP server, named "paseo".
export const HISTORY_TOOL_SERVER = "paseo";
export const HISTORY_TOOLS = ["history_search", "history_browse", "history_load", "history_read"] as const;

const HISTORY_START = "<!-- contextualise:history -->";
const HISTORY_END = "<!-- /contextualise:history -->";
// Written when a chat starts, so it cannot know whether Paseo will offer the tools (a provider's
// Paseo tools can be off): it is worded for both.
const HISTORY_RULE = [
  HISTORY_START,
  "## Chat history (Contextualise)",
  "If the `history_search` tool is available: Paseo keeps this chat's full history, including anything your context dropped when it was compacted. When you need exact earlier text (a message, a tool's output, a decision), use `history_search`, then `history_load` or `history_read`, instead of guessing or asking M again.",
  "If M refers to work done in a workspace attached to this one and `attached_history_search` is available, it searches that workspace's chats the same way; M is asked to approve each call.",
  HISTORY_END,
].join("\n");

// The prompt with the history note, replacing one already there (a fork carries its parent's prompt).
export function withHistoryRule(prompt: string | undefined): string {
  let base = prompt ?? "";
  for (let start = base.indexOf(HISTORY_START); start !== -1; start = base.indexOf(HISTORY_START)) {
    const end = base.indexOf(HISTORY_END, start);
    if (end === -1) break;
    base = `${base.slice(0, start).trimEnd()}${base.slice(end + HISTORY_END.length)}`;
  }
  base = base.trim();
  return base ? `${base}\n\n${HISTORY_RULE}` : HISTORY_RULE;
}

// Whether a permission request is for one of the history tools: Claude names them
// mcp__paseo__history_search; the request parser gives the server and tool apart.
export function isHistoryTool(asked: { server: string; tool: string } | null | undefined): boolean {
  return !!asked && asked.server === HISTORY_TOOL_SERVER && (HISTORY_TOOLS as readonly string[]).includes(asked.tool);
}


// Chats whose history tools M turned off with /history off, in knowledge/history-off.json.
export class HistoryOff {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: () => Promise<string>) {}

  private async load(): Promise<Set<string>> {
    const text = await readFile(await this.file(), "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return null;
      throw error;
    });
    const parsed = text === null ? { agents: [] } : z.object({ agents: z.array(z.string()) }).parse(JSON.parse(text));
    return new Set(parsed.agents);
  }

  async isOff(agentId: string): Promise<boolean> {
    return (await this.load()).has(agentId);
  }

  // Every chat turned off, read once.
  offChats(): Promise<ReadonlySet<string>> {
    return this.load();
  }

  set(agentId: string, off: boolean): Promise<void> {
    const next = this.queue.then(async () => {
      const agents = await this.load();
      if (off) agents.add(agentId);
      else agents.delete(agentId);
      const path = await this.file();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, `${JSON.stringify({ agents: [...agents] })}\n`, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

// Paseo's timeline for one chat, paged as ChatHistory reads it.
export function timelineOf(paseo: PaseoApi, agentId: string): TimelineFetch {
  const timeline = paseo.agents.ref(agentId).timeline;
  return async ({ direction, cursor, limit }) => {
    const page = await timeline.refetch({ direction, ...(cursor ? { cursor } : {}), limit, projection: "projected" });
    return page as unknown as TimelinePage;
  };
}

export interface HistoryDeps {
  history: ChatHistory;
  off: HistoryOff;
  enabled: () => Promise<boolean>;
}

type ToolContext = { agent: { id?: string | null }; paseo: PaseoApi };
type ToolAnswer = { text: string; isError?: boolean };

// The four tools. Each reads the calling chat's own history; none changes anything.
export function historyTools(deps: HistoryDeps) {
  const withRows = async (context: ToolContext, answer: (rows: readonly HistoryRow[], budget: number) => { text: string }): Promise<ToolAnswer> => {
    const agentId = context.agent?.id;
    if (!agentId) return { isError: true, text: "Paseo did not say which chat is asking, so there is no history to read." };
    if (!(await deps.enabled())) return { isError: true, text: "Chat history tools are off (Settings > Contextualise)." };
    if (await deps.off.isOff(agentId)) return { isError: true, text: "Chat history tools are off for this chat; M can turn them on with /history on." };
    try {
      const { rows, reloaded, capped } = await deps.history.rows(agentId, timelineOf(context.paseo, agentId));
      const notes = [reloaded ? "This chat's history was reloaded since it was last read (ids changed); use ids from this answer." : "", capped ? `Only the newest ${rows.length.toLocaleString("en-US")} history items are searched.` : ""].filter(Boolean);
      const note = notes.join(" ");
      // The notes come out of the same 16 KiB the answer may use.
      const { text } = answer(rows, ANSWER_MAX_BYTES - (note ? Buffer.byteLength(note, "utf8") + 1 : 0));
      return { text: note ? `${note}\n${text}` : text };
    } catch (error) {
      return { isError: true, text: error instanceof Error ? error.message : String(error) };
    }
  };
  return [
    {
      name: "history_search",
      title: "Search this chat's history",
      description:
        "Search this chat's own earlier history, including what was dropped when its context was compacted: messages, tool calls, and their outputs, as exact text. Every word of `query` must match; `tools` keeps calls of any of those tools; `files` keeps items naming all of those files; `failed` keeps failed tool calls. Newest first. With `load`, the first three matches are returned whole. Paseo keeps at most 64K characters of a tool's output; one cut there ends with [Content truncated].",
      input: z.object({
        query: z.string().max(500).optional(),
        tools: z.array(z.string().min(1).max(200)).max(20).optional(),
        files: z.array(z.string().min(1).max(500)).max(20).optional(),
        failed: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        load: z.boolean().optional(),
      }),
      execute: (input: Parameters<typeof searchHistory>[1], context: ToolContext) => withRows(context, (rows, budget) => searchHistory(rows, input, budget)),
    },
    {
      name: "history_browse",
      title: "Browse this chat's history",
      description: "List the items before, after, or around one item of this chat's history (an id from history_search), oldest first.",
      input: z.object({ id: z.string().min(1).max(200), direction: z.enum(["before", "after", "around"]), count: z.number().int().min(1).max(30).optional() }),
      execute: (input: Parameters<typeof browseHistory>[1], context: ToolContext) => withRows(context, (rows, budget) => browseHistory(rows, input, budget)),
    },
    {
      name: "history_load",
      title: "Load items of this chat's history",
      description: "Load up to three items of this chat's history by id, as exact text. An item too long for one answer comes back as a handle for history_read.",
      input: z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(3) }),
      execute: ({ ids }: { ids: string[] }, context: ToolContext) => withRows(context, (rows, budget) => loadHistory(rows, ids, budget)),
    },
    {
      name: "history_read",
      title: "Read one item of this chat's history",
      description: "Read one item of this chat's history from `offset` (in characters), at most 16,384 characters a page; the answer gives the call for the next page.",
      input: z.object({ id: z.string().min(1).max(200), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(16_384).optional() }),
      execute: (input: Parameters<typeof readHistory>[1], context: ToolContext) => withRows(context, (rows, budget) => readHistory(rows, input, budget)),
    },
  ];
}

// The compactions a row was added for, by chat and the compaction's time, in knowledge/history-noted.json.
// Paseo rebuilds a timeline with new ids after a restart, so ids cannot tell a compaction already
// noted; its time, taken from the CLI's transcript, can.
export class NotedCompactions {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: () => Promise<string>) {}

  private async load(): Promise<Record<string, string[]>> {
    const text = await readFile(await this.file(), "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return null;
      throw error;
    });
    return text === null ? {} : z.record(z.string(), z.array(z.string())).parse(JSON.parse(text));
  }

  async has(agentId: string, at: string): Promise<boolean> {
    return (await this.load())[agentId]?.includes(at) ?? false;
  }

  add(agentId: string, at: string): Promise<void> {
    const next = this.queue.then(async () => {
      const all = await this.load();
      all[agentId] = [...(all[agentId] ?? []).filter((time) => time !== at), at].slice(-50);
      // The chats noted most recently are kept.
      const kept = Object.fromEntries(Object.entries(all).slice(-500));
      const path = await this.file();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

// A row for each completed compaction in the newest page of the chat's timeline not noted yet.
export async function addCompactionRows(paseo: PaseoApi, agentId: string, noted: NotedCompactions): Promise<number> {
  const page = (await timelineOf(paseo, agentId)({ direction: "tail", limit: 200 })) as TimelinePage;
  if (page.error) throw new Error(page.error);
  let added = 0;
  for (const entry of page.entries) {
    const item = (entry.item ?? {}) as Record<string, unknown>;
    if (item.type !== "compaction" || item.status !== "completed" || (await noted.has(agentId, entry.timestamp))) continue;
    const id = `compaction-${page.epoch}-${entry.seqStart}`;
    const size = typeof item.preTokens === "number" ? ` (about ${item.preTokens.toLocaleString("en-US")} tokens before)` : "";
    const how = item.trigger === "auto" ? "automatically " : item.trigger === "manual" ? "on request " : "";
    await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind: HISTORY_ROW_KIND, version: 1, data: { title: `Context compacted ${how}${size}`.replace(/\s+/g, " ").trim(), lines: ["Earlier history is kept; this chat can recover it word for word with history_search."] } });
    await noted.add(agentId, entry.timestamp);
    added += 1;
  }
  return added;
}

// /history status: whether the tools are on for this chat, the stored history's size, compactions,
// and the context use Paseo reports. Estimates are marked "~".
export async function historyStatus(deps: HistoryDeps, paseo: PaseoApi, agentId: string): Promise<{ title: string; lines: string[] }> {
  const on = (await deps.enabled()) && !(await deps.off.isOff(agentId));
  const { rows, capped } = await deps.history.rows(agentId, timelineOf(paseo, agentId));
  const characters = rows.reduce((sum, row) => sum + row.text.length, 0);
  const compactions = rows.filter((row) => row.kind === "compaction");
  const ref = paseo.agents.ref(agentId);
  await ref.refresh().catch(() => undefined);
  const usage = ref.lastUsage as { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
  const number = (value: number) => value.toLocaleString("en-US");
  const context =
    usage?.contextWindowUsedTokens !== undefined
      ? `${number(usage.contextWindowUsedTokens)}${usage.contextWindowMaxTokens ? ` of ${number(usage.contextWindowMaxTokens)} tokens (${Math.round((usage.contextWindowUsedTokens / usage.contextWindowMaxTokens) * 100)}%)` : " tokens"}`
      : "unavailable";
  return {
    title: `Chat history tools: ${on ? "on" : "off"}`,
    lines: [
      `History: ${number(rows.length)} items${capped ? " (newest kept)" : ""}, ~${number(Math.round(characters / 4))} tokens`,
      `Compactions: ${compactions.length}${compactions.length ? ` (last: ${compactions.at(-1)!.text.replace(/^Context compacted ?/, "") || "no size reported"})` : ""}`,
      `Context now: ${context}`,
    ],
  };
}
