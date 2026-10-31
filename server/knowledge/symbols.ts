import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { CODE_EXTENSIONS } from "./sources";

export interface CodeSymbol {
  name: string;
  // From the tags query capture: function, method, class, interface, module, type, enum, constant.
  kind: string;
  line: number;
  signature: string;
  params: number;
  // The definition's text with its name taken out: equal before and after a pure rename.
  shape: string;
}

// One import statement: what it names (a path, a dotted module, or a package) and the names it takes
// from there, when it lists them. Resolved to project files by facts.ts.
export interface CodeImport {
  spec: string;
  names: string[];
}

export interface ParsedCode {
  symbols: CodeSymbol[];
  imports: CodeImport[];
}

type Grammar = (typeof CODE_EXTENSIONS)[keyof typeof CODE_EXTENSIONS];

// web-tree-sitter's own types, kept to what is used, so the module can be loaded from disk at run
// time instead of being bundled (see SymbolReader).
interface TsNode {
  type: string;
  text: string;
  parent: TsNode | null;
  startPosition: { row: number };
  descendantsOfType(types: string[]): TsNode[];
  namedChildCount: number;
}
interface TsQuery {
  matches(node: TsNode): { captures: { name: string; node: TsNode }[] }[];
}
interface TsModule {
  Parser: {
    init(): Promise<void>;
    new (): { setLanguage(language: unknown): void; parse(text: string): { rootNode: TsNode; delete(): void } | null; delete(): void };
  };
  Language: { load(path: string): Promise<unknown> };
  Query: new (language: unknown, source: string) => TsQuery;
}

// TypeScript's tags query only adds TypeScript-only definitions to the JavaScript one; type aliases
// and enums are not in either, so they are added here.
const TYPESCRIPT_EXTRA = `
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
`;

const GRAMMARS: Record<Grammar, { wasm: string; queries: string[]; extra?: string }> = {
  javascript: { wasm: "javascript/tree-sitter-javascript.wasm", queries: ["javascript/tags.scm"] },
  typescript: { wasm: "typescript/tree-sitter-typescript.wasm", queries: ["javascript/tags.scm", "typescript/tags.scm"], extra: TYPESCRIPT_EXTRA },
  tsx: { wasm: "typescript/tree-sitter-tsx.wasm", queries: ["javascript/tags.scm", "typescript/tags.scm"], extra: TYPESCRIPT_EXTRA },
  python: { wasm: "python/tree-sitter-python.wasm", queries: ["python/tags.scm"] },
  go: { wasm: "go/tree-sitter-go.wasm", queries: ["go/tags.scm"] },
};

// A definition inside a function body is a local helper, not part of the project's map.
const FUNCTION_BODIES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "function_definition",
  "method_declaration",
  "func_literal",
]);
const PARAMETER_LISTS = ["formal_parameters", "parameters", "parameter_list"];
// The syntax nodes that hold imports, per grammar family. Their text is read with the patterns
// below, which is enough for the forms tree-sitter has already recognised as imports.
const IMPORT_NODES: Record<"script" | "python" | "go", string[]> = {
  script: ["import_statement", "export_statement", "call_expression"],
  python: ["import_statement", "import_from_statement"],
  go: ["import_spec"],
};
const SIGNATURE_MAX_CHARS = 200;

function isNested(definition: TsNode): boolean {
  for (let node = definition.parent; node; node = node.parent) if (FUNCTION_BODIES.has(node.type)) return true;
  return false;
}

// Lists the top-level definitions of a source file with tree-sitter's tags queries. The plugin's
// server code is bundled into one script with no file location, so web-tree-sitter and the grammar
// files are loaded from the plugin's install folder on disk, where its own module finds its runtime.
// The names an import takes ("A", "B as C" gives "B"), without type-only markers.
function importedNames(list: string): string[] {
  return list
    .replace(/[(){}\n\\]/g, " ")
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter((name) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name));
}

