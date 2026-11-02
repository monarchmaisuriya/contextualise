import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { folderKey, isRepoKey, type ProjectRoot, readGitRepo } from "./git";

// A folder's identity on its disk: inode and creation time (0 where the system has none). It
// survives a rename or a move on the same disk, unlike the path. The device number is recorded but
// not compared: macOS numbers a volume when it mounts it, so the same folder can have another after
// a restart.
const identitySchema = z.object({ dev: z.string(), ino: z.string(), born: z.string() });
type Identity = z.infer<typeof identitySchema>;

const entrySchema = identitySchema.extend({
  key: z.string().refine(isRepoKey, "Expected a project key such as folder/notes-0123456789ab"),
  // The folder's real path when it was last seen.
  path: z.string(),
  // A Paseo project root: agents in folders below it share its key.
  root: z.boolean(),
  // Keys this folder was also given before its identity stopped depending on the device number;
  // they now mean this entry's key.
  aliases: z.array(z.string()).default([]),
});
type Entry = z.infer<typeof entrySchema>;
const registrySchema = z.object({ version: z.literal(1), folders: z.array(entrySchema) });


async function identityOf(path: string): Promise<Identity | null> {
  const info = await stat(path, { bigint: true }).catch(() => null);
  return info ? { dev: String(info.dev), ino: String(info.ino), born: String(info.birthtimeNs) } : null;
}

function sameFolder(a: Identity, b: Identity): boolean {
  return a.ino === b.ino && a.born === b.born;
}

// Entries for one folder that got a key per device number (before the device number stopped being
// compared) folded into the first one seen, which keeps its key; the later keys become its aliases.
// Only folders with a known creation time are folded: without it, inode alone could match another.
export function foldDuplicates(entries: readonly Entry[]): { entries: Entry[]; folded: boolean } {
  const kept: Entry[] = [];
  let folded = false;
  for (const entry of entries) {
    const first = entry.born === "0" ? undefined : kept.find((candidate) => candidate.born !== "0" && sameFolder(candidate, entry));
    if (!first) {
      kept.push(entry);
      continue;
    }
    first.aliases = [...new Set([...first.aliases, entry.key, ...entry.aliases])];
    first.root ||= entry.root;
    folded = true;
  }
  return { entries: kept, folded };
}

