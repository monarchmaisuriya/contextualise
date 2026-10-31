import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SKIPPED_FOLDERS } from "./sources";

export const MAX_WALK_ENTRIES = 50_000;

// A file's change signature outside git: modified time and size.
export function statSignature(info: { mtimeMs: number; size: number }): string {
  return `stat:${Math.trunc(info.mtimeMs)}:${info.size}`;
}

// Every file of a folder outside git and a change signature for each (modified time and size),
// which stands in for git's blob id: a file whose signature changed is read again. Hidden folders,
// dependency and build folders, and symbolic links are skipped; the walk stops after
// MAX_WALK_ENTRIES entries so a huge folder cannot stall indexing. A subfolder holding a `.git` entry
// is a repository: it is not walked but returned in `repos`, so its own tracked files can stand in.
export async function folderSignatures(top: string, maxEntries = MAX_WALK_ENTRIES): Promise<{ files: Map<string, string>; repos: string[] }> {
  const signatures = new Map<string, string>();
  const repos: string[] = [];
  const queue: string[] = [""];
  let seen = 0;
  while (queue.length > 0 && seen < maxEntries) {
    const dir = queue.shift() as string;
    // The project folder itself must be readable: an empty result would empty the index. A
    // subfolder that cannot be read is left out.
    const entries = await readdir(join(top, dir), { withFileTypes: true }).catch((error: unknown) => {
      if (dir === "") throw error;
      return [];
    });
    // A real `.git` folder or a worktree's `.git` file; a linked one could point at any repository.
    if (dir !== "" && entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      repos.push(dir);
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if ((seen += 1) > maxEntries) break;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_FOLDERS.has(entry.name.toLowerCase())) queue.push(path);
      } else if (entry.isFile()) {
        const info = await lstat(join(top, path)).catch(() => null);
        if (info) signatures.set(path, statSignature(info));
      }
    }
  }
  return { files: signatures, repos };
}
