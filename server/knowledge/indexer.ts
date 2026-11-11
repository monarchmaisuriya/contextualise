import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { KnowledgeKind } from "../../shared/knowledge";
import { redactSecrets } from "../secrets";
import { git, type ProjectRoot, repoKeyFromRemote } from "./git";
import { readProjectFile } from "./files";
import { folderSignatures, MAX_WALK_ENTRIES, statSignature } from "./walk";
import { adrInfo, type AdrInfo, chunkMarkdown, classify, type ClassifyOptions } from "./sources";
import type { KnowledgeStore } from "./store";
import type { CodeSymbol, ParsedCode, SymbolReader } from "./symbols";

const GIT_LIST_TIMEOUT_MS = 20_000;
// Indexing runs on the plugin's only thread, which must also answer Paseo's hooks within 30 seconds.
// A long run hands the thread back after this much work, so a hook never waits behind it.
const INDEX_SLICE_MS = 20;

// Resolves at once until `sliceMs` of work has run since the last pause, then after Paseo's waiting
// calls have had the thread.
export function workSlicer(sliceMs = INDEX_SLICE_MS): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < sliceMs) return;
    await new Promise((resolve) => setImmediate(resolve));
    since = performance.now();
  };
}

// What one re-index changed, for checks that compare before and after (Memorise suggestions).
export interface IndexChange {
  path: string;
  kind: KnowledgeKind;
  deleted: boolean;
  removedSymbols: CodeSymbol[];
  addedSymbols: CodeSymbol[];
  adrBefore: AdrInfo | null;
  adrAfter: AdrInfo | null;
}

// Every tracked file and its blob id: from the index for unchanged files, and from `git hash-object`
// for files edited in the work tree, so an edit is indexed before it is committed. Only plain files
// count: symbolic links (mode 120000) point outside what the repository holds, and submodules
// (160000) are other repositories that `git hash-object` cannot hash.
const PLAIN_FILE_MODES = new Set(["100644", "100755"]);

// The plain files git's index lists, with their staged blob ids. Reads the index only: no command a
// repository's config names (filters, fsmonitor) runs.
async function indexedFiles(top: string): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  for (const entry of (await git(top, ["ls-files", "-s", "-z"], GIT_LIST_TIMEOUT_MS)).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, blob] = entry.slice(0, tab).split(" ");
    if (PLAIN_FILE_MODES.has(mode)) blobs.set(entry.slice(tab + 1), blob);
  }
  return blobs;
}

export async function trackedBlobs(top: string): Promise<Map<string, string>> {
  const blobs = await indexedFiles(top);
  const edited: string[] = [];
  const status = (await git(top, ["status", "--porcelain", "-z", "--untracked-files=no", "--no-renames"], GIT_LIST_TIMEOUT_MS)).split("\0");
  for (const entry of status) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    if (!blobs.has(path)) continue;
    if (entry[1] === "D" || entry[0] === "D") blobs.delete(path);
    else if (entry[1] === "M" || entry[1] === "T") edited.push(path);
  }
  if (edited.length > 0) {
    const hashes = (await git(top, ["hash-object", "--no-filters", "--", ...edited], GIT_LIST_TIMEOUT_MS)).split("\n");
    edited.forEach((path, index) => blobs.set(path, hashes[index]));
  }
  return blobs;
}

// What each file is now: git's blob ids in a repository, change signatures in a folder outside git.
// A repository inside such a folder adds only the files its index lists, so what it ignores (virtual
// environments, build output) stays out; their signatures come from the files themselves, as for the
// rest of the folder. Only its index is read: the folder may hold copied repositories whose config
// names commands (`git status` runs content filters), so none of their git runs. One git cannot read
// is left out and logged.
// Each repository is indexed once, from one copy (see oneCopyEach), and whole or not at all: a cut
// through a repository moves whenever a file is added before it, re-reading thousands of files.
export async function currentBlobs(project: ProjectRoot): Promise<Map<string, string>> {
  if (project.git) return trackedBlobs(project.top);
  const { files, repos } = await folderSignatures(project.top);
  for (const repo of await oneCopyEach(project.top, repos)) {
    const tracked = await indexedFiles(join(project.top, repo)).catch((error: unknown) => {
      console.error(`[contextualise] left ${repo} out of the index of ${project.top}: git could not list its files: ${String(error)}`);
      return new Map<string, string>();
    });
    if (files.size + tracked.size > MAX_WALK_ENTRIES) {
      console.error(`[contextualise] left ${repo} out of the index of ${project.top}: its ${tracked.size} files would pass the limit of ${MAX_WALK_ENTRIES}`);
      continue;
    }
    for (const path of tracked.keys()) {
      const info = await lstat(join(project.top, repo, path)).catch(() => null);
      if (info?.isFile()) files.set(`${repo}/${path}`, statSignature(info));
    }
  }
  return files;
}

// A folder often holds copies of one repository (its worktrees, clones of one remote). Each
// repository is indexed from one copy: the one nearest the folder's top, then the first by name, so
// adding or removing another copy changes nothing. Copies are matched by their origin remote; one
// without a remote is its own repository. Returned by path, so the order never depends on the walk.
async function oneCopyEach(top: string, repos: readonly string[]): Promise<string[]> {
  const depth = (repo: string) => repo.split("/").length;
  const named = await Promise.all(repos.map(async (repo) => ({ repo, identity: (await originKey(join(top, repo))) ?? `path:${repo}` })));
  const chosen = new Map<string, string>();
  for (const { repo, identity } of named.sort((a, b) => depth(a.repo) - depth(b.repo) || a.repo.localeCompare(b.repo))) {
    if (!chosen.has(identity)) chosen.set(identity, repo);
  }
  return [...chosen.values()].sort((a, b) => a.localeCompare(b));
}

