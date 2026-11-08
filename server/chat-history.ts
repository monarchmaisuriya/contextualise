import { redactSecrets } from "./secrets";

// A chat's own earlier history, as exact text, for the history tools. Paseo keeps a chat's whole
// timeline even after its CLI compacts its context, so a chat can search and reload what it dropped.
// Paseo rebuilds a timeline from the CLI's transcript, with new ids, after a daemon restart, a reload,
// or a rewind; ids name their timeline epoch, so an id from before says the history was reloaded.

// Every answer stays within this many bytes of UTF-8, headers included.
export const ANSWER_MAX_BYTES = 16 * 1024;
// History items read per chat at most, newest kept, and the memory the index may hold (UTF-16 text).
export const MAX_HISTORY_ROWS = 20_000;
export const CHAT_MAX_BYTES = 64 * 1024 * 1024;
export const TOTAL_MAX_BYTES = 256 * 1024 * 1024;
const PAGE = 200;
const SEARCH_LIMIT = 20;
const SEARCH_LIMIT_MAX = 50;
const BROWSE_COUNT = 10;
const BROWSE_COUNT_MAX = 30;
const LOAD_MAX = 3;
const EXCERPT_CHARS = 160;
// The history tools' own calls are never searched or loaded, the attached_history_* ones included
// (Claude names them through Paseo's MCP server, as mcp__paseo__history_search; Codex as
// paseo.history_search).
const OWN_TOOL = /(^|[_.])history_(search|browse|load|read)$/;

export type HistoryKind = "you" | "assistant" | "tool" | "compaction" | "error";
export interface HistoryRow {
  id: string;
  kind: HistoryKind;
  tool: string | null;
  files: string[];
  failed: boolean;
  time: string;
  text: string;
  // The chat a row came from, when rows of several chats are searched together.
  source?: string;
}

// What an answer calls the history it searched and the tools that read it further.
export interface HistoryNames {
  scope: string;
  // The history one item belongs to.
  itemHistory: string;
  search: string;
  load: string;
  read: string;
  // Where a valid id comes from.
  idsFrom: string;
}
export const OWN_HISTORY: HistoryNames = { scope: "this chat's history", itemHistory: "this chat's history", search: "history_search", load: "history_load", read: "history_read", idsFrom: "history_search or history_browse" };

export interface TimelineCursor {
  epoch: string;
  seq: number;
}
export interface TimelinePage {
  epoch: string;
  reset: boolean;
  entries: { item: unknown; timestamp: string; seqStart: number; seqEnd?: number }[];
  hasOlder: boolean;
  hasNewer: boolean;
  startCursor: TimelineCursor | null;
  endCursor: TimelineCursor | null;
  error: string | null;
}
export type TimelineFetch = (request: { direction: "tail" | "before" | "after"; cursor?: TimelineCursor; limit: number }) => Promise<TimelinePage>;

const text = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value, null, 2));

// The body of a tool call: what it was given and what came back, whole.
function toolBody(detail: Record<string, unknown>): string {
  const lines: string[] = [];
  const add = (line: unknown) => {
    const value = text(line);
    if (value !== "") lines.push(value);
  };
  switch (detail.type) {
    case "shell":
      add(`$ ${text(detail.command)}`);
      if (typeof detail.exitCode === "number") add(`(exit ${detail.exitCode})`);
      add(detail.output);
      break;
    case "read":
      add(`read ${text(detail.filePath)}`);
      add(detail.content);
      break;
    case "edit":
      add(`edit ${text(detail.filePath)}`);
      add(detail.unifiedDiff ?? [detail.oldString !== undefined ? `old:\n${text(detail.oldString)}` : "", detail.newString !== undefined ? `new:\n${text(detail.newString)}` : ""].filter(Boolean).join("\n"));
      break;
    case "write":
      add(`write ${text(detail.filePath)}`);
      add(detail.content);
      break;
    case "search":
      add(`search ${text(detail.query)}`);
      add(detail.content);
      if (Array.isArray(detail.filePaths) && detail.filePaths.length > 0) add(`files: ${detail.filePaths.join(", ")}`);
      break;
    case "fetch":
      add(`fetch ${text(detail.url)}`);
      add(detail.result);
      break;
    default:
      add(JSON.stringify(detail, null, 2));
  }
  return lines.join("\n");
}

