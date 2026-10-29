import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { MemoriseState, RelatedMemory } from "../../shared/knowledge";
import type { PaseoApi } from "../paseo-types";
import type { IndexChange } from "./indexer";
import { globMatches } from "./globs";
import type { CodeSymbol } from "./symbols";

// Memorise's interop contract, version 1 (memorise/INTEROP.md): a heartbeat, each project's memory
// list without text, and an inbox for replace or retire suggestions that always wait for the user.
// Contextualise only reads the first two and writes the third; every memory decision stays in Memorise.
const STALE_AFTER_MS = 10 * 60_000;
const STATE_CACHE_MS = 30_000;
export const SUGGESTIONS_PER_RUN = 5;

const statusSchema = z.object({ version: z.literal(1), writtenAt: z.iso.datetime() });
const exportedMemorySchema = z.object({
  id: z.string(),
  type: z.string(),
  subject: z.string(),
  status: z.string(),
  enabled: z.boolean(),
  paths: z.array(z.string()),
  citations: z.array(z.object({ path: z.string(), lines: z.string().optional() })),
});
export type ExportedMemory = z.infer<typeof exportedMemorySchema>;
const exportSchema = z.object({ version: z.literal(1), repoKey: z.string(), memories: z.array(exportedMemorySchema) });

export interface Suggestion {
  kind: "replace" | "retire";
  target: string;
  subject?: string;
  reason: string;
  // Identifies the evidence, so the same suggestion is never sent twice.
  key: string;
}

function aboutPath(memory: ExportedMemory, path: string): boolean {
  return memory.citations.some((citation) => citation.path === path) || memory.paths.some((glob) => globMatches(glob, path));
}

function citesLine(memory: ExportedMemory, path: string, line: number): boolean {
  return memory.citations.some((citation) => {
    if (citation.path !== path || !citation.lines) return false;
    const [start, end = start] = citation.lines.split("-").map(Number);
    return line >= start && line <= end;
  });
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`).test(text);
}

// What a re-index means for the project's memories, judged only from code: a definition a memory is
// about was renamed or removed, or an ADR it cites was superseded. File-level changes are left to
// Memorise, which already marks memories whose cited files changed.
export function memorySuggestions(changes: readonly IndexChange[], memories: readonly ExportedMemory[], hasSymbol: (name: string) => boolean): Suggestion[] {
  const active = memories.filter((memory) => memory.status === "active");
  const suggestions: Suggestion[] = [];
  for (const change of changes) {
    if (change.deleted) continue;
    if (change.kind === "code") {
      for (const removed of change.removedSymbols) {
        const sameKind = (list: readonly CodeSymbol[]) => list.filter((symbol) => symbol.kind === removed.kind);
        const added = sameKind(change.addedSymbols);
        const renamedTo = sameKind(change.removedSymbols).length === 1 && added.length === 1 && added[0].params === removed.params && added[0].shape === removed.shape ? added[0] : null;
        if (!renamedTo && hasSymbol(removed.name)) continue;
        for (const memory of active) {
          if (!aboutPath(memory, change.path)) continue;
          if (!mentions(memory.subject, removed.name) && !citesLine(memory, change.path, removed.line)) continue;
          suggestions.push(
            renamedTo
              ? {
                  kind: "replace",
                  target: memory.id,
                  subject: memory.subject.split(removed.name).join(renamedTo.name),
                  reason: `${removed.name} in ${change.path} was renamed to ${renamedTo.name}; update this memory's text to the new name.`.slice(0, 300),
                  key: `${memory.id}:renamed:${change.path}:${removed.name}:${renamedTo.name}`,
                }
              : {
                  kind: "retire",
                  target: memory.id,
                  reason: `This memory is about ${removed.name} in ${change.path}, which no longer exists anywhere in the repository.`.slice(0, 300),
                  key: `${memory.id}:removed:${change.path}:${removed.name}`,
                },
          );
        }
      }
    } else if (change.kind === "adr" && change.adrAfter?.status === "superseded" && change.adrBefore?.status !== "superseded") {
      const by = change.adrAfter.supersededBy;
      for (const memory of active) {
        if (!aboutPath(memory, change.path)) continue;
        suggestions.push({
          kind: "retire",
          target: memory.id,
          reason: `This memory cites ${change.path}, which is now superseded${by ? ` by ${by}` : ""}.`.slice(0, 300),
          key: `${memory.id}:superseded:${change.path}`,
        });
      }
    }
  }
  return suggestions;
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, path);
}

