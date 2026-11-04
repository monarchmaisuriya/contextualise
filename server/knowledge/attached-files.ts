import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginAttachmentItem } from "@getpaseo/plugin";
import type { SnapshotSettings } from "../../shared/contracts";
import { SNAPSHOT_HEADER } from "../snapshot";
import { git, GitError } from "./git";
import { folderSignatures, MAX_WALK_ENTRIES } from "./walk";

// Attach > Project file: files and folders of attached projects, offered by path. A row attaches a
// reference, not the content: Paseo's picker searches again on every keystroke, so rows stay small,
// and the chat reads the file itself, as it does for a path from `@`.

// A listing is kept this long, so typing reuses it.
export const LISTING_TTL_MS = 10_000;
// The picker gets at most this many rows.
export const PICKER_ROWS = 30;
// Listing a big repository's untracked files can take seconds; the indexer allows the same.
const LIST_TIMEOUT_MS = 20_000;

export interface AttachedFolder {
  // The real path of the attached folder.
  path: string;
  name: string;
}

export interface FolderEntry {
  folder: AttachedFolder;
  // Inside the attached folder, "/"-separated; "" is the folder itself.
  path: string;
  kind: "file" | "folder";
}

const notARepository = (error: unknown) => error instanceof GitError && /not a git repository/i.test(error.stderr);
// Repositories inside repositories are listed this deep.
const MAX_NESTING = 3;

const lsFiles = async (folder: string, args: readonly string[]) => (await git(folder, ["ls-files", ...args, "-z"], LIST_TIMEOUT_MS)).split("\0").filter((line) => line !== "");

// A repository's tracked files (once each: a conflicted file has a line per stage) and untracked ones,
// without gitignored ones. Git lists a submodule as one entry (mode 160000) and an untracked nested
// repository as "<folder>/", without their files, so those are listed the same way and added.
async function gitFiles(folder: string, depth = 0): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([lsFiles(folder, ["--stage"]), lsFiles(folder, ["--others", "--exclude-standard"])]);
  const files = new Set<string>();
  const nested: string[] = [];
  for (const line of tracked) {
    const path = line.slice(line.indexOf("\t") + 1);
    if (line.startsWith("160000 ")) nested.push(path);
    else files.add(path);
  }
  for (const path of untracked) {
    if (path.endsWith("/")) nested.push(path.slice(0, -1));
    else files.add(path);
  }
  const found = [...files];
  if (depth < MAX_NESTING) for (const repo of nested) found.push(...(await nestedFiles(folder, repo, depth + 1)));
  return found;
}

// A nested repository's files, prefixed with its folder. One that is not checked out (an empty
// submodule folder, where git would answer for the outer repository) or cannot be listed adds nothing,
// and the rest of the folder is still listed.
async function nestedFiles(folder: string, repo: string, depth: number): Promise<string[]> {
  if (!(await lstat(join(folder, repo, ".git")).catch(() => null))) return [];
  try {
    return (await gitFiles(join(folder, repo), depth)).map((path) => `${repo}/${path}`);
  } catch (error) {
    console.error(`[contextualise] could not list the repository ${join(folder, repo)} for Attach > Project file: ${String(error)}`);
    return [];
  }
}

// A folder's files, relative to it, as `@` would offer them: in git, tracked and untracked files
// without gitignored ones, nested repositories included; outside git, or in a folder its repository
// ignores (git lists nothing there), every file but hidden ones, and each nested repository the git
// way. At most MAX_WALK_ENTRIES.
export async function listFolderFiles(folder: string): Promise<string[]> {
  let files: string[] = [];
  try {
    files = await gitFiles(folder);
  } catch (error) {
    if (!notARepository(error)) throw error;
  }
  if (files.length === 0) {
    const walked = await folderSignatures(folder);
    files = [...walked.files.keys()].filter((path) => !path.split("/").some((part) => part.startsWith(".")));
    for (const repo of walked.repos) files.push(...(await nestedFiles(folder, repo, 1)));
  }
  return files.slice(0, MAX_WALK_ENTRIES);
}

// Listings by folder, each fresh for `ttlMs` and shared by searches that overlap. Once a listing
// expires, the next search starts a new one and the old one answers until it is ready, so typing
// never waits for a folder to be listed again. A failed listing is not kept. Listings unused for a
// minute are dropped.
export class FolderListings {
  private readonly kept = new Map<string, { at: number; files: Promise<string[]>; ready: string[] | null; previous: string[] | null }>();

