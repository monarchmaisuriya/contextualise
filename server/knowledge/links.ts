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
  // Set when a workspace was attached (its folder, not a project's): the link lapses when Paseo no
  // longer has that workspace, so a later worktree reusing the folder never inherits it.
  workspaceId: z.string().min(1).max(200).optional(),
});
export type WorkspaceLink = z.infer<typeof linkSchema>;
// Project grants already used, newest last; a grant expires within an hour, so a few hundred is plenty.
const USED_GRANTS_KEPT = 500;
const fileSchema = z.object({ version: z.literal(1), workspaces: z.record(z.string(), z.array(linkSchema).max(MAX_LINKS)), usedGrants: z.array(z.string()).max(USED_GRANTS_KEPT).default([]) });
type LinksFile = z.infer<typeof fileSchema>;

export const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

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
    // One exception inside Paseo's home: a worktree workspace's folder, <home>/worktrees/<id>/<slug>
    // or deeper, measured on the real path so a link there into anything else stays refused. The
    // worktrees folder is fixed here, never read from Paseo's config, where "." would open all of home.
    const worktrees = await realpath(join(kept, "worktrees")).catch(() => join(kept, "worktrees"));
    const inWorktree = real.startsWith(`${worktrees}${sep}`) && real.slice(worktrees.length + 1).split(sep).length >= 2;
    if (within(kept, real) || (within(real, kept) && !inWorktree)) throw new Error(`${real} overlaps Paseo's own data folder (${kept}), which cannot be linked`);
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

  private async load(): Promise<LinksFile> {
    const path = await this.file();
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return null;
      throw error;
    });
    if (text === null) return { version: 1, workspaces: {}, usedGrants: [] };
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`${path} could not be read (${parsed.error.issues[0]?.message}); fix or remove it to clear attached projects`);
    return parsed.data;
  }

  // The workspaces that have at least one link.
  async workspaceIds(): Promise<string[]> {
    return Object.keys((await this.load()).workspaces);
  }

  async list(workspaceId: string): Promise<WorkspaceLink[]> {
    return (await this.load()).workspaces[workspaceId] ?? [];
  }

  private write<T>(change: (file: LinksFile) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const file = await this.load();
      const result = change(file);
      const path = await this.file();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(fileSchema.parse(file), null, 2)}\n`, { mode: 0o600 });
      await rename(temp, path);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private update(workspaceId: string, change: (current: WorkspaceLink[]) => WorkspaceLink[]): Promise<WorkspaceLink[]> {
    return this.write((file) => {
      const links = change(file.workspaces[workspaceId] ?? []);
      if (links.length > 0) file.workspaces[workspaceId] = links;
      else delete file.workspaces[workspaceId];
      return links;
    });
  }

  // Marks a project grant used; one used before is refused.
  useGrant(id: string): Promise<void> {
    return this.write((file) => {
      if (file.usedGrants.includes(id)) throw new Error("This attachment was already used to attach its project. Pick the project again in Attach > Project.");
      file.usedGrants = [...file.usedGrants, id].slice(-USED_GRANTS_KEPT);
    });
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

// Folder options for the chat's provider, merged with any already set (null: leave them as they are),
// and whether the chat can then edit the folders. Only Claude, Codex, and OpenCode are known: Paseo
// checks each provider's options strictly and fails the chat on a key it does not know, so any other
// provider gets nothing.
export function linkedProviderOptions(provider: string, existing: Record<string, unknown> | undefined, paths: readonly string[], modeId?: string): { options: Record<string, unknown> | null; granted: boolean } {
  const merge = (current: unknown) => [...new Set([...(Array.isArray(current) ? (current as string[]) : []), ...paths])];
  const base = existing ?? {};
  if (provider === "claude") return { options: { ...base, additionalDirectories: merge(base.additionalDirectories) }, granted: true };
  if (provider === "codex") {
    const sandbox = (base.sandbox_workspace_write ?? {}) as Record<string, unknown>;
    return { options: { ...base, sandbox_workspace_write: { ...sandbox, writable_roots: merge(sandbox.writable_roots) } }, granted: true };
  }
  if (provider === "opencode") return openCodeOptions(base, paths, modeId);
  return { options: null, granted: false };
}

// OpenCode asks its external_directory rule for any file outside the chat's folder, as "<that file's
// folder>/*", and the last matching rule wins; "*" crosses "/". So each attached folder is allowed as
// "<folder>/*", placed last. M's explicit choices are never widened: one action for every permission,
// or "deny" for outside folders, is left as it is. Edits are also checked against `edit`, and plan
// mode denies them.
function openCodeOptions(base: Record<string, unknown>, paths: readonly string[], modeId: string | undefined): { options: Record<string, unknown> | null; granted: boolean } {
  const editsAllowed = (edit: unknown) => modeId !== "plan" && (edit === undefined || edit === "allow");
  const permission = base.permission;
  if (typeof permission === "string") return { options: null, granted: permission === "allow" && editsAllowed(undefined) };
  const rules = (permission ?? {}) as Record<string, unknown>;
  const outside = rules.external_directory;
  if (outside === "deny") return { options: null, granted: false };
  const kept: Record<string, unknown> = typeof outside === "string" ? { "*": outside } : { ...((outside ?? {}) as Record<string, unknown>) };
  for (const path of paths) delete kept[`${path}/*`];
  const external_directory = { ...kept, ...Object.fromEntries(paths.map((path) => [`${path}/*`, "allow"])) };
  return { options: { ...base, permission: { ...rules, external_directory } }, granted: editsAllowed(rules.edit) };
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
  if (linked.problem) return [start, `Attached projects (Contextualise) could not be added to this chat: ${linked.problem.replace(/\s+/g, " ").slice(0, 300)}`, end].join("\n");
  if (linked.sharedFolder) return [start, "Attached projects (Contextualise): this workspace's folder is shared by several Paseo workspaces, so Contextualise cannot tell which one this chat is in and added no attached projects. Ask M to start the chat from the Attached button's \"New chat with attached projects\" instead.", end].join("\n");
  if (linked.links.length === 0) return null;
  const list = linked.links.map((link) => `- ${plainPath(link.name)}: ${plainPath(link.path)}${link.repoKey ? ` (project key ${plainPath(link.repoKey)})` : ""}`);
  const searched = linked.knowledgeTools && linked.links.some((link) => link.repoKey) ? ["knowledge_search covers these projects too; for knowledge_read, knowledge_outline, knowledge_history, and knowledge_impact on one of them, pass its project key as `project`."] : [];
  const lines = linked.granted
    ? [
        "## Attached projects (Contextualise)",
        "M attached these projects to this workspace. You can read and edit them as well as your own folder:",
        ...list,
        "Run git in an attached folder with `git -C <folder>`, and commit each project separately, in its own repository.",
        ...(linked.provider === "codex" ? ["Codex can write to attached folders only in its workspace-write sandbox, and keeps each one's .git read-only, so a commit there needs M's approval."] : []),
        ...searched,
      ]
    : linked.provider === "opencode"
      ? ["## Attached projects (Contextualise)", "M attached these projects to this workspace. You can read them, but this chat's OpenCode permissions (plan mode, or edits or outside folders set to ask or deny) may ask M before or stop edits there:", ...list, ...searched]
      : ["## Attached projects (Contextualise)", `M attached these projects to this workspace, but Contextualise can give extra folders only to Claude, Codex, and OpenCode chats, not ${plainPath(linked.provider)}. They are listed for reference; you may not be able to edit them:`, ...list, ...searched];
  return [start, ...lines, end].join("\n");
}