export class MemoriseLink {
  private cachedState: { state: MemoriseState; at: number } | null = null;
  private readonly exports = new Map<string, { mtimeMs: number; memories: ExportedMemory[] }>();

  constructor(
    // Memorise's data folder and Contextualise's own, both under the Paseo home.
    private readonly roots: () => Promise<{ memorise: string; own: string }>,
    private readonly now: () => number = Date.now,
  ) {}

  private async interopDir(): Promise<string> {
    return join((await this.roots()).memorise, "interop", "v1");
  }

  // Turned off in the daemon config wins, since a stopped Memorise leaves its last heartbeat behind.
  // Otherwise the heartbeat decides: it proves Memorise runs and speaks version 1, whatever id it was
  // installed under. Without one, the config only words the note.
  async state(paseo: PaseoApi): Promise<MemoriseState> {
    if (this.cachedState && this.now() - this.cachedState.at < STATE_CACHE_MS) return this.cachedState.state;
    const { config } = await paseo.config.get();
    const entry = config.plugins?.memorise;
    let state: MemoriseState;
    if (entry?.enabled === false) state = "disabled";
    else {
      const fresh = await readFile(join(await this.interopDir(), "status.json"), "utf8")
        .then((text) => this.now() - Date.parse(statusSchema.parse(JSON.parse(text)).writtenAt) < STALE_AFTER_MS)
        .catch(() => false);
      state = fresh ? "available" : entry ? "needs-update" : "not-installed";
    }
    this.cachedState = { state, at: this.now() };
    return state;
  }

  async memories(repoKey: string): Promise<ExportedMemory[]> {
    const file = join(await this.interopDir(), "export", `${repoKey}.json`);
    const mtimeMs = await stat(file).then((info) => info.mtimeMs, () => -1);
    if (mtimeMs < 0) return [];
    const cached = this.exports.get(repoKey);
    if (cached?.mtimeMs === mtimeMs) return cached.memories;
    const parsed = exportSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success || parsed.data.repoKey !== repoKey) {
      console.error(`[contextualise] ignored Memorise's export for ${repoKey}: it does not match interop version 1`);
      return [];
    }
    const memories = parsed.data.memories.filter((memory) => memory.status === "active" && memory.enabled);
    this.exports.set(repoKey, { mtimeMs, memories });
    return memories;
  }

  async related(repoKey: string, path: string): Promise<RelatedMemory[]> {
    return (await this.memories(repoKey)).filter((memory) => aboutPath(memory, path)).map(({ id, subject }) => ({ id, subject }));
  }

  private async sentFile(): Promise<string> {
    return join((await this.roots()).own, "knowledge", "memorise-suggestions-sent.json");
  }

  // Writes up to SUGGESTIONS_PER_RUN new suggestions to Memorise's inbox. A suggestion is never sent
  // twice, so a rejected one does not come back on the next re-index.
  async send(repoKey: string, suggestions: readonly Suggestion[]): Promise<number> {
    const sentPath = await this.sentFile();
    const sent = new Set<string>(JSON.parse(await readFile(sentPath, "utf8").catch(() => "[]")) as string[]);
    const fresh = suggestions.filter((suggestion) => !sent.has(suggestion.key)).slice(0, SUGGESTIONS_PER_RUN);
    const inbox = join(await this.interopDir(), "inbox", ...repoKey.split("/"));
    for (const suggestion of fresh) {
      const file = { version: 1, from: "contextualise", kind: suggestion.kind, targets: [suggestion.target], reason: suggestion.reason, ...(suggestion.subject ? { subject: suggestion.subject } : {}) };
      await writeAtomically(join(inbox, `contextualise-${this.now()}-${randomBytes(3).toString("hex")}.json`), JSON.stringify(file, null, 2));
      sent.add(suggestion.key);
    }
    if (fresh.length > 0) await writeAtomically(sentPath, JSON.stringify([...sent]));
    return fresh.length;
  }
}
