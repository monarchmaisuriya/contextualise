import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, posix } from "node:path";
import { type ProjectFacts, projectFactsSchema } from "../../shared/knowledge";
import type { ProjectRoot } from "./git";
import { SKIPPED_FOLDERS } from "./sources";
import type { KnowledgeStore } from "./store";
import type { CodeImport, CodeSymbol } from "./symbols";

export const FACTS_VERSION = 1;
// A folder holding more than this share of the code, with at least SPLIT_MIN_CHILDREN subfolders
// of code, is a container ("apps/", "packages/", "src/"), and its subfolders are the areas.
const SPLIT_SHARE = 0.4;
const SPLIT_MIN_CHILDREN = 3;
// Areas with fewer files than this are listed together as "Other".
export const MIN_AREA_FILES = 3;
const KEY_NAMES = 8;
const MAIN_FILES = 8;
const LIBRARIES = 12;
// Where an area's written explanation is kept: `(area)/<area path>`, beside the project overview.
export const AREA_PREFIX = "(area)/";
export const TOP_LEVEL = "";
export const OTHER = "(other)";
// Folders that hold tests or generated steps for the folder above them, never an area of their own.
const NOT_AREAS = new Set(["tests", "test", "__tests__", "spec", "specs", "migrations", "fixtures"]);
const TEST_FILE = /(^test_.*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$)/;
const LANGUAGES: Record<string, string> = { ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".go": "Go" };
const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export interface FactsFile {
  path: string;
  symbols: Pick<CodeSymbol, "name" | "kind" | "line">[];
  imports: CodeImport[];
}

export interface FactsInput {
  files: readonly FactsFile[];
  // Every tracked file of the project, code or not: Python packages and Go folders resolve against it.
  allPaths: ReadonlySet<string>;
  // Dependency lists by path: package.json, requirements*.txt, pyproject.toml, go.mod.
  manifests: ReadonlyMap<string, string>;
  minAreaFiles?: number;
}

// The folders above a file that can be areas: test and migration folders, and everything below
// them, count toward the folder that holds them.
function areaFolders(path: string): string[] {
  const folders = path.split("/").slice(0, -1);
  const cut = folders.findIndex((folder) => NOT_AREAS.has(folder.toLowerCase()));
  return cut === -1 ? folders : folders.slice(0, cut);
}

export function isTestFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return TEST_FILE.test(name) || path.split("/").slice(0, -1).some((folder) => /^(tests?|__tests__|specs?)$/i.test(folder));
}

// The area a file belongs to, given the project's areas: the longest area folder above it, "Other"
// when that folder was folded into it, the top level for files at the root, else null (a folder
// with no code, such as docs/).
export function areaOf(path: string, facts: Pick<ProjectFacts, "areas">): string | null {
  const folders = areaFolders(path);
  // A file under a folder with no area (docs/) is not top level; only files at the root are.
  for (let depth = folders.length; depth >= (folders.length === 0 ? 0 : 1); depth -= 1) {
    const folder = folders.slice(0, depth).join("/");
    const area = facts.areas.find((candidate) => candidate.path === folder || candidate.merged.includes(folder));
    if (area) return area.path;
  }
  return null;
}

// Splits the code into areas: the root is always split into its top folders; a folder is split
// again while it is a container of most of the code.
function placeAreas(paths: readonly string[]): Map<string, string> {
  const total = paths.length;
  const placed = new Map<string, string>();
  const place = (prefix: string[], members: { path: string; folders: string[] }[]) => {
    const groups = new Map<string, { path: string; folders: string[] }[]>();
    for (const member of members) {
      if (member.folders.length > prefix.length) {
        const next = member.folders[prefix.length];
        groups.set(next, [...(groups.get(next) ?? []), member]);
      }
    }
    const split = prefix.length === 0 || (members.length > SPLIT_SHARE * total && groups.size >= SPLIT_MIN_CHILDREN);
    const own = prefix.join("/");
    for (const member of members) if (!split || member.folders.length === prefix.length) placed.set(member.path, own);
    if (split) for (const [name, group] of groups) place([...prefix, name], group);
  };
  place(
    [],
    paths.map((path) => ({ path, folders: areaFolders(path) })),
  );
  return placed;
}

function pythonName(name: string): string {
  return name.toLowerCase().replace(/[-.]/g, "_");
}

