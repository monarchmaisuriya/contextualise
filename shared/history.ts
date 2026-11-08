import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Chat history: a chat's own earlier history, recoverable word for word with Paseo tools after its
// context is compacted. /history reports and switches it for one chat.

// The row Contextualise adds to a chat (after a compaction, or for /history); it is shown to M, not
// sent to the model.
export const HISTORY_ROW_KIND = "history-note";
export const historyNoteSchema = z.object({ title: z.string().max(300), lines: z.array(z.string().max(500)).max(10) });
export type HistoryNote = z.infer<typeof historyNoteSchema>;

// /history, /history status, /history on, /history off: adds a status row to the chat.
export const historyCommandRpc = defineRpc({
  name: "history.command",
  input: z.object({ agentId: z.string().min(1).max(200), action: z.enum(["status", "on", "off"]) }),
  output: historyNoteSchema,
});

export function parseHistoryCommand(args: string): "status" | "on" | "off" {
  const word = args.trim().toLowerCase();
  if (word === "" || word === "status" || word === "stats") return "status";
  if (word === "on" || word === "off") return word;
  throw new Error(`Use /history, /history on, or /history off (not "${args.trim()}")`);
}
