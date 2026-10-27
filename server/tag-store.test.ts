import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { TagStore } from "./tag-store";

let dir: string;
let store: TagStore;
const agent = (agentId: string) => ({ agentId, workspaceId: "w1" });

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
  await store.add([" Auth   Rewrite "], agent("a1"));
  await store.add(["auth rewrite"], agent("a2"));
  const tags = await store.read();
  expect(Object.keys(tags)).toEqual(["auth rewrite"]);
  expect(tags["auth rewrite"].name).toBe("Auth Rewrite");
  expect(tags["auth rewrite"].agents.map((member) => member.agentId)).toEqual(["a1", "a2"]);
});

test("several tags in one call, each reporting whether it changed", async () => {
  await store.add(["x"], agent("a1"));
  expect(await store.add(["X", "y"], agent("a1"))).toEqual([
    { tag: "x", name: "x", changed: false },
    { tag: "y", name: "y", changed: true },
  ]);
  expect((await store.read()).x.agents).toHaveLength(1);
});

test("parallel adds all land", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.add(["bulk"], agent(`a${i}`))));
  const fresh = new TagStore(async () => dir);
  expect((await fresh.read()).bulk.agents).toHaveLength(20);
});

test("an empty name is rejected and nothing is written", async () => {
  await expect(store.add(["   "], agent("a1"))).rejects.toThrow("A tag needs a name");
  expect(await readdir(dir)).toEqual([]);
});

test("removing the last member removes the tag; removing a non-member changes nothing", async () => {
  await store.add(["x"], agent("a1"));
  expect(await store.remove(["x"], "nobody")).toEqual([{ tag: "x", name: "x", changed: false }]);
  expect(await store.remove(["X"], "a1")).toEqual([{ tag: "x", name: "x", changed: true }]);
  expect(await store.read()).toEqual({});
  expect(await store.remove(["never-existed"], "a1")).toEqual([{ tag: "never-existed", name: "never-existed", changed: false }]);
  expect(await readdir(dir)).toEqual(["tags.json"]);
});

test("links: added once, titled from the URL when no title is given, and keep the tag alive", async () => {
  expect(await store.addLink("Spec", { url: "https://example.com/specs/auth/" })).toEqual({ tag: "spec", name: "Spec", changed: true });
  expect((await store.addLink("spec", { url: "https://example.com/specs/auth/", title: "again" })).changed).toBe(false);
  await store.addLink("spec", { url: "https://example.com/b", title: " Design doc " });
  const links = (await store.read()).spec.links;
  expect(links.map((link) => link.title)).toEqual(["example.com/specs/auth", "Design doc"]);
  await store.add(["spec"], agent("a1"));
  await store.remove(["spec"], "a1");
  expect((await store.read()).spec.links).toHaveLength(2);
  await store.removeLink("spec", "https://example.com/specs/auth/");
  await store.removeLink("spec", "https://example.com/b");
  expect(await store.read()).toEqual({});
});

test("links that are not web addresses are refused", async () => {
  await expect(store.addLink("x", { url: "javascript:alert(1)" })).rejects.toThrow("https:// or http://");
  await expect(store.addLink("x", { url: "not a url" })).rejects.toThrow("web address");
  await expect(store.addLink("x", { url: "file:///etc/passwd" })).rejects.toThrow("https:// or http://");
});

test("a version 1 file is read and rewritten as version 2 on the next change", async () => {
  const v1 = { version: 1, tags: { x: { name: "X", agents: [{ agentId: "a1", workspaceId: "w1", taggedAt: "t" }] } } };
  await writeFile(join(dir, "tags.json"), JSON.stringify(v1));
  expect(await store.read()).toEqual({ x: { name: "X", agents: v1.tags.x.agents, links: [], notes: [] } });
  await store.addLink("x", { url: "https://example.com" });
  const saved = JSON.parse(await readFile(join(dir, "tags.json"), "utf8"));
  expect(saved.version).toBe(3);
  expect(saved.tags.x.agents).toEqual(v1.tags.x.agents);
});

test("a corrupt file fails loudly and is not overwritten", async () => {
  await writeFile(join(dir, "tags.json"), "{not json");
  await expect(store.read()).rejects.toThrow(join(dir, "tags.json"));
  await expect(store.add(["x"], agent("a1"))).rejects.toThrow(join(dir, "tags.json"));
  expect(await readFile(join(dir, "tags.json"), "utf8")).toBe("{not json");
});

test("a file from a newer plugin version fails loudly", async () => {
  await writeFile(join(dir, "tags.json"), JSON.stringify({ version: 4, tags: {} }));
  await expect(store.read()).rejects.toThrow("tags.json");
});

test("fetched items: added as fetching, updated in place with the text capped, and keep the tag alive", async () => {
  const added = await store.addNote("Spec", { vendor: "jira", ref: "PROJ-1" });
  expect(added).toMatchObject({ tag: "spec", changed: true });
  expect((await store.addNote("spec", { vendor: "jira", ref: "PROJ-1" })).noteId).toBe(added.noteId);
  await store.updateNote("spec", added.noteId, { status: "ready", title: "Login fails", text: "x".repeat(20_000), fetchedAt: "t" });
  const [note] = (await store.read()).spec.notes;
  expect(note).toMatchObject({ vendor: "jira", ref: "PROJ-1", title: "Login fails", status: "ready" });
  expect(note.text.length).toBe(8_000);
  expect(note.text.endsWith(" […]")).toBe(true);
  expect(await store.removeNote("spec", added.noteId)).toMatchObject({ changed: true });
  expect(await store.read()).toEqual({});
});

test("fetches cut off by a restart are marked failed", async () => {
  const { noteId } = await store.addNote("x", { vendor: "slack", ref: "https://a.slack.com/archives/C1/p1" });
  expect(await store.failInterruptedFetches()).toBe(1);
  expect((await store.read()).x.notes.find((note) => note.id === noteId)).toMatchObject({ status: "failed", error: expect.stringContaining("interrupted") });
  expect(await store.failInterruptedFetches()).toBe(0);
});

test("a version 2 file is read with no notes and written back as version 3", async () => {
  const v2 = { version: 2, tags: { x: { name: "X", agents: [], links: [{ url: "https://e.com/", title: "e", taggedAt: "t" }] } } };
  await writeFile(join(dir, "tags.json"), JSON.stringify(v2));
  expect((await store.read()).x.notes).toEqual([]);
  await store.addNote("x", { vendor: "notion", ref: "https://www.notion.so/a" });
  const saved = JSON.parse(await readFile(join(dir, "tags.json"), "utf8"));
  expect(saved.version).toBe(3);
  expect(saved.tags.x.links).toEqual(v2.tags.x.links);
});
