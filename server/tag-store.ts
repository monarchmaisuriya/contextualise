import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseLinkUrl, parseTagName, tagKey } from "../shared/contracts";

const storedAgentSchema = z.object({ agentId: z.string(), workspaceId: z.string(), taggedAt: z.string() });
const storedLinkSchema = z.object({ url: z.string(), title: z.string(), taggedAt: z.string() });
const storedTagSchema = z.object({ name: z.string(), agents: z.array(storedAgentSchema), links: z.array(storedLinkSchema) });
const storeFileSchema = z.object({ version: z.literal(2), tags: z.record(z.string(), storedTagSchema) });
// Version 1 (plugin 0.1.0) had no links. It is read and written back as version 2; an older plugin
// then refuses the file loudly instead of silently dropping links it does not know.
const storeFileV1Schema = z.object({ version: z.literal(1), tags: z.record(z.string(), storedTagSchema.omit({ links: true })) });

export type StoredAgent = z.infer<typeof storedAgentSchema>;
export type StoredLink = z.infer<typeof storedLinkSchema>;
export type StoredTag = z.infer<typeof storedTagSchema>;
export type StoredTags = Record<string, StoredTag>;
type StoreFile = z.infer<typeof storeFileSchema>;

export interface Outcome {
  tag: string;
  name: string;
  changed: boolean;
}

// Membership Paseo cannot hold for us: agents and links under a tag name. Workspace membership is
// never stored here: it is read live from Paseo's workspace labels. Writes go through one queue and
// land by rename, so parallel changes cannot lose each other and a crash cannot leave half a file.
export class TagStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly resolveRoot: () => Promise<string>) {}

  read(): Promise<StoredTags> {
    return this.enqueue(async () => (await this.load()).tags);
  }

  async add(rawNames: readonly string[], agent: { agentId: string; workspaceId: string }): Promise<Outcome[]> {
    const names = rawNames.map(parseTagName);
    return this.change(names, (tag) => {
      if (tag.agents.some((member) => member.agentId === agent.agentId)) return false;
      tag.agents.push({ ...agent, taggedAt: new Date().toISOString() });
      return true;
    });
  }

  async remove(rawNames: readonly string[], agentId: string): Promise<Outcome[]> {
    const names = rawNames.map(parseTagName);
    return this.change(names, (tag) => {
      const before = tag.agents.length;
      tag.agents = tag.agents.filter((member) => member.agentId !== agentId);
      return tag.agents.length !== before;
    });
  }

  async addLink(rawName: string, link: { url: string; title?: string }): Promise<Outcome> {
    const url = parseLinkUrl(link.url);
    const title = link.title?.trim() || new URL(url).host + new URL(url).pathname.replace(/\/$/, "");
    const [outcome] = await this.change([parseTagName(rawName)], (tag) => {
      if (tag.links.some((member) => member.url === url)) return false;
      tag.links.push({ url, title, taggedAt: new Date().toISOString() });
      return true;
    });
    return outcome;
  }

  async removeLink(rawName: string, url: string): Promise<Outcome> {
    const [outcome] = await this.change([parseTagName(rawName)], (tag) => {
      const before = tag.links.length;
      tag.links = tag.links.filter((member) => member.url !== url);
      return tag.links.length !== before;
    });
    return outcome;
  }

  // Applies `edit` to each named tag in one write. A tag left with no agents and no links is removed.
  private change(names: readonly string[], edit: (tag: StoredTag) => boolean): Promise<Outcome[]> {
    return this.enqueue(async () => {
      const file = await this.load();
      const outcomes: Outcome[] = [];
      for (const name of names) {
        const key = tagKey(name);
        const tag = file.tags[key] ?? { name, agents: [], links: [] };
        const changed = edit(tag);
        if (tag.agents.length === 0 && tag.links.length === 0) delete file.tags[key];
        else file.tags[key] = tag;
        outcomes.push({ tag: key, name: tag.name, changed });
      }
      if (outcomes.some((outcome) => outcome.changed)) await this.save(file);
      return outcomes;
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

  private async load(): Promise<StoreFile> {
    const path = await this.path();
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, tags: {} };
      throw error;
    }
    try {
      const data: unknown = JSON.parse(text);
      const v1 = storeFileV1Schema.safeParse(data);
      if (v1.success) return { version: 2, tags: Object.fromEntries(Object.entries(v1.data.tags).map(([key, tag]) => [key, { ...tag, links: [] }])) };
      return storeFileSchema.parse(data);
    } catch (error) {
      throw new Error(`Contextualise cannot read ${path}: ${(error as Error).message}. Fix or move the file; it was not changed.`);
    }
  }

  private async save(file: StoreFile): Promise<void> {
    const path = await this.path();
    await mkdir(join(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`);
    await rename(temp, path);
  }
}