const number = (value: number) => value.toLocaleString("en-US");

// One timeline item as a history row, or null for what is never offered: reasoning, the history
// tools' own calls, a compaction still running, and Paseo's bookkeeping (turns, usage, plugin rows).
// Secret-shaped text is redacted; the rest is kept whole.
export function historyRow(item: unknown, time: string, id: string): HistoryRow | null {
  const entry = (item ?? {}) as Record<string, unknown>;
  const row = (kind: HistoryKind, body: string, extra: Partial<HistoryRow> = {}): HistoryRow => ({ id, kind, tool: null, files: [], failed: false, time, text: redactSecrets(body), ...extra });
  switch (entry.type) {
    case "user_message":
      return row("you", `You: ${text(entry.text)}`);
    case "assistant_message":
      return row("assistant", `Assistant: ${text(entry.text)}`);
    case "tool_call": {
      const name = text(entry.name);
      if (OWN_TOOL.test(name)) return null;
      const detail = (entry.detail ?? {}) as Record<string, unknown>;
      const failed = entry.status === "failed";
      const files = [detail.filePath, ...(Array.isArray(detail.filePaths) ? detail.filePaths : [])].filter((path): path is string => typeof path === "string");
      const body = [`Tool ${name} (${text(entry.status)})`, toolBody(detail), failed && entry.error ? `Error: ${text(entry.error)}` : ""].filter(Boolean).join("\n");
      return row("tool", body, { tool: name, files, failed });
    }
    case "compaction": {
      if (entry.status !== "completed") return null;
      const parts = [entry.trigger === "auto" ? "automatic" : entry.trigger === "manual" ? "manual" : "", typeof entry.preTokens === "number" ? `about ${number(entry.preTokens)} tokens before` : ""].filter(Boolean);
      return row("compaction", `Context compacted${parts.length ? ` (${parts.join(", ")})` : ""}`);
    }
    case "error":
      return row("error", `Error: ${text(entry.message)}`, { failed: true });
    default:
      return null;
  }
}

interface Indexed {
  epoch: string;
  // Rows by Paseo's row key (seqStart): a row Paseo updates later (a tool call that finishes, a
  // merged reply, a plugin row replaced) comes back under the same key and replaces its copy.
  rows: Map<number, HistoryRow>;
  // Where the next read starts: the end of the newest page read.
  cursor: TimelineCursor | null;
  capped: boolean;
  bytes: number;
}

// Each chat's history rows, kept per chat and timeline epoch. The first read takes the whole
// timeline, newest first, up to `maxRows`; later reads fetch only what Paseo changed after the last
// read and merge it by row key. A new epoch, or Paseo saying the timeline was reset, rebuilds the
// chat's rows. Rows are dropped oldest first past `maxBytes` a chat, and whole chats, least recently
// read first, past `totalBytes`.
export class ChatHistory {
  private readonly chats = new Map<string, Indexed>();

  constructor(
    private readonly maxRows = MAX_HISTORY_ROWS,
    private readonly maxBytes = CHAT_MAX_BYTES,
    private readonly totalBytes = TOTAL_MAX_BYTES,
  ) {}

  private static check(page: TimelinePage): TimelinePage {
    if (page.error) throw new Error(`Paseo could not read the chat's history: ${page.error}`);
    return page;
  }

  private trim(indexed: Indexed): Indexed {
    const keys = [...indexed.rows.keys()].sort((a, b) => a - b);
    let bytes = keys.reduce((sum, key) => sum + rowBytes(indexed.rows.get(key)!), 0);
    let capped = indexed.capped;
    for (let at = 0; at < keys.length && (keys.length - at > this.maxRows || bytes > this.maxBytes); at += 1) {
      bytes -= rowBytes(indexed.rows.get(keys[at])!);
      indexed.rows.delete(keys[at]);
      capped = true;
    }
    return { ...indexed, capped, bytes };
  }

