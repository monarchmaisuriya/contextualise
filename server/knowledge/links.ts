import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { z } from "zod";

// A workspace may link this many folders; each one is added to every new chat there.
export const MAX_LINKS = 5;

const linkSchema = z.object({
  // A real path (symlinks resolved when it was added).
  path: z.string().min(1).max(1_000),
  // The project key Contextualise gives the folder, for its knowledge; null when it has none.
  repoKey: z.string().min(1).max(600).nullable(),
  addedAt: z.string(),
});
export type WorkspaceLink = z.infer<typeof linkSchema>;
const fileSchema = z.object({ version: z.literal(1), workspaces: z.record(z.string(), z.array(linkSchema).max(MAX_LINKS)) });

const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

// The folder M asked to link, as a real path, or why it cannot be linked. A link adds the whole
// folder to every chat in the workspace, so the home folder, the filesystem root, the workspace's own
// folder, and any folder that holds it or sits inside it are refused. So is Paseo's own data folder
// (`protectedFolders`): write access there would let a chat change Paseo's settings or forge the
// knowledge tools' tokens.
export async function linkableFolder(path: string, workspaceFolder: string, protectedFolders: readonly string[] = []): Promise<string> {
  const given = path.trim().replace(/^~(?=\/|$)/, homedir());
  const real = await realpath(given).catch(() => {
    throw new Error(`${given} does not exist`);
  });
  if (!(await stat(real)).isDirectory()) throw new Error(`${real} is not a folder`);
  if (real === sep || real === (await realpath(homedir()))) throw new Error(`${real} is too broad to link; link a project folder inside it`);
  const own = await realpath(workspaceFolder).catch(() => workspaceFolder);
  if (within(own, real) || within(real, own)) throw new Error(`${real} overlaps this workspace's own folder, which chats here can already edit`);
  for (const folder of protectedFolders) {
    const kept = await realpath(folder).catch(() => folder);
    if (within(kept, real) || within(real, kept)) throw new Error(`${real} overlaps Paseo's own data folder (${kept}), which cannot be linked`);
  }
  return real;
}

// Folders linked to each Paseo workspace, in knowledge/links.json. Writes are serialized and atomic.
export class WorkspaceLinks {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: () => Promise<string>) {}

  private async file(): Promise<string> {
    return join(await this.dir(), "links.json");
  }

  private async load(): Promise<Record<string, WorkspaceLink[]>> {
    const path = await this.file();
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return null;
      throw error;
    });
    if (text === null) return {};
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`${path} could not be read (${parsed.error.issues[0]?.message}); fix or remove it to clear linked projects`);
    return parsed.data.workspaces;
  }

  // The workspaces that have at least one link.
  async workspaceIds(): Promise<string[]> {
    return Object.keys(await this.load());
  }

  async list(workspaceId: string): Promise<WorkspaceLink[]> {
    return (await this.load())[workspaceId] ?? [];
  }

  private update(workspaceId: string, change: (current: WorkspaceLink[]) => WorkspaceLink[]): Promise<WorkspaceLink[]> {
    const next = this.queue.then(async () => {
      const workspaces = await this.load();
      const links = change(workspaces[workspaceId] ?? []);
      if (links.length > 0) workspaces[workspaceId] = links;
      else delete workspaces[workspaceId];
      const path = await this.file();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(fileSchema.parse({ version: 1, workspaces }), null, 2)}\n`, { mode: 0o600 });
      await rename(temp, path);
      return links;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  add(workspaceId: string, link: WorkspaceLink): Promise<WorkspaceLink[]> {
    return this.update(workspaceId, (current) => {
      if (current.some((existing) => existing.path === link.path)) throw new Error(`${link.path} is already linked here`);
      if (current.length >= MAX_LINKS) throw new Error(`A workspace can link at most ${MAX_LINKS} folders; remove one first`);
      return [...current, link];
    });
  }

  remove(workspaceId: string, path: string): Promise<WorkspaceLink[]> {
    return this.update(workspaceId, (current) => {
      if (!current.some((existing) => existing.path === path)) throw new Error(`${path} is not linked here`);
      return current.filter((existing) => existing.path !== path);
    });
  }
}

// Folder options for the chat's provider, merged with any already set. Only Claude and Codex are
// known: Paseo checks each provider's options strictly and fails the chat on a key it does not know,
// so any other provider gets nothing (null).
export function linkedProviderOptions(provider: string, existing: Record<string, unknown> | undefined, paths: readonly string[]): Record<string, unknown> | null {
  const merge = (current: unknown) => [...new Set([...(Array.isArray(current) ? (current as string[]) : []), ...paths])];
  const base = existing ?? {};
  if (provider === "claude") return { ...base, additionalDirectories: merge(base.additionalDirectories) };
  if (provider === "codex") {
    const sandbox = (base.sandbox_workspace_write ?? {}) as Record<string, unknown>;
    return { ...base, sandbox_workspace_write: { ...sandbox, writable_roots: merge(sandbox.writable_roots) } };
  }
  return null;
}

// A folder path on one line with comment markers removed, so it can never open or close a section.
function plainPath(path: string): string {
  let flat = path;
  while (/<!--|-->/.test(flat)) flat = flat.replace(/<!--|-->/g, "");
  return flat.replace(/\s+/g, " ").trim();
}

export interface LinkedForChat {
  links: { path: string; name: string; repoKey: string | null }[];
  // Whether the folders could be given to this chat's provider.
  granted: boolean;
  provider: string;
  // The chat's folder is shared by several workspaces and one of them has links: none were added.
  sharedFolder: boolean;
  // Why links could not be prepared, said in one line.
  problem: string | null;
  // The agent has the knowledge tools, so linked projects' knowledge is reachable through them.
  knowledgeTools: boolean;
}

// The prompt section that tells a chat about its workspace's linked projects. Null when there is
// nothing to say.
export function linksSection(linked: LinkedForChat, start: string, end: string): string | null {
  if (linked.problem) return [start, `Linked projects (Contextualise) could not be added to this chat: ${linked.problem.replace(/\s+/g, " ").slice(0, 300)}`, end].join("\n");
  if (linked.sharedFolder) return [start, "Linked projects (Contextualise): this workspace's folder is shared by several Paseo workspaces, so Contextualise cannot tell which one this chat is in and added no linked projects. Ask M to start the chat from the Linked pill's \"New linked chat\" instead.", end].join("\n");
  if (linked.links.length === 0) return null;
  const list = linked.links.map((link) => `- ${plainPath(link.name)}: ${plainPath(link.path)}${link.repoKey ? ` (project key ${plainPath(link.repoKey)})` : ""}`);
  const lines = linked.granted
    ? [
        "## Linked projects (Contextualise)",
        "M linked these folders to this workspace. You can read and edit them as well as your own folder:",
        ...list,
        "Run git in a linked folder with `git -C <folder>`, and commit each project separately, in its own repository.",
        ...(linked.provider === "codex" ? ["Codex can write to linked folders only in its workspace-write sandbox, and keeps each one's .git read-only, so a commit there needs M's approval."] : []),
        ...(linked.knowledgeTools && linked.links.some((link) => link.repoKey) ? ["Search a linked project's knowledge with the knowledge tools' `project` argument set to its project key."] : []),
      ]
    : ["## Linked projects (Contextualise)", `M linked these folders to this workspace, but Contextualise can give extra folders only to Claude and Codex chats, not ${plainPath(linked.provider)}. They are listed for reference; you may not be able to edit them:`, ...list];
  return [start, ...lines, end].join("\n");
}
