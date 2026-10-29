import { describe, expect, it } from "vitest";
import { SymbolReader } from "./symbols";

// The repository root stands in for the plugin's install folder: it has package.json,
// node_modules/web-tree-sitter, and grammars/.
const reader = new SymbolReader(async () => process.cwd());
const names = (symbols: { name: string; kind: string; line: number }[]) => symbols.map(({ name, kind, line }) => `${kind} ${name}:${line}`);

describe("SymbolReader", () => {
  it("lists TypeScript functions, classes, methods, interfaces, types, and enums, but not local helpers", async () => {
    const text = [
      "export function parseItemRef(ref: string, strict: boolean) {",
      "  const local = () => 1;",
      "  return local();",
      "}",
      "export class TagStore {",
      "  add(name: string) {}",
      "}",
      "interface Tag { name: string }",
      "type Kind = 'a' | 'b';",
      "enum Mode { On, Off }",
      "export const helper = (a: number) => a;",
    ].join("\n");
    const symbols = await reader.read("shared/contracts.ts", text);
    expect(names(symbols)).toEqual(["function parseItemRef:1", "class TagStore:5", "method add:6", "interface Tag:8", "type Kind:9", "enum Mode:10", "function helper:11"]);
    expect(symbols[0]).toMatchObject({ signature: "function parseItemRef(ref: string, strict: boolean) {", params: 2 });
  });

  it("gives a renamed definition the same shape and parameter count", async () => {
    const [before] = await reader.read("a.ts", "function parseItemRef(ref: string) { return ref.trim(); }");
    const [after] = await reader.read("a.ts", "function parseRef(ref: string) { return ref.trim(); }");
    const [changed] = await reader.read("a.ts", "function parseRef(ref: string) { return ref; }");
    expect(after.shape).toBe(before.shape);
    expect(after.params).toBe(before.params);
    expect(changed.shape).not.toBe(before.shape);
  });

  it("reads TSX, JavaScript, Python, and Go", async () => {
    expect(names(await reader.read("a.tsx", "export function Screen() { return <div />; }"))).toEqual(["function Screen:1"]);
    expect(names(await reader.read("a.mjs", "export class Queue { push(x) {} }"))).toEqual(["class Queue:1", "method push:1"]);
    expect(names(await reader.read("a.py", "class Store:\n    def add(self, x):\n        pass\n\ndef main():\n    pass\n"))).toEqual(["class Store:1", "function add:2", "function main:5"]);
    expect(names(await reader.read("a.go", "package main\n\ntype Store struct{}\n\nfunc (s *Store) Add(x int) {}\n\nfunc main() {}\n"))).toEqual(["type Store:3", "method Add:5", "function main:7"]);
  });

  it("returns nothing for files it has no grammar for", async () => {
    expect(await reader.read("README.md", "# Title")).toEqual([]);
  });
});
