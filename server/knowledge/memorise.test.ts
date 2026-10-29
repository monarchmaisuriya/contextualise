import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoApi } from "../paseo-types";
import type { IndexChange } from "./indexer";
import { type ExportedMemory, globMatches, MemoriseLink, memorySuggestions, SUGGESTIONS_PER_RUN } from "./memorise";
import type { CodeSymbol } from "./symbols";

const REPO = "github.com/acme/api";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const symbol = (name: string, overrides: Partial<CodeSymbol> = {}): CodeSymbol => ({ name, kind: "function", line: 40, signature: `function ${name}() {`, params: 1, shape: "same", ...overrides });
const memory = (overrides: Partial<ExportedMemory> = {}): ExportedMemory => ({
  id: "01JB8Z6X3T5Q9V2M4N7P8R1S0W",
  type: "gotcha",
  subject: "parseItemRef accepts bare keys",
  status: "active",
  enabled: true,
  paths: [],
  citations: [{ path: "shared/contracts.ts", lines: "38-52" }],
  ...overrides,
});
const codeChange = (removed: CodeSymbol[], added: CodeSymbol[]): IndexChange => ({ path: "shared/contracts.ts", kind: "code", deleted: false, removedSymbols: removed, addedSymbols: added, adrBefore: null, adrAfter: null });

describe("memorySuggestions", () => {
  it("suggests replacing a memory about a renamed definition, with the new name in its title", () => {
    const [suggestion] = memorySuggestions([codeChange([symbol("parseItemRef")], [symbol("parseRef")])], [memory()], () => false);
    expect(suggestion).toMatchObject({ kind: "replace", subject: "parseRef accepts bare keys", reason: "parseItemRef in shared/contracts.ts was renamed to parseRef; update this memory's text to the new name." });
  });

  it("treats a changed shape or parameter count as a removal, not a rename", () => {
    for (const added of [symbol("parseRef", { shape: "other" }), symbol("parseRef", { params: 2 })]) {
      expect(memorySuggestions([codeChange([symbol("parseItemRef")], [added])], [memory()], () => false)[0]).toMatchObject({ kind: "retire" });
    }
  });

  it("suggests archiving a memory about a definition that no longer exists anywhere", () => {
    expect(memorySuggestions([codeChange([symbol("parseItemRef")], [])], [memory()], () => false)).toMatchObject([{ kind: "retire", reason: "This memory is about parseItemRef in shared/contracts.ts, which no longer exists anywhere in the repository." }]);
  });

  it("stays quiet when the definition moved to another file, or the memory is about something else", () => {
    expect(memorySuggestions([codeChange([symbol("parseItemRef")], [])], [memory()], (name) => name === "parseItemRef")).toEqual([]);
    expect(memorySuggestions([codeChange([symbol("parseItemRef", { line: 90 })], [])], [memory({ subject: "Jira keys" })], () => false)).toEqual([]);
    expect(memorySuggestions([codeChange([symbol("parseItemRef")], [])], [memory({ citations: [{ path: "other.ts" }] })], () => false)).toEqual([]);
    expect(memorySuggestions([codeChange([symbol("parseItemRef")], [])], [memory({ status: "retired" })], () => false)).toEqual([]);
  });

  it("matches a memory by the cited lines even when its title does not name the definition", () => {
    expect(memorySuggestions([codeChange([symbol("parseItemRef")], [])], [memory({ subject: "Jira keys" })], () => false)).toHaveLength(1);
  });

  it("matches a memory by its path globs", () => {
    expect(memorySuggestions([codeChange([symbol("parseItemRef")], [])], [memory({ citations: [], paths: ["shared/**"] })], () => false)).toHaveLength(1);
  });

  it("suggests archiving memories that cite an ADR once it is superseded", () => {
    const change: IndexChange = { path: "docs/adr/0001-use-sqlite.md", kind: "adr", deleted: false, removedSymbols: [], addedSymbols: [], adrBefore: { status: "accepted", supersededBy: null }, adrAfter: { status: "superseded", supersededBy: "0002-use-postgres.md" } };
    expect(memorySuggestions([change], [memory({ citations: [{ path: "docs/adr/0001-use-sqlite.md" }] })], () => false)).toMatchObject([{ kind: "retire", reason: "This memory cites docs/adr/0001-use-sqlite.md, which is now superseded by 0002-use-postgres.md." }]);
    expect(memorySuggestions([{ ...change, adrBefore: { status: "superseded", supersededBy: null } }], [memory({ citations: [{ path: "docs/adr/0001-use-sqlite.md" }] })], () => false)).toEqual([]);
  });

  it("leaves deleted files to Memorise's own citation check", () => {
    expect(memorySuggestions([{ ...codeChange([symbol("parseItemRef")], []), deleted: true }], [memory()], () => false)).toEqual([]);
  });
});

