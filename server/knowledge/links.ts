import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { z } from "zod";

// A workspace may link this many folders and workspaces; each folder is added to every new chat there.
export const MAX_LINKS = 5;
// A new chat gets at most this many attached folders in all (an attached workspace can bring several);
// the rest are named in its prompt.
export const MAX_CHAT_FOLDERS = 10;

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
// The folders one attached workspace may bring.
export const MAX_WORKSPACE_FOLDERS = 50;
const folderSchema = z.object({ path: z.string().min(1).max(1_000), repoKey: z.string().min(1).max(600).nullable() });
// A local workspace attached as a whole. It brings the repositories its chats changed, worked out when
// one of its chats ends a turn and saved here per workspace it is attached to (each checked against
// that workspace's folder), so reading links never has to work them out. It lapses with the workspace.
const attachedWorkspaceSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  addedAt: z.string(),
  folders: z.array(folderSchema).max(MAX_WORKSPACE_FOLDERS),
  // When the folders were last worked out.
  foldersAt: z.string(),
});
export type AttachedWorkspace = z.infer<typeof attachedWorkspaceSchema>;
export type BroughtFolder = z.infer<typeof folderSchema>;
// Attached workspaces sit in their own key: a version before them drops the key and never reads one
// as a folder link.
const fileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), z.array(linkSchema).max(MAX_LINKS)),
  attachedWorkspaces: z.record(z.string(), z.array(attachedWorkspaceSchema).max(MAX_LINKS)).default({}),
  usedGrants: z.array(z.string()).max(USED_GRANTS_KEPT).default([]),
});
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
    if (text === null) return { version: 1, workspaces: {}, attachedWorkspaces: {}, usedGrants: [] };
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`${path} could not be read (${parsed.error.issues[0]?.message}); fix or remove it to clear attached projects`);
    return parsed.data;
  }

  // The workspaces that have at least one link or attached workspace.
  async workspaceIds(): Promise<string[]> {
    const file = await this.load();
    return [...new Set([...Object.keys(file.workspaces), ...Object.keys(file.attachedWorkspaces)])];
  }

  // Every workspace's folder links and attached workspaces, read once.
  async all(): Promise<{ links: Record<string, WorkspaceLink[]>; attached: Record<string, AttachedWorkspace[]> }> {
    const file = await this.load();
    return { links: file.workspaces, attached: file.attachedWorkspaces };
  }

  // The workspaces that have this workspace attached.
  async receiversOf(attachedId: string): Promise<string[]> {
    return Object.entries((await this.load()).attachedWorkspaces)
      .filter(([, found]) => found.some((entry) => entry.workspaceId === attachedId))
      .map(([workspaceId]) => workspaceId);
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

  // One workspace's folder links and attached workspaces, changed together so the limit counts both;
  // a workspace left with neither kind is dropped from the file.
  private update<T>(workspaceId: string, change: (current: { links: WorkspaceLink[]; attached: AttachedWorkspace[] }) => { links: WorkspaceLink[]; attached: AttachedWorkspace[]; result: T }): Promise<T> {
    return this.write((file) => {
      const next = change({ links: file.workspaces[workspaceId] ?? [], attached: file.attachedWorkspaces[workspaceId] ?? [] });
      if (next.links.length + next.attached.length > MAX_LINKS) throw new Error(`A workspace can attach at most ${MAX_LINKS} folders and workspaces; remove one first`);
      if (next.links.length > 0) file.workspaces[workspaceId] = next.links;
      else delete file.workspaces[workspaceId];
      if (next.attached.length > 0) file.attachedWorkspaces[workspaceId] = next.attached;
      else delete file.attachedWorkspaces[workspaceId];
      return next.result;
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
    return this.update(workspaceId, ({ links, attached }) => {
      if (links.some((existing) => existing.path === link.path)) throw new Error(`${link.path} is already linked here`);
      const next = [...links, link];
      return { links: next, attached, result: next };
    });
  }

  remove(workspaceId: string, path: string): Promise<WorkspaceLink[]> {
    return this.update(workspaceId, ({ links, attached }) => {
      if (!links.some((existing) => existing.path === path)) throw new Error(`${path} is not linked here`);
      const next = links.filter((existing) => existing.path !== path);
      return { links: next, attached, result: next };
    });
  }

  addWorkspace(workspaceId: string, entry: AttachedWorkspace): Promise<void> {
    return this.update(workspaceId, ({ links, attached }) => {
      if (attached.some((existing) => existing.workspaceId === entry.workspaceId)) throw new Error(`Workspace ${entry.workspaceId} is already attached here`);
      return { links, attached: [...attached, entry], result: undefined };
    });
  }

  removeWorkspace(workspaceId: string, attachedId: string): Promise<void> {
    return this.update(workspaceId, ({ links, attached }) => {
      if (!attached.some((existing) => existing.workspaceId === attachedId)) throw new Error(`Workspace ${attachedId} is not attached here`);
      return { links, attached: attached.filter((existing) => existing.workspaceId !== attachedId), result: undefined };
    });
  }

  // Drops one workspace's attachments to workspaces not in `alive` (archived or deleted in Paseo).
  dropLapsed(workspaceId: string, alive: ReadonlySet<string>): Promise<void> {
    return this.update(workspaceId, ({ links, attached }) => ({
      links: links.filter((link) => !link.workspaceId || alive.has(link.workspaceId)),
      attached: attached.filter((entry) => alive.has(entry.workspaceId)),
      result: undefined,
    }));
  }

  // Saves the folders an attached workspace now brings to one workspace; nothing when it is no longer
  // attached there.
  setWorkspaceFolders(workspaceId: string, attachedId: string, folders: readonly BroughtFolder[], at: string): Promise<void> {
    return this.update(workspaceId, ({ links, attached }) => ({
      links,
      attached: attached.map((existing) => (existing.workspaceId === attachedId ? { ...existing, folders: folders.slice(0, MAX_WORKSPACE_FOLDERS), foldersAt: at } : existing)),
      result: undefined,
    }));
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
  // Attached folders past MAX_CHAT_FOLDERS, not added.
  leftOut?: readonly string[];
  // Workspaces are attached but project knowledge is off, so repositories their chats start working
  // in are not picked up; the folders listed are the ones recorded before.
  notFollowed?: boolean;
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
  const notes = [
    ...(linked.leftOut?.length ? [`Not added, because a chat gets at most ${MAX_CHAT_FOLDERS} attached folders: ${linked.leftOut.map(plainPath).join(", ")}.`] : []),
    ...(linked.notFollowed ? ["Project knowledge is off, so repositories the attached workspaces' chats start working in are not being added; the folders above are the ones recorded before."] : []),
  ];
  return [start, ...lines, ...notes, end].join("\n");
}