  constructor(
    private readonly list: (folder: string) => Promise<string[]> = listFolderFiles,
    private readonly ttlMs = LISTING_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  files(folder: string): Promise<string[]> {
    const now = this.now();
    const found = this.kept.get(folder);
    if (found && now - found.at <= this.ttlMs) return found.ready ? Promise.resolve(found.ready) : found.previous ? Promise.resolve(found.previous) : found.files;
    for (const [key, entry] of this.kept) if (now - entry.at > this.ttlMs * 6) this.kept.delete(key);
    const entry = { at: now, files: this.list(folder), ready: null as string[] | null, previous: found?.ready ?? null };
    this.kept.set(folder, entry);
    entry.files.then(
      (files) => {
        entry.ready = files;
      },
      () => {
        if (this.kept.get(folder) === entry) this.kept.delete(folder);
      },
    );
    return entry.previous ? Promise.resolve(entry.previous) : entry.files;
  }
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Every file and the folders that hold them.
function entriesOf(folder: AttachedFolder, files: readonly string[]): FolderEntry[] {
  const folders = new Set<string>();
  for (const file of files) for (let cut = file.indexOf("/"); cut > 0; cut = file.indexOf("/", cut + 1)) folders.add(file.slice(0, cut));
  return [...[...folders].map((path) => ({ folder, path, kind: "folder" as const })), ...files.map((path) => ({ folder, path, kind: "file" as const }))];
}

// How well an entry matches the typed words, lower first; null when it does not. A word may match the
// project's name or the path, never across the two: Paseo's own filter matches each word inside one
// field of the row, and the row's subtitle shows them as "<project> · <path>".
function tier(entry: FolderEntry, words: readonly string[]): number | null {
  const phrase = words.join(" ");
  const name = nameOf(entry.path).toLowerCase();
  const path = `${entry.folder.name} ${entry.path}`.toLowerCase();
  if (name === phrase) return 0;
  if (name.startsWith(phrase)) return 1;
  if (name.includes(phrase)) return 2;
  if (path.includes(phrase)) return 3;
  if (words.every((word) => path.includes(word))) return 4;
  return null;
}

// The entries to offer, best first: with no words, each attached folder and then, folder by folder,
// its top-level subfolders and files; with words, by how well the name and then the path match, then
// shorter paths, then alphabetically.
export function rankEntries(listings: readonly { folder: AttachedFolder; files: readonly string[] }[], query: string, limit: number): FolderEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) {
    const roots = listings.map(({ folder }) => ({ folder, path: "", kind: "folder" as const }));
    const top = listings.flatMap(({ folder, files }) => {
      const entries = entriesOf(folder, files).filter((entry) => !entry.path.includes("/"));
      const byName = (a: FolderEntry, b: FolderEntry) => a.path.localeCompare(b.path);
      return [...entries.filter((entry) => entry.kind === "folder").sort(byName), ...entries.filter((entry) => entry.kind === "file").sort(byName)];
    });
    return [...roots, ...top].slice(0, limit);
  }
  const scored: { entry: FolderEntry; tier: number }[] = [];
  for (const { folder, files } of listings) {
    for (const entry of entriesOf(folder, files)) {
      const found = tier(entry, words);
      if (found !== null) scored.push({ entry, tier: found });
    }
  }
  scored.sort((a, b) => a.tier - b.tier || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, limit).map(({ entry }) => entry);
}

// A path cut from the start to `maxChars`, keeping whole trailing parts, so the name stays readable.
function capStart(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  const parts = path.split("/");
  let kept = parts.pop() as string;
  if (kept.length + 2 > maxChars) return `…${kept.slice(-(maxChars - 1))}`;
  while (parts.length > 0 && (parts.at(-1) as string).length + kept.length + 3 <= maxChars) kept = `${parts.pop()}/${kept}`;
  return `…/${kept}`;
}

// A file or folder found for a search: where it is, and how its row reads.
export interface FoundEntry extends FolderEntry {
  absolute: string;
  title: string;
  subtitle: string;
}

