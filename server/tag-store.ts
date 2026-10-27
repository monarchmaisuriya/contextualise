import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseTagName, tagKey } from "../shared/contracts";

const storedAgentSchema = z.object({ agentId: z.string(), workspaceId: z.string(), taggedAt: z.string() });
const storedTagSchema = z.object({ name: z.string(), agents: z.array(storedAgentSchema) });
const storeFileSchema = z.object({ version: z.literal(1), tags: z.record(z.string(), storedTagSchema) });

export type StoredAgent = z.infer<typeof storedAgentSchema>;
export type StoredTag = z.infer<typeof storedTagSchema>;
export type StoredTags = Record<string, StoredTag>;

// Agent membership of tags, the one fact Paseo cannot hold for us. Workspace membership is never
// stored here: it is read live from Paseo's workspace labels. Writes go through one queue and land
// by rename, so parallel adds cannot lose each other and a crash cannot leave half a file.
export class TagStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly resolveRoot: () => Promise<string>) {}

  read(): Promise<StoredTags> {
    return this.enqueue(async () => (await this.load()).tags);
  }

  async add(rawName: string, agent: { agentId: string; workspaceId: string }): Promise<{ tag: string; added: boolean }> {
    const name = parseTagName(rawName);
    return this.enqueue(async () => {
      const file = await this.load();
      const key = tagKey(name);
      const tag = (file.tags[key] ??= { name, agents: [] });
      if (tag.agents.some((member) => member.agentId === agent.agentId)) return { tag: key, added: false };
      tag.agents.push({ ...agent, taggedAt: new Date().toISOString() });
      await this.save(file);
      return { tag: key, added: true };
    });
  }

  async remove(rawName: string, agentId: string): Promise<{ tag: string; removed: boolean }> {
    const key = tagKey(parseTagName(rawName));
    return this.enqueue(async () => {
      const file = await this.load();
      const tag = file.tags[key];
      const remaining = tag?.agents.filter((member) => member.agentId !== agentId);
      if (!tag || !remaining || remaining.length === tag.agents.length) return { tag: key, removed: false };
      if (remaining.length === 0) delete file.tags[key];
      else tag.agents = remaining;
      await this.save(file);
      return { tag: key, removed: true };
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async path(): Promise<string> {
    return join(await this.resolveRoot(), "tags.json");
  }

  private async load(): Promise<z.infer<typeof storeFileSchema>> {
    const path = await this.path();
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tags: {} };
      throw error;
    }
    try {
      return storeFileSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new Error(`Contextualise cannot read ${path}: ${(error as Error).message}. Fix or move the file; it was not changed.`);
    }
  }

  private async save(file: z.infer<typeof storeFileSchema>): Promise<void> {
    const path = await this.path();
    await mkdir(join(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`);
    await rename(temp, path);
  }
}