// Copied from Memorise (memorise/server/project-keys.ts) so both plugins give a folder outside git the
// same key; plugins cannot import each other. The result type differs (ProjectRoot), and identity no
// longer compares the device number (Memorise needs the same change to keep keys equal).
// Decides which project a folder belongs to. A repo is found by git as before. A folder outside git
// keeps the key it got when first seen, recorded in folders.json in the plugin data, and is found
// again by its disk identity wherever it now is (a rename or a move on the same disk), or by its path
// where the identity is unknown. A path once held by another folder whose identity is known is not
// taken over: the order in which folders are seen never decides which folder owns a key.
// From a subfolder, the nearest Paseo project root above it is the project, unless the subfolder
// already has memories or proposals of its own. The home folder and the filesystem root are never
// project roots, and a folder where an agent merely ran claims nothing below it.
export class ProjectKeys {
  private readonly file: string;
  private entries: Entry[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  // hasData: whether a key already has memories or proposals, which keeps a folder its own project.
  constructor(
    dataRoot: string,
    private readonly hasData: (key: string) => Promise<boolean> = async () => false,
  ) {
    this.file = join(dataRoot, "folders.json");
  }

  async resolve(cwd: string): Promise<ProjectRoot> {
    const repo = await readGitRepo(cwd);
    if (repo) return repo;
    const real = await realpath(cwd);
    return this.serialize(() => this.resolveFolder(real, false));
  }

  async keyOf(cwd: string): Promise<string> {
    return (await this.resolve(cwd)).key;
  }

  // Records a folder outside git as a project root (a Paseo project's folder). A repo needs nothing;
  // the home folder and the filesystem root are refused, as they would gather unrelated folders.
  async markRoot(folder: string): Promise<void> {
    if (await readGitRepo(folder)) return;
    const real = await realpath(folder);
    if (real === dirname(real) || real === (await realpath(homedir()).catch(() => homedir()))) {
      console.log(`[contextualise] ${real} is not taken as a project root: it would gather unrelated folders`);
      return;
    }
    await this.serialize(() => this.resolveFolder(real, true));
  }

  private async resolveFolder(real: string, asRoot: boolean): Promise<ProjectRoot> {
    const entries = await this.load();
    const identity = await identityOf(real);
    if (!identity) throw new Error(`${real} cannot be read, so its project is unknown`);
    const known = identity.born !== "0";
    const seen = (known ? entries.find((entry) => sameFolder(entry, identity)) : undefined) ?? entries.find((entry) => entry.path === real && (!known || entry.born === "0"));
    if (seen) {
      const entry = await this.save({ ...seen, ...identity, path: real, root: seen.root || asRoot });
      if (!asRoot && !entry.root && !(await this.hasData(entry.key))) {
        const root = await this.rootAbove(real, entries);
        if (root) return root;
      }
      return { key: entry.key, top: real, git: false };
    }
    if (!asRoot) {
      // A folder with knowledge of its own under its first key stays its own project.
      const first = folderKey(real);
      const firstIsFree = !entries.some((entry) => entry.key === first || entry.aliases.includes(first));
      if (!(firstIsFree && (await this.hasData(first)))) {
        const root = await this.rootAbove(real, entries);
        if (root) return root;
      }
    }
    const base = folderKey(real);
    let key = base;
    for (let n = 2; entries.some((entry) => entry.key === key || entry.aliases.includes(key)); n += 1) key = `${base}-${n}`;
    await this.save({ key, path: real, root: asRoot, aliases: [], ...identity });
    return { key, top: real, git: false };
  }

  // The nearest project root above a folder, found by identity (so a moved root is still found), or
  // by path where its identity is unknown.
  private async rootAbove(real: string, entries: Entry[]): Promise<ProjectRoot | null> {
    for (let dir = real; dir !== dirname(dir); ) {
      dir = dirname(dir);
      const identity = await identityOf(dir);
      if (!identity) continue;
      const known = identity.born !== "0";
      const root = (known ? entries.find((entry) => entry.root && sameFolder(entry, identity)) : undefined) ?? entries.find((entry) => entry.root && entry.path === dir && (!known || entry.born === "0"));
      if (root) {
        if (root.path !== dir) await this.save({ ...root, path: dir });
        return { key: root.key, top: dir, git: false };
      }
    }
    return null;
  }

  // Each alias key with the key it now means.
  async aliases(): Promise<Map<string, string>> {
    const entries = await this.serialize(() => this.load());
    return new Map(entries.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.key] as const)));
  }

  private async load(): Promise<Entry[]> {
    if (this.entries) return this.entries;
    const text = await readFile(this.file, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return null;
      throw error;
    });
    let parsed: Entry[];
    try {
      parsed = text === null ? [] : registrySchema.parse(JSON.parse(text)).folders;
    } catch (error) {
      throw new Error(`${this.file} could not be read (${error instanceof Error ? error.message : String(error)}); fix or remove it to give folders outside git their project knowledge again`);
    }
    const { entries, folded } = foldDuplicates(parsed);
    this.entries = entries;
    if (folded) {
      await this.write();
      console.log(`[contextualise] folded ${parsed.length - entries.length} duplicate folder key(s) made when a disk's device number changed`);
    }
    return this.entries;
  }

  // Replaces the entry with the same key, or adds it, and writes the file.
  private async save(entry: Entry): Promise<Entry> {
    const entries = await this.load();
    const index = entries.findIndex((candidate) => candidate.key === entry.key);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
    await this.write();
    return entry;
  }

  // A temporary file renamed over the registry, so a crash never leaves half a file.
  private async write(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, folders: this.entries ?? [] }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