// Rows whose titles read the same (one name under folders of one name, cut to the same end, or one
// path in two projects) are retitled by the nearest folder where their paths differ, the project's
// name counting as the top folder: "email-automation/…/useActivateAutomation.ts". Telling them apart
// matters more than the title limit, so such a title may pass it.
function tellApart(found: readonly FoundEntry[]): void {
  const byTitle = new Map<string, FoundEntry[]>();
  for (const entry of found) byTitle.set(entry.title, [...(byTitle.get(entry.title) ?? []), entry]);
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const parts = group.map((entry) => [entry.folder.name, ...(entry.path === "" ? [] : entry.path.split("/"))]);
    const sharedEnd = (a: readonly string[], b: readonly string[]) => {
      let shared = 0;
      while (shared < a.length && shared < b.length && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared += 1;
      return shared;
    };
    group.forEach((entry, index) => {
      const own = parts[index];
      const shared = Math.max(...parts.map((other, at) => (at === index ? 0 : sharedEnd(own, other))));
      if (shared >= own.length) return;
      const differs = own[own.length - 1 - shared];
      const name = own[own.length - 1];
      entry.title = shared === 0 ? name : shared === 1 ? `${differs}/${name}` : `${differs}/…/${name}`;
    });
  }
}

// The files and folders of the attached folders that match a search, best first: the title is the
// path in the project, the subtitle the project and that full path. A folder that cannot be listed is
// logged and left out. Each entry is checked on disk: a file deleted since it was listed is dropped,
// and anything that is a folder now (a link to a folder) is offered as one. A path found through two
// attached folders (one inside the other) is offered once, where it ranks best.
export async function findAttachedFiles(folders: readonly AttachedFolder[], listings: FolderListings, query: string, titleMaxChars: number): Promise<FoundEntry[]> {
  const listed = await Promise.all(
    folders.map(async (folder) => {
      try {
        return { folder, files: await listings.files(folder.path) };
      } catch (error) {
        console.error(`[contextualise] could not list attached folder ${folder.path} for its files: ${String(error)}`);
        return null;
      }
    }),
  );
  const ranked = rankEntries(listed.filter((entry) => entry !== null), query, PICKER_ROWS * 2);
  const present = await Promise.all(
    ranked.map(async (entry) => {
      const absolute = entry.path === "" ? entry.folder.path : join(entry.folder.path, entry.path);
      const info = await stat(absolute).catch(() => null);
      return info ? { ...entry, absolute, kind: info.isDirectory() ? ("folder" as const) : ("file" as const) } : null;
    }),
  );
  const found = new Map<string, FoundEntry>();
  for (const entry of present) {
    if (!entry || found.size >= PICKER_ROWS || found.has(entry.absolute)) continue;
    found.set(entry.absolute, {
      ...entry,
      title: capStart(entry.path === "" ? entry.folder.name : entry.path, titleMaxChars),
      subtitle: `${entry.folder.name} · ${entry.path === "" ? "attached folder" : entry.path}`,
    });
  }
  tellApart([...found.values()]);
  return [...found.values()];
}

// Attach > Project file rows. Paseo keeps a row only when the typed words match its identifier and
// title or its id, or its subtitle (app/src/components/ui/combobox-options.ts), so the id is the
// absolute path and the subtitle the full path in the project. Paths are written as JSON strings:
// exact, and on one line.
export async function searchAttachedFiles(folders: readonly AttachedFolder[], listings: FolderListings, query: string, options: { titleMaxChars: number; prefix: SnapshotSettings["pickerPrefix"] }): Promise<PluginAttachmentItem[]> {
  return (await findAttachedFiles(folders, listings, query, options.titleMaxChars)).map((entry) => {
    const where = entry.path === "" ? `the attached project ${JSON.stringify(entry.folder.name)} itself` : `${JSON.stringify(entry.path)} in the attached project ${JSON.stringify(entry.folder.name)}`;
    const line =
      entry.kind === "file"
        ? `File ${JSON.stringify(entry.absolute)}: ${where}. Its content is not included: read it from that path.`
        : `Folder ${JSON.stringify(entry.absolute)}: ${where}. Its files are not listed: list or read them from that path.`;
    return {
      id: entry.absolute,
      identifier: options.prefix === "word" ? (entry.kind === "file" ? "File" : "Folder") : "",
      title: entry.title,
      subtitle: entry.subtitle,
      url: pathToFileURL(entry.absolute).href,
      text: `${SNAPSHOT_HEADER}\n\n${line}`,
      resourceType: "attached-file",
    };
  });
}