// Declared dependencies: name as written, keyed by how code imports it.
function declaredLibraries(manifests: ReadonlyMap<string, string>): { script: Map<string, string>; python: Map<string, string>; go: string[] } {
  const script = new Map<string, string>();
  const python = new Map<string, string>();
  const go: string[] = [];
  for (const [path, text] of manifests) {
    const name = path.split("/").pop() ?? "";
    if (name === "package.json") {
      try {
        const json = JSON.parse(text) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
        for (const dependency of [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.peerDependencies ?? {})]) script.set(dependency, dependency);
      } catch {
        console.error(`[contextualise] skipped ${path}: not valid JSON`);
      }
    } else if (name === "go.mod") {
      for (const match of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[\d.]+/gm)) go.push(match[1]);
    } else {
      // requirements*.txt lines, pyproject "dependencies = [...]" strings, and poetry's table keys.
      const lines = name === "pyproject.toml" ? [...text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;].*)?["']/g)].map((match) => match[1]) : text.split("\n").map((line) => line.trim());
      if (name === "pyproject.toml") {
        const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/.exec(text);
        for (const match of poetry?.[1].matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm) ?? []) if (match[1] !== "python") lines.push(match[1]);
      }
      for (const line of lines) {
        const dependency = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)?.[1];
        if (dependency && !line.startsWith("-")) python.set(pythonName(dependency), dependency);
      }
    }
  }
  return { script, python, go };
}

function resolveScript(from: string, spec: string, all: ReadonlySet<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [base, ...SCRIPT_EXTENSIONS.map((extension) => `${stem}${extension}`), ...SCRIPT_EXTENSIONS.map((extension) => `${base}/index${extension}`)];
  return candidates.find((candidate) => all.has(candidate)) ?? null;
}

// A dotted Python module to its file, under any of the project's package roots.
function pythonModule(folder: string, module: string, all: ReadonlySet<string>): string | null {
  const base = [folder, module.replace(/\./g, "/")].filter(Boolean).join("/");
  if (base !== "" && all.has(`${base}.py`)) return `${base}.py`;
  const init = base === "" ? "__init__.py" : `${base}/__init__.py`;
  return all.has(init) ? init : null;
}

// What a Python import reaches in the project: a submodule per imported name when one exists
// ("from apps import orders"), else the module itself with the names it takes.
function resolvePython(from: string, entry: CodeImport, roots: readonly string[], all: ReadonlySet<string>): { target: string; names: string[] }[] {
  const dots = /^\.*/.exec(entry.spec)?.[0].length ?? 0;
  const module = entry.spec.slice(dots);
  const folders = dots > 0 ? [posix.dirname(from).split("/").slice(0, Math.max(0, posix.dirname(from).split("/").length - (dots - 1))).join("/").replace(/^\.$/, "")] : roots;
  for (const folder of folders) {
    const found: { target: string; names: string[] }[] = [];
    const rest: string[] = [];
    for (const name of entry.names) {
      const submodule = pythonModule(folder, module ? `${module}.${name}` : name, all);
      if (submodule) found.push({ target: submodule, names: [] });
      else rest.push(name);
    }
    const own = module || dots > 0 ? pythonModule(folder, module, all) : null;
    if (own && (rest.length > 0 || entry.names.length === 0)) found.push({ target: own, names: rest });
    if (found.length > 0) return found;
  }
  return [];
}

