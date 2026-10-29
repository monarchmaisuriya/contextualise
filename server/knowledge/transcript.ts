import type { AgentTimelineItem } from "../paseo-types";
import { redactSecrets } from "../secrets";

export const TRANSCRIPT_MAX_BYTES = 40 * 1024;
const TEXT_MAX_CHARS = 4_000;

export interface TranscriptSlice {
  text: string;
  userMessages: number;
  files: string[];
}

// Redacts before clipping: a secret cut in half by the clip would no longer match its pattern.
function clip(text: string, max = TEXT_MAX_CHARS): string {
  const flat = redactSecrets(text.trim());
  return flat.length > max ? `${flat.slice(0, max)} […]` : flat;
}

function describeTool(item: Extract<AgentTimelineItem, { type: "tool_call" }>, files: Set<string>): string | null {
  const detail = item.detail as { type?: string; command?: string; exitCode?: number | null; filePath?: string; query?: string } | undefined;
  switch (detail?.type) {
    case "shell":
      return `ran: ${clip(detail.command ?? "", 500)}${detail.exitCode != null ? ` (exit ${detail.exitCode})` : ""}`;
    case "read":
    case "write":
    case "edit":
      if (detail.filePath) files.add(detail.filePath);
      return `${detail.type}: ${detail.filePath ?? "?"}`;
    case "search":
      return `searched: ${clip(detail.query ?? "", 200)}`;
    default:
      return item.status === "failed" ? `tool ${item.name} failed: ${clip(item.error ? String(Reflect.get(Object(item.error), "message") ?? item.error) : "", 500)}` : null;
  }
}

// Copied from Memorise (memorise/server/transcript.ts) so both plugins send a model the same redacted
// shape of a session. What a summary worker reads: user asks, the agent's replies, commands and their exit codes, files
// touched, and errors. Reasoning and tool output bodies are left out. Secret-shaped text is replaced
// before anything leaves the plugin, and the newest turns are kept when the slice is too long.
export function sliceTranscript(items: readonly AgentTimelineItem[]): TranscriptSlice {
  const lines: string[] = [];
  const files = new Set<string>();
  let userMessages = 0;
  for (const item of items) {
    if (item.type === "user_message") {
      userMessages += 1;
      lines.push(`user: ${clip(item.text)}`);
    } else if (item.type === "assistant_message") {
      lines.push(`agent: ${clip(item.text)}`);
    } else if (item.type === "tool_call") {
      const line = describeTool(item, files);
      if (line) lines.push(`  [${line}]`);
    } else if (item.type === "error") {
      lines.push(`error: ${clip(item.message, 500)}`);
    }
  }
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = redactSecrets(lines[i]);
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > TRANSCRIPT_MAX_BYTES) break;
    kept.unshift(line);
    bytes += size;
  }
  return { text: kept.join("\n"), userMessages, files: [...files] };
}