function scriptImport(text: string): CodeImport | null {
  const call = /^(?:require|import)\(\s*["'`]([^"'`]+)["'`]\s*\)/.exec(text);
  if (call) return { spec: call[1], names: [] };
  const from = /^(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/.exec(text);
  if (from) return { spec: from[2], names: /\{([\s\S]*)\}/.exec(from[1]) ? importedNames(/\{([\s\S]*)\}/.exec(from[1])?.[1] ?? "") : [] };
  const bare = /^import\s+["']([^"']+)["']/.exec(text);
  return bare ? { spec: bare[1], names: [] } : null;
}

function pythonImports(type: string, text: string): CodeImport[] {
  const flat = text.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
  if (type === "import_from_statement") {
    const from = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(flat);
    return from ? [{ spec: from[1], names: from[2].trim() === "*" ? [] : importedNames(from[2]) }] : [];
  }
  return flat
    .replace(/^import\s+/, "")
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/)[0])
    .filter((spec) => /^[\w.]+$/.test(spec))
    .map((spec) => ({ spec, names: [] }));
}

function goImport(text: string): CodeImport | null {
  const path = /"([^"]+)"/.exec(text);
  return path ? { spec: path[1], names: [] } : null;
}

export class SymbolReader {
  private loaded: Promise<{ module: TsModule; languages: Map<Grammar, Promise<{ language: unknown; query: TsQuery }>> }> | null = null;

  constructor(private readonly pluginDir: () => Promise<string>) {}

  private load() {
    this.loaded ??= (async () => {
      const dir = await this.pluginDir();
      const module = createRequire(join(dir, "package.json"))("web-tree-sitter") as TsModule;
      await module.Parser.init();
      return { module, languages: new Map() };
    })();
    // A failed load is retried on the next file instead of being remembered forever.
    this.loaded.catch(() => {
      this.loaded = null;
    });
    return this.loaded;
  }

  private async grammar(grammar: Grammar) {
    const { module, languages } = await this.load();
    let entry = languages.get(grammar);
    if (!entry) {
      entry = (async () => {
        const dir = join(await this.pluginDir(), "grammars");
        const spec = GRAMMARS[grammar];
        const language = await module.Language.load(join(dir, spec.wasm));
        const sources = await Promise.all(spec.queries.map((path) => readFile(join(dir, path), "utf8")));
        return { language, query: new module.Query(language, [...sources, spec.extra ?? ""].join("\n")) };
      })();
      languages.set(grammar, entry);
    }
    return entry;
  }

  async read(path: string, text: string): Promise<CodeSymbol[]> {
    return (await this.parse(path, text)).symbols;
  }

  // A source file's top-level definitions and its imports, from one parse.
  async parse(path: string, text: string): Promise<ParsedCode> {
    const grammar = CODE_EXTENSIONS[extname(path).toLowerCase()];
    if (!grammar) return { symbols: [], imports: [] };
    const { module } = await this.load();
    const { language, query } = await this.grammar(grammar);
    // A parser lives in WebAssembly memory, which garbage collection never frees, so it is deleted as
    // soon as the tree exists; the tree does not need it.
    const parser = new module.Parser();
    let tree: ReturnType<typeof parser.parse>;
    try {
      parser.setLanguage(language);
      tree = parser.parse(text);
    } finally {
      parser.delete();
    }
    if (!tree) throw new Error(`tree-sitter could not parse ${path}`);
    try {
      const symbols: CodeSymbol[] = [];
      const seen = new Set<string>();
      for (const match of query.matches(tree.rootNode)) {
        const definition = match.captures.find((capture) => capture.name.startsWith("definition."));
        const name = match.captures.find((capture) => capture.name === "name");
        if (!definition || !name || isNested(definition.node)) continue;
        const line = name.node.startPosition.row + 1;
        const key = `${name.node.text}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const source = definition.node.text;
        symbols.push({
          name: name.node.text,
          kind: definition.name.slice("definition.".length),
          line,
          signature: source.split("\n")[0].trim().slice(0, SIGNATURE_MAX_CHARS),
          params: definition.node.descendantsOfType(PARAMETER_LISTS)[0]?.namedChildCount ?? 0,
          shape: createHash("sha256").update(source.split(name.node.text).join("")).digest("hex").slice(0, 16),
        });
      }
      return { symbols, imports: SymbolReader.imports(grammar, tree.rootNode) };
    } finally {
      tree.delete();
    }
  }

  private static imports(grammar: Grammar, root: TsNode): CodeImport[] {
    const family = grammar === "python" ? "python" : grammar === "go" ? "go" : "script";
    const found: CodeImport[] = [];
    for (const node of root.descendantsOfType(IMPORT_NODES[family])) {
      if (family === "python") found.push(...pythonImports(node.type, node.text));
      else {
        // Calls are imports only as require("x") or import("x"); export statements only with "from".
        if (node.type === "call_expression" && !/^(require|import)\s*\(/.test(node.text)) continue;
        const one = family === "go" ? goImport(node.text) : scriptImport(node.text);
        if (one) found.push(one);
      }
    }
    const seen = new Set<string>();
    return found.filter((entry) => {
      const key = `${entry.spec}\0${entry.names.join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