export function buildFacts(input: FactsInput): ProjectFacts {
  const files = input.files.filter((file) => LANGUAGES[extname(file.path).toLowerCase()]);
  const placed = placeAreas(files.map((file) => file.path));
  const sizes = new Map<string, number>();
  for (const area of placed.values()) sizes.set(area, (sizes.get(area) ?? 0) + 1);
  // Small areas are folded into "Other", except the top level, which is where a reader looks first.
  const merged = new Map<string, string>();
  for (const [area, size] of sizes) if (area !== TOP_LEVEL && size < (input.minAreaFiles ?? MIN_AREA_FILES)) merged.set(area, OTHER);
  const areaFor = (path: string) => {
    const area = placed.get(path) ?? TOP_LEVEL;
    return merged.get(area) ?? area;
  };

  // Python resolves from the root, src/, and folders that hold a project's entry files.
  const roots = [...new Set(["", "src", ...[...input.allPaths].filter((path) => /(^|\/)(manage\.py|setup\.py|pyproject\.toml)$/.test(path) && path.split("/").length <= 3).map((path) => posix.dirname(path).replace(/^\.$/, ""))])].filter((root) => root === "" || [...input.allPaths].some((path) => path.startsWith(`${root}/`)));
  const goModule = /^module\s+(\S+)/m.exec(input.manifests.get("go.mod") ?? "")?.[1] ?? null;
  const goFolders = new Map<string, string>();
  for (const file of files) if (file.path.endsWith(".go") && !goFolders.has(posix.dirname(file.path))) goFolders.set(posix.dirname(file.path), file.path);
  const declared = declaredLibraries(input.manifests);
  const definitions = new Map<string, Map<string, Pick<CodeSymbol, "name" | "kind" | "line">>>();
  const byName = new Map<string, string[]>();
  for (const file of files) {
    definitions.set(file.path, new Map(file.symbols.map((symbol) => [symbol.name, symbol])));
    for (const symbol of file.symbols) byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), file.path]);
  }

  const links = new Map<string, Set<string>>();
  const keyUses = new Map<string, { area: string; path: string; name: string; users: Set<string> }>();
  const importedBy = new Map<string, Set<string>>();
  const libraryUsers = new Map<string, Set<string>>();
  const useLibrary = (name: string, user: string) => libraryUsers.set(name, (libraryUsers.get(name) ?? new Set()).add(user));
  for (const file of files) {
    const language = LANGUAGES[extname(file.path).toLowerCase()];
    for (const entry of file.imports) {
      let targets: { target: string; names: string[] }[] = [];
      if (language === "Python") {
        targets = resolvePython(file.path, entry, roots, input.allPaths);
        const library = declared.python.get(pythonName(entry.spec.split(".")[0]));
        if (targets.length === 0 && library && !entry.spec.startsWith(".")) useLibrary(library, file.path);
      } else if (language === "Go") {
        const folder = goModule && (entry.spec === goModule || entry.spec.startsWith(`${goModule}/`)) ? entry.spec.slice(goModule.length + 1) : null;
        const target = folder !== null ? goFolders.get(folder) : undefined;
        if (target) targets = [{ target, names: [] }];
        const library = declared.go.find((module) => entry.spec === module || entry.spec.startsWith(`${module}/`));
        if (library) useLibrary(library, file.path);
      } else {
        const target = resolveScript(file.path, entry.spec, input.allPaths);
        if (target) targets = [{ target, names: entry.names }];
        else {
          const name = entry.spec.startsWith("@") ? entry.spec.split("/").slice(0, 2).join("/") : entry.spec.split("/")[0];
          const library = declared.script.get(name);
          if (library) useLibrary(library, file.path);
        }
      }
      const from = areaFor(file.path);
      for (const { target, names } of targets) {
        if (target === file.path || !placed.has(target)) continue;
        importedBy.set(target, (importedBy.get(target) ?? new Set()).add(file.path));
        const to = areaFor(target);
        if (to === from) continue;
        links.set(`${from}\0${to}`, (links.get(`${from}\0${to}`) ?? new Set()).add(`${file.path}\0${target}`));
        for (const name of names) {
          // A name re-exported by a package's __init__.py or index file is found where it is defined.
          const home = definitions.get(target)?.has(name) ? target : byName.get(name)?.find((path) => areaFor(path) === to);
          if (!home) continue;
          const key = `${home}\0${name}`;
          const use = keyUses.get(key) ?? { area: to, path: home, name, users: new Set<string>() };
          use.users.add(file.path);
          keyUses.set(key, use);
        }
      }
    }
  }

  const areaPaths = [...new Set(files.map((file) => areaFor(file.path)))];
  const areas = areaPaths
    .map((area) => {
      const members = files.filter((file) => areaFor(file.path) === area);
      const languages: Record<string, number> = {};
      for (const file of members) languages[LANGUAGES[extname(file.path).toLowerCase()]] = (languages[LANGUAGES[extname(file.path).toLowerCase()]] ?? 0) + 1;
      const main = members
        .map((file) => ({ path: file.path, usedBy: importedBy.get(file.path)?.size ?? 0 }))
        .filter((file) => file.usedBy > 0)
        .sort((a, b) => b.usedBy - a.usedBy || a.path.localeCompare(b.path))
        .slice(0, MAIN_FILES);
      let keyNames = [...keyUses.values()]
        .filter((use) => use.area === area)
        .map((use) => {
          const symbol = definitions.get(use.path)?.get(use.name);
          return { name: use.name, kind: symbol?.kind ?? "name", path: use.path, line: symbol?.line ?? 0, uses: use.users.size };
        })
        .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
        .slice(0, KEY_NAMES);
      // An area nothing else imports by name still shows its main classes, from its most used files.
      if (keyNames.length === 0) {
        keyNames = (main.length > 0 ? main.map((file) => file.path) : members.map((file) => file.path))
          .flatMap((path) => [...(definitions.get(path)?.values() ?? [])].filter((symbol) => symbol.kind === "class").map((symbol) => ({ name: symbol.name, kind: symbol.kind, path, line: symbol.line, uses: 0 })))
          .slice(0, KEY_NAMES);
      }
      return {
        path: area,
        files: members.filter((file) => !isTestFile(file.path)).length,
        tests: members.filter((file) => isTestFile(file.path)).length,
        symbols: members.reduce((sum, file) => sum + file.symbols.length, 0),
        languages,
        keyNames,
        mainFiles: main,
        merged: area === OTHER ? [...merged.keys()].sort() : [],
      };
    })
    .sort((a, b) => b.files + b.tests - (a.files + a.tests) || a.path.localeCompare(b.path));

  const languages: Record<string, number> = {};
  for (const file of files) languages[LANGUAGES[extname(file.path).toLowerCase()]] = (languages[LANGUAGES[extname(file.path).toLowerCase()]] ?? 0) + 1;
  const linkList = [...links.entries()].map(([key, pairs]) => ({ from: key.split("\0")[0], to: key.split("\0")[1], count: pairs.size })).sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return {
    version: FACTS_VERSION,
    codeFiles: files.filter((file) => !isTestFile(file.path)).length,
    testFiles: files.filter((file) => isTestFile(file.path)).length,
    languages,
    areas,
    links: linkList,
    libraries: [...libraryUsers.entries()]
      .map(([name, users]) => ({ name, files: users.size }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
      .slice(0, LIBRARIES),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(areas.map((area) => [area.path, area.keyNames.slice(0, 3).map((key) => key.name)])))
      .digest("hex")
      .slice(0, 16),
  };
}

