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

  it("lists TypeScript and JavaScript imports with the names they take", async () => {
    const text = [
      'import React from "react";',
      'import { parseItemRef, type Tag, Store as S } from "../shared/contracts";',
      'import * as path from "node:path";',
      'import "./polyfill";',
      'export { helper } from "./helper.js";',
      'const fs = require("fs");',
      "const later = () => import('./lazy');",
      "console.log(fs);",
    ].join("\n");
    expect((await reader.parse("client/a.ts", text)).imports).toEqual([
      { spec: "react", names: [] },
      { spec: "../shared/contracts", names: ["parseItemRef", "Tag", "Store"] },
      { spec: "node:path", names: [] },
      { spec: "./polyfill", names: [] },
      { spec: "./helper.js", names: ["helper"] },
      { spec: "fs", names: [] },
      { spec: "./lazy", names: [] },
    ]);
  });

  it("lists Python imports, including relative ones and ones inside functions", async () => {
    const text = [
      "import os, apps.core.models as m",
      "from apps.orders.models import (Order,",
      "    OrderLine as Line)",
      "from . import tasks",
      "from ..core import *",
      "def run():",
      "    from apps.billing.client import charge",
    ].join("\n");
    expect((await reader.parse("apps/orders/views.py", text)).imports).toEqual([
      { spec: "os", names: [] },
      { spec: "apps.core.models", names: [] },
      { spec: "apps.orders.models", names: ["Order", "OrderLine"] },
      { spec: ".", names: ["tasks"] },
      { spec: "..core", names: [] },
      { spec: "apps.billing.client", names: ["charge"] },
    ]);
  });

  it("lists Go imports", async () => {
    const text = 'package main\n\nimport (\n  "fmt"\n  db "example.com/m/internal/db"\n)\n';
    expect((await reader.parse("cmd/api/main.go", text)).imports).toEqual([
      { spec: "fmt", names: [] },
      { spec: "example.com/m/internal/db", names: [] },
    ]);
  });
});