  private merge(indexed: Indexed, entries: TimelinePage["entries"]): void {
    for (const entry of entries) {
      const row = historyRow(entry.item, entry.timestamp, `${entry.seqStart}@${indexed.epoch}`);
      if (row) indexed.rows.set(entry.seqStart, row);
      else indexed.rows.delete(entry.seqStart);
    }
  }

  private async full(fetch: TimelineFetch): Promise<Indexed> {
    let page = ChatHistory.check(await fetch({ direction: "tail", limit: PAGE }));
    const indexed: Indexed = { epoch: page.epoch, rows: new Map(), cursor: page.endCursor, capped: false, bytes: 0 };
    this.merge(indexed, page.entries);
    let read = page.entries.length;
    while (page.hasOlder && page.startCursor) {
      if (read >= this.maxRows) {
        indexed.capped = true;
        break;
      }
      page = ChatHistory.check(await fetch({ direction: "before", cursor: page.startCursor, limit: PAGE }));
      if (page.epoch !== indexed.epoch) return this.full(fetch);
      this.merge(indexed, page.entries);
      read += page.entries.length;
    }
    return this.trim(indexed);
  }

  async rows(agentId: string, fetch: TimelineFetch): Promise<{ rows: HistoryRow[]; reloaded: boolean; capped: boolean }> {
    const known = this.chats.get(agentId);
    let indexed = known ?? (await this.full(fetch));
    let reloaded = false;
    if (known) {
      let cursor = known.cursor;
      for (let pages = 0; ; pages += 1) {
        const page = ChatHistory.check(await fetch(cursor ? { direction: "after", cursor, limit: PAGE } : { direction: "tail", limit: PAGE }));
        if (page.reset || page.epoch !== known.epoch) {
          indexed = await this.full(fetch);
          reloaded = true;
          break;
        }
        this.merge(known, page.entries);
        if (page.endCursor) cursor = page.endCursor;
        if (!page.hasNewer || !page.endCursor || pages > this.maxRows / PAGE) {
          indexed = this.trim({ ...known, cursor });
          break;
        }
      }
    }
    this.chats.delete(agentId);
    this.chats.set(agentId, indexed);
    let total = [...this.chats.values()].reduce((sum, chat) => sum + chat.bytes, 0);
    for (const [id, chat] of this.chats) {
      if (total <= this.totalBytes || id === agentId) break;
      this.chats.delete(id);
      total -= chat.bytes;
    }
    const rows = [...indexed.rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
    return { rows, reloaded, capped: indexed.capped };
  }

  forget(agentId: string): void {
    this.chats.delete(agentId);
  }
}

const rowBytes = (row: HistoryRow) => row.text.length * 2 + 200;

const epochOf = (id: string) => id.slice(id.indexOf("@") + 1);


const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const idList = (ids: readonly string[]) => `[${ids.map((id) => JSON.stringify(id)).join(", ")}]`;
const label = (row: HistoryRow) => `${row.kind}${row.tool ? ` ${row.tool}` : ""}${row.failed && row.kind === "tool" ? ", failed" : ""}${row.source ? ` · in ${row.source}` : ""}`;
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

function excerpt(row: HistoryRow, words: readonly string[]): string {
  const flat = oneLine(row.text);
  const lower = flat.toLowerCase();
  const at = words.length === 0 ? 0 : Math.max(0, Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0)));
  const start = Math.max(0, at - 40);
  const piece = flat.slice(start, start + EXCERPT_CHARS);
  return `${start > 0 ? "…" : ""}${piece}${start + EXCERPT_CHARS < flat.length ? "…" : ""}`;
}

const reference = (row: HistoryRow, words: readonly string[] = []) => `- ${row.id} · ${label(row)} · ${row.time} · ${excerpt(row, words)}`;

// Lines that fit the answer budget, and how many were left out.
function fit(head: string, lines: readonly string[], tail = "", budget = ANSWER_MAX_BYTES): string {
  let out = head;
  let left = 0;
  for (const line of lines) {
    if (bytes(`${out}\n${line}${tail ? `\n${tail}` : ""}`) > budget - 120) {
      left += 1;
      continue;
    }
    out += `\n${line}`;
  }
  if (left > 0) out += `\n(${left} more not shown: narrow the search)`;
  return tail ? `${out}\n${tail}` : out;
}