const MANIFEST = /(^|\/)(package\.json|go\.mod|pyproject\.toml|requirements[^/]*\.txt)$/;

// The project's facts from its index and its dependency lists on disk. Dependency lists are read at
// the root and up to two folders down, outside dependency and build folders.
export async function projectFacts(repo: ProjectRoot, store: KnowledgeStore): Promise<ProjectFacts> {
  const allPaths = new Set(store.fileBlobs().keys());
  const manifests = new Map<string, string>();
  for (const path of allPaths) {
    if (!MANIFEST.test(path) || path.split("/").length > 3 || path.split("/").some((folder) => SKIPPED_FOLDERS.has(folder))) continue;
    const text = await readFile(join(repo.top, path), "utf8").catch(() => null);
    if (text !== null) manifests.set(path, text);
  }
  return buildFacts({ files: store.codeFiles(), allPaths, manifests });
}

// The facts kept in the index, or null when there are none or they were made by another version.
export function storedFacts(store: KnowledgeStore): ProjectFacts | null {
  const text = store.getMeta("facts");
  if (!text) return null;
  const parsed = projectFactsSchema.safeParse(JSON.parse(text));
  return parsed.success && parsed.data.version === FACTS_VERSION ? parsed.data : null;
}

// Rebuilds the facts, and drops written explanations of areas that no longer exist, so search never
// offers an explanation of a folder that was renamed or removed.
export async function updateFacts(repo: ProjectRoot, store: KnowledgeStore): Promise<ProjectFacts> {
  const facts = await projectFacts(repo, store);
  store.setMeta("facts", JSON.stringify(facts));
  const areas = new Set(facts.areas.map((area) => area.path));
  for (const path of store.indexedSources().keys()) if (path.startsWith(AREA_PREFIX) && !areas.has(path.slice(AREA_PREFIX.length))) store.removeSource(path);
  return facts;
}
