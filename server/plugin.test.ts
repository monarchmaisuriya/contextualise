import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addLinkRpc, addTagRpc, describeAgentRpc, fetchItemRpc, fetchRouteRpc, listTagsRpc, pinAgentRpc, previewTagRpc, refreshNoteRpc, removeLinkRpc, removeNoteRpc, removeTagRpc, searchTagsRpc, snapshotSettingsSchema, type SnapshotSettings } from "../shared/contracts";
import { contributeTags, TAGS_OFF } from "./plugin";

type Handler = (input: unknown, context: unknown) => Promise<unknown>;

let home: string;
let values: SnapshotSettings;
let listeners: ((state: unknown) => void)[];
let rpcs: Map<string, Handler>;
let stop: () => Promise<void>;
const paseo = {
  agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) },
  workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) },
};
const call = (name: string, input: unknown) => (rpcs.get(name) as Handler)(input, { paseo });
const save = (next: Partial<SnapshotSettings>) => {
  values = { ...values, ...next };
  for (const listener of listeners) listener({ status: "ready", revision: "r", values });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  home = mkdtempSync(join(tmpdir(), "contextualise-tags-"));
  values = snapshotSettingsSchema.parse({ knowledgeEnabled: false, historyTools: false, knowledgePort: 47_000 + Math.floor(Math.random() * 1_000) });
  listeners = [];
  rpcs = new Map();
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "r", values }),
      subscribe: (listener: (state: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    }),
    handle: (contract: { name: string }, handler: Handler) => rpcs.set(contract.name, handler),
    on: () => {},
    before: () => {},
  };
  stop = contributeTags(server as never, async () => join(home, "plugin-data", "contextualise"));
});
afterEach(async () => {
  await stop();
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

it("refuses every tag call while tags are off, keeps what was stored, and serves it again when switched back on", async () => {
  await call(addTagRpc.name, { tags: ["auth"], agentId: "a1", workspaceId: "w1" });
  save({ tagsEnabled: false });
  const tagCalls: [{ name: string }, unknown][] = [
    [addTagRpc, { tags: ["billing"], agentId: "a1", workspaceId: "w1" }],
    [removeTagRpc, { tags: ["auth"], agentId: "a1" }],
    [listTagsRpc, {}],
    [describeAgentRpc, { agentId: "a1" }],
    [previewTagRpc, { tag: "auth" }],
    [searchTagsRpc, { query: "" }],
    [addLinkRpc, { tag: "auth", url: "https://example.com" }],
    [removeLinkRpc, { tag: "auth", url: "https://example.com" }],
    [fetchItemRpc, { tag: "auth", ref: "PROJ-1" }],
    [fetchRouteRpc, { ref: "PROJ-1" }],
    [refreshNoteRpc, { tag: "auth", noteId: "n1" }],
    [removeNoteRpc, { tag: "auth", noteId: "n1" }],
  ];
  // A tag call added later must be added here too, so it cannot slip past the guard unnoticed.
  const listed = new Set(tagCalls.map(([{ name }]) => name));
  for (const name of rpcs.keys()) if (name.startsWith("tags.")) expect(listed.has(name), `${name} is not checked while tags are off`).toBe(true);
  for (const [{ name }, input] of tagCalls) {
    expect(rpcs.has(name), name).toBe(true);
    await expect(call(name, input), name).rejects.toThrow(TAGS_OFF);
  }
  // Pinning orders Attach > Chat; it is not a tag feature and keeps working.
  await expect(call(pinAgentRpc.name, { agentId: "a1", pinned: true })).resolves.toMatchObject({ pinned: true });
  save({ tagsEnabled: true });
  const { tags } = (await call(listTagsRpc.name, {})) as { tags: { name: string; agents: { agentId: string }[] }[] };
  expect(tags.map((tag) => [tag.name, tag.agents.map((agent) => agent.agentId)])).toEqual([["auth", ["a1"]]]);
});

it("runs the refresh timer only while both tags and keeping items up to date are on", async () => {
  save({ autoRefreshItems: true });
  expect(vi.getTimerCount()).toBe(1);
  save({ tagsEnabled: false });
  expect(vi.getTimerCount()).toBe(0);
  save({ tagsEnabled: true });
  expect(vi.getTimerCount()).toBe(1);
});