describe("globMatches", () => {
  it.each([
    ["shared/**", "shared/contracts.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/api/a.ts", true],
    ["src/*.ts", "src/api/a.ts", false],
    ["src/{api,web}/*.ts", "src/web/a.ts", true],
    ["a?.md", "ab.md", true],
    ["docs/a.md", "docs/aXmd", false],
  ])("%s ~ %s -> %s", (glob, path, expected) => {
    expect(globMatches(glob, path)).toBe(expected);
  });
});

describe("MemoriseLink", () => {
  let home: string;
  let now: number;
  let plugins: Record<string, { enabled?: boolean }> | undefined;
  let link: MemoriseLink;
  const paseo = { config: { get: async () => ({ requestId: "r", config: { plugins } }) } } as unknown as PaseoApi;
  const interop = () => join(home, "memorise", "interop", "v1");
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(interop(), path)), { recursive: true });
    writeFileSync(join(interop(), path), JSON.stringify(value));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "contextualise-memorise-"));
    now = NOW;
    plugins = {};
    link = new MemoriseLink(async () => ({ memorise: join(home, "memorise"), own: join(home, "contextualise") }), () => now);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it.each([
    ["a fresh heartbeat", () => put("status.json", { version: 1, plugin: "memorise", writtenAt: new Date(NOW - 60_000).toISOString() }), undefined, "available"],
    ["a fresh heartbeat under another plugin id", () => put("status.json", { version: 1, plugin: "memorise", writtenAt: new Date(NOW).toISOString() }), {}, "available"],
    ["no plugin entry", () => {}, {}, "not-installed"],
    ["a disabled plugin", () => {}, { memorise: { enabled: false } }, "disabled"],
    ["a disabled plugin whose last heartbeat is still fresh", () => put("status.json", { version: 1, plugin: "memorise", writtenAt: new Date(NOW).toISOString() }), { memorise: { enabled: false } }, "disabled"],
    ["an enabled plugin without the contract", () => {}, { memorise: { enabled: true } }, "needs-update"],
    ["a heartbeat older than 10 minutes", () => put("status.json", { version: 1, plugin: "memorise", writtenAt: new Date(NOW - 11 * 60_000).toISOString() }), { memorise: {} }, "needs-update"],
    ["a heartbeat of another version", () => put("status.json", { version: 2, plugin: "memorise", writtenAt: new Date(NOW).toISOString() }), { memorise: {} }, "needs-update"],
  ])("reports %s", async (_label, arrange, config, expected) => {
    plugins = config as typeof plugins;
    arrange();
    expect(await link.state(paseo)).toBe(expected);
  });

  it("finds memories about a path from the export, leaving out disabled ones", async () => {
    put(`export/${REPO}.json`, { version: 1, repoKey: REPO, writtenAt: new Date(NOW).toISOString(), memories: [memory(), memory({ id: "01JB8Z6X3T5Q9V2M4N7P8R1S0X", enabled: false })] });
    expect(await link.related(REPO, "shared/contracts.ts")).toEqual([{ id: "01JB8Z6X3T5Q9V2M4N7P8R1S0W", subject: "parseItemRef accepts bare keys" }]);
    expect(await link.related(REPO, "README.md")).toEqual([]);
    expect(await link.related("github.com/acme/web", "shared/contracts.ts")).toEqual([]);
  });

  it("writes suggestions to Memorise's inbox in the contract's shape, at most a few per run and never twice", async () => {
    const suggestions = Array.from({ length: SUGGESTIONS_PER_RUN + 2 }, (_, i) => ({ kind: "retire" as const, target: "01JB8Z6X3T5Q9V2M4N7P8R1S0W", reason: `r${i}`, key: `k${i}` }));
    expect(await link.send(REPO, suggestions)).toBe(SUGGESTIONS_PER_RUN);
    expect(await link.send(REPO, suggestions)).toBe(2);
    expect(await link.send(REPO, suggestions)).toBe(0);
    const inbox = join(interop(), "inbox", "github.com", "acme", "api");
    const files = readdirSync(inbox);
    expect(files).toHaveLength(SUGGESTIONS_PER_RUN + 2);
    expect(JSON.parse(readFileSync(join(inbox, files[0]), "utf8"))).toEqual({ version: 1, from: "contextualise", kind: "retire", targets: ["01JB8Z6X3T5Q9V2M4N7P8R1S0W"], reason: expect.stringMatching(/^r\d$/) });
  });
});
