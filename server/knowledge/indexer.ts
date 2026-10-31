import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeKind } from "../../shared/knowledge";
import { redactSecrets } from "../secrets";
import { git, type ProjectRoot } from "./git";
import { readProjectFile } from "./files";
import { folderSignatures, MAX_WALK_ENTRIES, statSignature } from "./walk";
import { adrInfo, type AdrInfo, chunkMarkdown, classify, type ClassifyOptions } from "./sources";
import type { KnowledgeStore } from "./store";
import type { CodeSymbol, ParsedCode, SymbolReader } from "./symbols";

const GIT_LIST_TIMEOUT_MS = 20_000;

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
export async function currentBlobs(project: ProjectRoot): Promise<Map<string, string>> {
  if (project.git) return trackedBlobs(project.top);
  const { files, repos } = await folderSignatures(project.top);
  for (const repo of repos) {
    if (files.size >= MAX_WALK_ENTRIES) break;
    const tracked = await indexedFiles(join(project.top, repo)).catch((error: unknown) => {
      console.error(`[contextualise] left ${repo} out of the index of ${project.top}: git could not list its files: ${String(error)}`);
      return new Map<string, string>();
    });
    for (const path of tracked.keys()) {
      if (files.size >= MAX_WALK_ENTRIES) break;
      const info = await lstat(join(project.top, repo, path)).catch(() => null);
      if (info?.isFile()) files.set(`${repo}/${path}`, statSignature(info));
    }
  }
  return files;
}

export interface IndexerOptions {
  symbols: SymbolReader;
  codeSymbols: boolean;
  classify?: ClassifyOptions;
  maxFileBytes?: number;
  maxDocuments?: number;
}

export const DEFAULT_MAX_DOCUMENTS = 2_000;
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

// Brings a repository's store up to date with its tracked files. Only files whose blob changed are
// read again; files that left the repository or stopped being indexed are removed.
export async function indexRepo(repo: ProjectRoot, store: KnowledgeStore, options: IndexerOptions): Promise<IndexChange[]> {
  const blobs = await currentBlobs(repo);
  store.setFileBlobs(blobs);
  const wanted = new Map<string, KnowledgeKind>();
  let documents = 0;
  for (const path of [...blobs.keys()].sort()) {
    const kind = classify(path, options.classify);
    if (!kind || (kind === "code" && !options.codeSymbols)) continue;
    if (kind !== "code" && (documents += 1) > (options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS)) continue;
    wanted.set(path, kind);
  }
  const changes: IndexChange[] = [];
  const indexed = store.indexedSources();
  for (const [path, previous] of indexed) {
    // Generated entries such as the project brief, at "(brief)", have no file and are kept.
    if (path.startsWith("(") || wanted.get(path) === previous.kind) continue;
    changes.push({ path, kind: previous.kind, deleted: true, removedSymbols: store.symbolsIn(path), addedSymbols: [], adrBefore: store.sourceStatus(path), adrAfter: null });
    store.removeSource(path);
  }
  for (const [path, kind] of wanted) {
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