const reloadedNote = (id: string, names: HistoryNames) => `${id} is from before ${names.itemHistory} was reloaded (Paseo rebuilds it after a restart or reload, with new ids). Search again with ${names.search}.`;
// When rows of several chats are searched together, each id starts with its chat ("<chat>:<seq>@<epoch>");
// an id is compared only with its own chat's rows. A chat's own ids have no chat part.
const chatOf = (id: string) => {
  const at = id.indexOf("@");
  const seq = at < 0 ? id : id.slice(0, at);
  return seq.slice(0, seq.lastIndexOf(":") + 1);
};
const unknown = (rows: readonly HistoryRow[], id: string, names: HistoryNames) => {
  const sameChat = rows.find((row) => chatOf(row.id) === chatOf(id));
  return sameChat && epochOf(id) !== epochOf(sameChat.id) ? reloadedNote(id, names) : `No history item ${id}. Use an id from ${names.idsFrom}.`;
};

export interface SearchInput {
  query?: string;
  tools?: string[];
  files?: string[];
  failed?: boolean;
  limit?: number;
  load?: boolean;
}

// Matches, newest first: every word of `query` in the item, any of `tools`, all of `files`, and
// failed items when `failed`. With `load`, the first three are loaded and the rest named.
export function searchHistory(rows: readonly HistoryRow[], input: SearchInput, budget = ANSWER_MAX_BYTES, names = OWN_HISTORY): { text: string } {
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tools = (input.tools ?? []).map((tool) => tool.toLowerCase());
  const files = input.files ?? [];
  const matches = [...rows].reverse().filter((row) => {
    const lower = row.text.toLowerCase();
    if (!words.every((word) => lower.includes(word))) return false;
    if (tools.length > 0 && !(row.tool && tools.some((tool) => row.tool!.toLowerCase() === tool || row.tool!.toLowerCase().endsWith(`__${tool}`)))) return false;
    if (!files.every((file) => row.files.some((path) => path === file || path.endsWith(`/${file}`)) || row.text.includes(file))) return false;
    return !input.failed || row.failed;
  });
  if (matches.length === 0) return { text: `No history matches${words.length ? ` "${words.join(" ")}"` : ""} in ${names.scope} (${rows.length} items).` };
  const limit = Math.min(Math.max(1, input.limit ?? SEARCH_LIMIT), SEARCH_LIMIT_MAX);
  const shown = matches.slice(0, limit);
  const head = `${matches.length} match${matches.length === 1 ? "" : "es"} in ${names.scope}, newest first${matches.length > shown.length ? ` (showing ${shown.length})` : ""}:`;
  if (!input.load) return { text: fit(head, shown.map((row) => reference(row, words)), `Load items with ${names.load}({ ids: [...] }).`, budget) };
  const loaded = shown.slice(0, LOAD_MAX);
  const rest = shown.slice(LOAD_MAX).map((row) => row.id);
  const tail = rest.length ? `Not loaded: ${names.load}({ ids: ${idList(rest.slice(0, LOAD_MAX))} })${rest.length > LOAD_MAX ? ` and ${rest.length - LOAD_MAX} more` : ""}.` : "";
  // The references take at most half the answer, so loaded text keeps room.
  const refs = fit(head, shown.map((row) => reference(row, words)), "", Math.floor(budget / 2));
  return { text: `${loadText(loaded, budget - bytes(tail) - 8, refs, names)}${tail ? `\n${tail}` : ""}` };
}

// Items next to one item: before it, after it, or around it.
export function browseHistory(rows: readonly HistoryRow[], input: { id: string; direction: "before" | "after" | "around"; count?: number }, budget = ANSWER_MAX_BYTES): { text: string } {
  const at = rows.findIndex((row) => row.id === input.id);
  if (at < 0) return { text: unknown(rows, input.id, OWN_HISTORY) };
  const count = Math.min(Math.max(1, input.count ?? BROWSE_COUNT), BROWSE_COUNT_MAX);
  const [from, to] = input.direction === "before" ? [at - count, at] : input.direction === "after" ? [at + 1, at + 1 + count] : [at - Math.floor(count / 2), at + Math.ceil(count / 2)];
  const picked = rows.slice(Math.max(0, from), Math.min(rows.length, to));
  if (picked.length === 0) return { text: `Nothing ${input.direction} ${input.id}: it is the ${input.direction === "before" ? "first" : "last"} item.` };
  return { text: fit(`History ${input.direction} ${input.id}, oldest first:`, picked.map((row) => reference(row)), "", budget) };
}