// The key of a repository copy's origin remote, read from its git config file rather than by running
// git: a git that times out under load would make a copy look like another repository for one
// refresh, and the files would be read again. A worktree's `.git` file names its git folder, which
// names the shared one (`commondir`) holding the config. Null without an origin or a readable config.
async function originKey(repoDir: string): Promise<string | null> {
  const dotGit = join(repoDir, ".git");
  const info = await lstat(dotGit).catch(() => null);
  if (!info) return null;
  let gitDir = dotGit;
  if (info.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""));
    if (!pointer) return null;
    gitDir = resolve(repoDir, pointer[1].trim());
    const common = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
    if (common) gitDir = resolve(gitDir, common);
  }
  const config = await readFile(join(gitDir, "config"), "utf8").catch(() => "");
  let inOrigin = false;
  for (const line of config.split("\n")) {
    const section = /^\s*\[([^\]]*)\]/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1].trim());
      continue;
    }
    const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line) : null;
    if (url) return repoKeyFromRemote(url[1].replace(/^"(.*)"$/, "$1"));
  }
  return null;
}

export interface IndexerOptions {
  symbols: SymbolReader;
  codeSymbols: boolean;
  classify?: ClassifyOptions;
  maxFileBytes?: number;
  maxDocuments?: number;
  // Called before each step of work; a fresh workSlicer() when not given.
  pause?: () => Promise<void>;
}

export const DEFAULT_MAX_DOCUMENTS = 2_000;
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

// Brings a repository's store up to date with its tracked files. Only files whose blob changed are
// read again; files that left the repository or stopped being indexed are removed.
export async function indexRepo(repo: ProjectRoot, store: KnowledgeStore, options: IndexerOptions): Promise<IndexChange[]> {
  const pause = options.pause ?? workSlicer();
  const blobs = await currentBlobs(repo);
  store.setFileBlobs(blobs);
  const wanted = new Map<string, KnowledgeKind>();
  let documents = 0;
  for (const path of [...blobs.keys()].sort()) {
    await pause();
    const kind = classify(path, options.classify);
    if (!kind || (kind === "code" && !options.codeSymbols)) continue;
    if (kind !== "code" && (documents += 1) > (options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS)) continue;
    wanted.set(path, kind);
  }
  const changes: IndexChange[] = [];
  const indexed = store.indexedSources();
  for (const [path, previous] of indexed) {
    await pause();
    // Generated entries such as the project brief, at "(brief)", have no file and are kept.
    if (path.startsWith("(") || wanted.get(path) === previous.kind) continue;
    changes.push({ path, kind: previous.kind, deleted: true, removedSymbols: store.symbolsIn(path), addedSymbols: [], adrBefore: store.sourceStatus(path), adrAfter: null });
    store.removeSource(path);
  }
  for (const [path, kind] of wanted) {
    await pause();
    const blob = blobs.get(path) as string;
    if (indexed.get(path)?.blob === blob && indexed.get(path)?.kind === kind) continue;
    const raw = await readProjectFile(repo.top, path, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    if (raw === null) {
      // Too large now, or no longer a regular file: what was indexed from it is no longer true.
      if (indexed.has(path)) {
        changes.push({ path, kind: indexed.get(path)?.kind ?? kind, deleted: true, removedSymbols: store.symbolsIn(path), addedSymbols: [], adrBefore: store.sourceStatus(path), adrAfter: null });
        store.removeSource(path);
      }
      continue;
    }
    const text = redactSecrets(raw);
    const before = { symbols: store.symbolsIn(path), adr: kind === "adr" ? store.sourceStatus(path) : null };
    if (kind === "code") {
      let parsed: ParsedCode;
      try {
        parsed = await options.symbols.parse(path, text);
      } catch (error) {
        console.error(`[contextualise] could not list symbols in ${path}: ${String(error)}`);
        continue;
      }
      const { symbols, imports } = parsed;
      store.replaceSource({ path, kind, blob, chunks: [], symbols, imports });
      const names = (list: CodeSymbol[]) => new Set(list.map((symbol) => `${symbol.kind}:${symbol.name}`));
      const now = names(symbols);
      const was = names(before.symbols);
      changes.push({
        path,
        kind,
        deleted: false,
        removedSymbols: before.symbols.filter((symbol) => !now.has(`${symbol.kind}:${symbol.name}`)),
        addedSymbols: symbols.filter((symbol) => !was.has(`${symbol.kind}:${symbol.name}`)),
        adrBefore: null,
        adrAfter: null,
      });
    } else {
      const adr = kind === "adr" ? adrInfo(text) : undefined;
      store.replaceSource({ path, kind, blob, chunks: chunkMarkdown(path, text), adr });
      changes.push({ path, kind, deleted: false, removedSymbols: [], addedSymbols: [], adrBefore: before.adr, adrAfter: adr ?? null });
    }
  }
  store.setMeta("indexedAt", new Date().toISOString());
  return changes;
}
