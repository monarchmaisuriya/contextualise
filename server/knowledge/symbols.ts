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
    new (): { setLanguage(language: unknown): void; parse(text: string): { rootNode: TsNode; delete(): void } | null };
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
const SIGNATURE_MAX_CHARS = 200;

function isNested(definition: TsNode): boolean {
  for (let node = definition.parent; node; node = node.parent) if (FUNCTION_BODIES.has(node.type)) return true;
  return false;
}

// Lists the top-level definitions of a source file with tree-sitter's tags queries. The plugin's
// server code is bundled into one script with no file location, so web-tree-sitter and the grammar
// files are loaded from the plugin's install folder on disk, where its own module finds its runtime.
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
    const grammar = CODE_EXTENSIONS[extname(path).toLowerCase()];
    if (!grammar) return [];
    const { module } = await this.load();
    const { language, query } = await this.grammar(grammar);
    const parser = new module.Parser();
    parser.setLanguage(language);
    const tree = parser.parse(text);
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
      return symbols;
    } finally {
      tree.delete();
    }
  }
}
