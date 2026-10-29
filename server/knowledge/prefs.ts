import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export const MAX_PINS = 20;

const prefsSchema = z.object({
  // Off: agents in the project get no map, no tools, no task log, and nothing generated.
  enabled: z.boolean().default(true),
  // Entries always listed in the project map, in the order they were pinned.
  pins: z.array(z.string().min(1).max(600)).max(MAX_PINS).default([]),
});
export type ProjectPrefs = z.infer<typeof prefsSchema>;
const fileSchema = z.object({ version: z.literal(1), projects: z.record(z.string(), prefsSchema) });

// The user's per-project choices, in knowledge/projects.json. Writes are serialized and atomic.
export class ProjectPrefsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: () => Promise<string>) {}

  private async file(): Promise<string> {
    return join(await this.dir(), "projects.json");
  }

  private async load(): Promise<Record<string, ProjectPrefs>> {
    const path = await this.file();
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return null;
      throw error;
    });
    if (text === null) return {};
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`${path} could not be read (${parsed.error.issues[0]?.message}); fix or remove it to reset project settings`);
    return parsed.data.projects;
  }

  async get(key: string): Promise<ProjectPrefs> {
    return (await this.load())[key] ?? prefsSchema.parse({});
  }

  update(key: string, change: (current: ProjectPrefs) => ProjectPrefs): Promise<ProjectPrefs> {
    const next = this.queue.then(async () => {
      const projects = await this.load();
      projects[key] = prefsSchema.parse(change(projects[key] ?? prefsSchema.parse({})));
      const path = await this.file();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, path);
      return projects[key];
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  setEnabled(key: string, enabled: boolean): Promise<ProjectPrefs> {
    return this.update(key, (current) => ({ ...current, enabled }));
  }

  setPinned(key: string, id: string, pinned: boolean): Promise<ProjectPrefs> {
    return this.update(key, (current) => {
      const others = current.pins.filter((pin) => pin !== id);
      if (pinned && others.length >= MAX_PINS) throw new Error(`At most ${MAX_PINS} entries can be pinned to a project's map; unpin one first`);
      return { ...current, pins: pinned ? [...others, id] : others };
    });
  }
}