// The items in the order asked for: each whole while they fit `budget` (head included), smallest
// first; any other as a handle for history_read. Handles are counted before any item is placed.
function loadText(items: readonly HistoryRow[], budget: number, head = "", names = OWN_HISTORY): string {
  const block = (row: HistoryRow) => `\n=== ${row.id} · ${label(row)} · ${row.time} ===\n${row.text}\n`;
  const handle = (row: HistoryRow) => `\n=== ${row.id} · ${label(row)} · ${row.time}: ${row.text.length.toLocaleString("en-US")} characters, too long to load here. Read it with ${names.read}({ id: "${row.id}" }).\n`;
  const whole = new Set<string>();
  let used = bytes(head) + items.reduce((sum, row) => sum + bytes(handle(row)), 0);
  for (const row of [...items].sort((a, b) => bytes(a.text) - bytes(b.text))) {
    const grown = used - bytes(handle(row)) + bytes(block(row));
    if (grown <= budget) {
      whole.add(row.id);
      used = grown;
    }
  }
  return `${head}${items.map((row) => (whole.has(row.id) ? block(row) : handle(row))).join("")}`.replace(/^\n/, "");
}

// Up to three items, whole while they fit; a larger one comes back as a handle for history_read.
export function loadHistory(rows: readonly HistoryRow[], ids: readonly string[], budget = ANSWER_MAX_BYTES, names = OWN_HISTORY): { text: string } {
  const notes: string[] = [];
  const items: HistoryRow[] = [];
  for (const id of ids.slice(0, LOAD_MAX)) {
    const row = rows.find((candidate) => candidate.id === id);
    if (row) items.push(row);
    else notes.push(unknown(rows, id, names));
  }
  if (ids.length > LOAD_MAX) notes.push(`Only ${LOAD_MAX} items load at a time; ask again for ${idList(ids.slice(LOAD_MAX))}.`);
  const tail = notes.join("\n");
  return { text: [loadText(items, budget - bytes(tail) - 8, "", names), tail].filter(Boolean).join("\n") };
}

// One page of an item's text, from `offset` (in characters), and where the next page starts.
export function readHistory(rows: readonly HistoryRow[], input: { id: string; offset?: number; limit?: number }, budget = ANSWER_MAX_BYTES, names = OWN_HISTORY): { text: string; body: string; next: number | null } {
  const row = rows.find((candidate) => candidate.id === input.id);
  if (!row) return { text: unknown(rows, input.id, names), body: "", next: null };
  const offset = Math.max(0, Math.min(input.offset ?? 0, row.text.length));
  let end = Math.min(row.text.length, offset + Math.min(Math.max(1, input.limit ?? 16_384), 16_384));
  const header = (to: number) => `${row.id} · characters ${offset.toLocaleString("en-US")} to ${to.toLocaleString("en-US")} of ${row.text.length.toLocaleString("en-US")}${to < row.text.length ? `. Next: ${names.read}({ id: "${row.id}", offset: ${to} })` : " (the end)"}\n`;
  // Never split a surrogate pair, and shrink until the page fits the answer budget.
  const clean = (to: number) => (to < row.text.length && /[\uD800-\uDBFF]/.test(row.text[to - 1] ?? "") ? to - 1 : to);
  // A page always moves on by at least one whole character, so paging never stalls.
  const least = Math.min(row.text.length, offset + (/[\uD800-\uDBFF]/.test(row.text[offset] ?? "") ? 2 : 1));
  end = Math.max(least, clean(end));
  while (end > least && bytes(header(end) + row.text.slice(offset, end)) > budget) end = Math.max(least, clean(offset + Math.floor((end - offset) * 0.9)));
  const body = row.text.slice(offset, end);
  return { text: header(end) + body, body, next: end < row.text.length ? end : null };
}
