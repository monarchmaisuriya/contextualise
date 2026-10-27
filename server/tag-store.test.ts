import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { TagStore } from "./tag-store";

let dir: string;
let store: TagStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "contextualise-"));
  store = new TagStore(async () => dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a missing file reads as no tags", async () => {
  expect(await store.read()).toEqual({});
});

test("tags with different spacing and case are one tag, keeping the first spelling", async () => {
  await store.add(" Auth   Rewrite ", { agentId: "a1", workspaceId: "w1" });
  await store.add("auth rewrite", { agentId: "a2", workspaceId: "w1" });
  const tags = await store.read();
  expect(Object.keys(tags)).toEqual(["auth rewrite"]);
  expect(tags["auth rewrite"].name).toBe("Auth Rewrite");
  expect(tags["auth rewrite"].agents.map((agent) => agent.agentId)).toEqual(["a1", "a2"]);
});

test("tagging an agent twice keeps one entry and reports nothing added", async () => {
  expect(await store.add("x", { agentId: "a1", workspaceId: "w1" })).toEqual({ tag: "x", added: true });
  expect(await store.add("X", { agentId: "a1", workspaceId: "w1" })).toEqual({ tag: "x", added: false });
  expect((await store.read()).x.agents).toHaveLength(1);
});

test("parallel adds all land", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.add("bulk", { agentId: `a${i}`, workspaceId: "w" })));
  const fresh = new TagStore(async () => dir);
  expect((await fresh.read()).bulk.agents).toHaveLength(20);
});

test("an empty name is rejected and nothing is written", async () => {
  await expect(store.add("   ", { agentId: "a1", workspaceId: "w1" })).rejects.toThrow("A tag needs a name");
  expect(await readdir(dir)).toEqual([]);
});

test("removing the last agent removes the tag; removing a non-member reports false", async () => {
  await store.add("x", { agentId: "a1", workspaceId: "w1" });
  expect(await store.remove("x", "nobody")).toEqual({ tag: "x", removed: false });
  expect(await store.remove("X", "a1")).toEqual({ tag: "x", removed: true });
  expect(await store.read()).toEqual({});
  expect(await store.remove("never-existed", "a1")).toEqual({ tag: "never-existed", removed: false });
});

test("writes leave only tags.json behind", async () => {
  await store.add("x", { agentId: "a1", workspaceId: "w1" });
  expect(await readdir(dir)).toEqual(["tags.json"]);
  expect(JSON.parse(await readFile(join(dir, "tags.json"), "utf8")).version).toBe(1);
});

test("a corrupt file fails loudly and is not overwritten", async () => {
  await writeFile(join(dir, "tags.json"), "{not json");
  await expect(store.read()).rejects.toThrow(join(dir, "tags.json"));
  await expect(store.add("x", { agentId: "a1", workspaceId: "w1" })).rejects.toThrow(join(dir, "tags.json"));
  expect(await readFile(join(dir, "tags.json"), "utf8")).toBe("{not json");
});

test("a file with the wrong shape fails loudly", async () => {
  await writeFile(join(dir, "tags.json"), JSON.stringify({ version: 2, tags: {} }));
  await expect(store.read()).rejects.toThrow("tags.json");
});
