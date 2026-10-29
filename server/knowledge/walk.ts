import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SKIPPED_FOLDERS } from "./sources";

export const MAX_WALK_ENTRIES = 50_000;

// Every file of a folder outside git and a change signature for each (modified time and size),
// which stands in for git's blob id: a file whose signature changed is read again. Hidden folders,
// dependency and build folders, and symbolic links are skipped; the walk stops after
// MAX_WALK_ENTRIES entries so a huge folder cannot stall indexing.
export async function folderSignatures(top: string, maxEntries = MAX_WALK_ENTRIES): Promise<Map<string, string>> {
  const signatures = new Map<string, string>();
  const queue: string[] = [""];
  let seen = 0;
  while (queue.length > 0 && seen < maxEntries) {
    const dir = queue.shift() as string;
    const entries = await readdir(join(top, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if ((seen += 1) > maxEntries) break;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_FOLDERS.has(entry.name.toLowerCase())) queue.push(path);
      } else if (entry.isFile()) {
        const info = await lstat(join(top, path)).catch(() => null);
        if (info) signatures.set(path, `stat:${Math.trunc(info.mtimeMs)}:${info.size}`);
      }
    }
  }
  return signatures;
}
