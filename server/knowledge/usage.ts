import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { KNOWLEDGE_TOOLS, type KnowledgeTool, type KnowledgeUsage } from "../../shared/knowledge";
import { KnowledgeBase } from "./base";


const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 30;
const SHOWN_DAYS = 7;

const daySchema = z.object({
  given: z.number().int().min(0),
  // Short hashes of the tokens of agents that called a tool that day: a token grants index access, so
  // it is never written.
  agents: z.array(z.string()),
  calls: z.record(z.string(), z.number().int().min(0)),
});
const usageFileSchema = z.object({ days: z.record(z.string(), daySchema) });
type UsageFile = z.infer<typeof usageFileSchema>;

// How much each project's knowledge tools are used: per day, agents given the tools, agents that
// called one, and calls per tool. Counts only: no queries, paths, or agent ids. One file per project
// beside its index, rewritten whole by rename; writes for one project run one at a time.
export class UsageLog {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dir: () => Promise<string>,
    private readonly now: () => number = Date.now,
  ) {}

  recordGiven(repoKey: string): Promise<void> {
    return this.update(repoKey, (day) => {
      day.given += 1;
    });
  }

  // `agent` identifies the calling agent (its token's agent id, or the token itself); only a short
  // hash of it is written.
  recordCall(repoKey: string, tool: KnowledgeTool, agentKey: string): Promise<void> {
    const agent = createHash("sha256").update(agentKey).digest("hex").slice(0, 16);
    return this.update(repoKey, (day) => {
      day.calls[tool] = (day.calls[tool] ?? 0) + 1;
      if (!day.agents.includes(agent)) day.agents.push(agent);
    });
  }

  async lastDays(repoKey: string): Promise<KnowledgeUsage> {
    // Waits for pending writes; one that failed was reported to its own caller and changes nothing here.
    await this.queues.get(repoKey)?.catch(() => {});
    const { days } = await this.read(repoKey);
    const shown = Object.entries(days).filter(([date]) => date > this.dateOf(this.now() - SHOWN_DAYS * DAY_MS)).map(([, day]) => day);
    const calls = Object.fromEntries(KNOWLEDGE_TOOLS.map((tool) => [tool, shown.reduce((sum, day) => sum + (day.calls[tool] ?? 0), 0)])) as Record<KnowledgeTool, number>;
    return { days: SHOWN_DAYS, agentsGiven: shown.reduce((sum, day) => sum + day.given, 0), agentsUsed: new Set(shown.flatMap((day) => day.agents)).size, calls };
  }

  private update(repoKey: string, change: (day: UsageFile["days"][string]) => void): Promise<void> {
    // A failed write does not stop the next one; its own caller already got the error.
    const next = (this.queues.get(repoKey) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const file = await this.read(repoKey);
      const today = this.dateOf(this.now());
      const oldest = this.dateOf(this.now() - KEEP_DAYS * DAY_MS);
      const day = file.days[today] ?? { given: 0, agents: [], calls: {} };
      change(day);
      const days = Object.fromEntries(Object.entries({ ...file.days, [today]: day }).filter(([date]) => date > oldest));
      const path = await this.path(repoKey);
      await writeFile(`${path}.tmp`, JSON.stringify({ days }), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    this.queues.set(repoKey, next);
    return next;
  }

  // A missing file is no use yet; a damaged one is logged and counting starts again.
  private async read(repoKey: string): Promise<UsageFile> {
    const path = await this.path(repoKey);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return { days: {} };
    try {
      return usageFileSchema.parse(JSON.parse(text));
    } catch (error) {
      console.error(`[contextualise] knowledge usage for ${repoKey} could not be read, so counting starts again: ${String(error)}`);
      return { days: {} };
    }
  }

  private async path(repoKey: string): Promise<string> {
    const dir = await this.dir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return join(dir, `${KnowledgeBase.fileName(repoKey)}.usage.json`);
  }

  private dateOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
