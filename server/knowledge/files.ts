import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

// Reads a project file only when it is a regular file of at most `maxBytes`, else null. A tracked or
// edited path can be a symbolic link to anything on the machine (a file outside the project, a
// folder, /dev/zero, a pipe), so links and every other kind of entry are never followed or read.
export async function readProjectFile(top: string, path: string, maxBytes: number): Promise<string | null> {
  if (path.split("/").some((part) => part === ".." || part === "")) return null;
  const file = join(top, path);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > maxBytes) return null;
  return readFile(file, "utf8");
}
