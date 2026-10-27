import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { type ItemRef, NOTE_MAX_CHARS, noteMemberSchema, parseLinkUrl, parseTagName, tagKey } from "../shared/contracts";

const storedAgentSchema = z.object({ agentId: z.string(), workspaceId: z.string(), taggedAt: z.string() });
const storedLinkSchema = z.object({ url: z.string(), title: z.string(), taggedAt: z.string() });
const storedTagSchema = z.object({ name: z.string(), agents: z.array(storedAgentSchema), links: z.array(storedLinkSchema), notes: z.array(noteMemberSchema) });
const storedPinSchema = z.object({ agentId: z.string(), pinnedAt: z.string() });
const storeFileSchema = z.object({ version: z.literal(4), tags: z.record(z.string(), storedTagSchema), pinnedAgents: z.array(storedPinSchema) });
// Older files are read and written back as version 4: version 1 (0.1.0) had no links, version 2
// (0.2.0 to 0.5.0) had no notes, version 3 (0.6.0 to 0.10.0) had no pinned agents. An older plugin
// then refuses the file loudly instead of silently dropping what it does not know.
const storeFileV3Schema = z.object({ version: z.literal(3), tags: z.record(z.string(), storedTagSchema) });
const storeFileV1Schema = z.object({ version: z.literal(1), tags: z.record(z.string(), storedTagSchema.omit({ links: true, notes: true })) });
const storeFileV2Schema = z.object({ version: z.literal(2), tags: z.record(z.string(), storedTagSchema.omit({ notes: true })) });

export type StoredAgent = z.infer<typeof storedAgentSchema>;
export type StoredLink = z.infer<typeof storedLinkSchema>;
export type StoredNote = z.infer<typeof noteMemberSchema>;
export type StoredPin = z.infer<typeof storedPinSchema>;
export type StoredTag = z.infer<typeof storedTagSchema>;
export type StoredTags = Record<string, StoredTag>;
type StoreFile = z.infer<typeof storeFileSchema>;

export interface Outcome {
  tag: string;
  name: string;
  changed: boolean;
}

export type NotePatch = Partial<Pick<StoredNote, "title" | "url" | "status" | "text" | "error" | "fetchedAt" | "provider" | "notifyAgentId">>;

// Membership Paseo cannot hold for us: agents and links under a tag name. Workspace membership is
// never stored here: it is read live from Paseo's workspace labels. Writes go through one queue and
// land by rename, so parallel changes cannot lose each other and a crash cannot leave half a file.
export class TagStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly resolveRoot: () => Promise<string>) {}

  read(): Promise<StoredTags> {
    return this.enqueue(async () => (await this.load()).tags);
  }

  pinnedAgents(): Promise<StoredPin[]> {
    return this.enqueue(async () => (await this.load()).pinnedAgents);
  }

  // Pinned agents come first in Attach > Agent conversation; the order is the order they were pinned.
  pinAgent(agentId: string, pinned: boolean): Promise<{ pinned: boolean; changed: boolean }> {
    return this.enqueue(async () => {
      const file = await this.load();
      const has = file.pinnedAgents.some((pin) => pin.agentId === agentId);
      if (has === pinned) return { pinned, changed: false };
      file.pinnedAgents = pinned ? [...file.pinnedAgents, { agentId, pinnedAt: new Date().toISOString() }] : file.pinnedAgents.filter((pin) => pin.agentId !== agentId);
      await this.save(file);
      return { pinned, changed: true };
    });
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

  // Adds an item in the "fetching" state; the same reference twice in one tag is one note.
  async addNote(rawName: string, item: ItemRef): Promise<Outcome & { noteId: string }> {
    let noteId = "";
    const [outcome] = await this.change([parseTagName(rawName)], (tag) => {
      const existing = tag.notes.find((note) => note.vendor === item.vendor && note.ref === item.ref);
      if (existing) {
        noteId = existing.id;
        return false;
      }
      noteId = randomUUID();
      tag.notes.push({ id: noteId, vendor: item.vendor, ref: item.ref, title: item.ref, url: null, status: "fetching", text: "", error: null, addedAt: new Date().toISOString(), fetchedAt: null, provider: null, notifyAgentId: null });
      return true;
    });
    return { ...outcome, noteId };
  }

  // Changes one note in place. The text is capped here, the one place notes are written.
  async updateNote(rawName: string, noteId: string, patch: NotePatch, maxChars = NOTE_MAX_CHARS): Promise<Outcome> {
    const [outcome] = await this.change([parseTagName(rawName)], (tag) => {
      const note = tag.notes.find((candidate) => candidate.id === noteId);
      if (!note) return false;
      Object.assign(note, patch, patch.text === undefined ? {} : { text: patch.text.length > maxChars ? `${patch.text.slice(0, maxChars - 4)} […]` : patch.text });
      return true;
    });
    return outcome;
  }

  async removeNote(rawName: string, noteId: string): Promise<Outcome> {
    const [outcome] = await this.change([parseTagName(rawName)], (tag) => {
      const before = tag.notes.length;
      tag.notes = tag.notes.filter((note) => note.id !== noteId);
      return tag.notes.length !== before;
    });
    return outcome;
  }

  // A fetch cut off by a plugin or daemon restart never reports back; its note is marked failed.
  async failInterruptedFetches(): Promise<number> {
    return this.enqueue(async () => {
      const file = await this.load();
      let count = 0;
      for (const tag of Object.values(file.tags))
        for (const note of tag.notes)
          if (note.status === "fetching") {
            Object.assign(note, { status: "failed", error: "interrupted by a restart; press Refresh to fetch again" });
            count += 1;
          }
      if (count > 0) await this.save(file);
      return count;
    });
  }

  // Applies `edit` to each named tag in one write. A tag left with no agents, links, or notes is removed.
  private change(names: readonly string[], edit: (tag: StoredTag) => boolean): Promise<Outcome[]> {
    return this.enqueue(async () => {
      const file = await this.load();
      const outcomes: Outcome[] = [];
      for (const name of names) {
        const key = tagKey(name);
        const tag = file.tags[key] ?? { name, agents: [], links: [], notes: [] };
        const changed = edit(tag);
        if (tag.agents.length === 0 && tag.links.length === 0 && tag.notes.length === 0) delete file.tags[key];
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 4, tags: {}, pinnedAgents: [] };
      throw error;
    }
    try {
      const data: unknown = JSON.parse(text);
      const v1 = storeFileV1Schema.safeParse(data);
      if (v1.success) return { version: 4, tags: Object.fromEntries(Object.entries(v1.data.tags).map(([key, tag]) => [key, { ...tag, links: [], notes: [] }])), pinnedAgents: [] };
      const v2 = storeFileV2Schema.safeParse(data);
      if (v2.success) return { version: 4, tags: Object.fromEntries(Object.entries(v2.data.tags).map(([key, tag]) => [key, { ...tag, notes: [] }])), pinnedAgents: [] };
      const v3 = storeFileV3Schema.safeParse(data);
      if (v3.success) return { version: 4, tags: v3.data.tags, pinnedAgents: [] };
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
