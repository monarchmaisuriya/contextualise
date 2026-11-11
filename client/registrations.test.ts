import { expect, test, vi } from "vitest";
import { pinAgentRpc } from "../shared/contracts";
import { tagsChanged } from "./tag-events";

// The app (not the daemon) checks client registrations, so a bad name only shows up as a failed
// plugin in Paseo. This runs the real index.client.tsx against a fake client that applies the
// app's rules, copied from Paseo 0.13's registry: names match /^[a-z][a-z0-9-]*$/ and are unique.
vi.mock("react-native", () => ({ Pressable: () => null, Text: () => null, View: () => null }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => null, useAgent: () => null, useWorkspace: () => null, useSettings: () => null }));
vi.mock("@getpaseo/plugin/client/ui", () => ({}));
vi.mock("@tanstack/react-query", () => ({}));

const PASEO_NAME = /^[a-z][a-z0-9-]*$/;

// The fake client keeps what is registered now: a remover takes its name out again.
function fakeClient(settings: () => Record<string, unknown>) {
  const seen = new Map<string, Set<string>>();
  const calls: string[] = [];
  const accept = (kind: string, name: string) => {
    expect(name, `${kind} "${name}"`).toMatch(PASEO_NAME);
    const names = seen.get(kind) ?? new Set();
    expect(names.has(name), `duplicate ${kind} "${name}"`).toBe(false);
    seen.set(kind, names.add(name));
    return () => {
      names.delete(name);
    };
  };
  const pills: { agentId: string; id: string; label?: string }[] = [];
  const registered = new Map<string, unknown>();
  const subscription = {
    subscribe: (observer: { snapshot(s: unknown): void }) => {
      observer.snapshot({ entries: [{ agent: { id: "a1", workspaceId: "w1" } }, { agent: { id: "a2", workspaceId: "w1", archivedAt: "t" } }] });
      return () => {};
    },
  };
  const tags = [{ key: "auth", name: "auth", hasWorkspaceLabel: false, workspaces: [], links: [], agents: [{ agentId: "a1", workspaceId: "w1", taggedAt: "t", title: null, provider: "claude", state: "active" }] }];
  const client = new Proxy(
    {
      paseo: { agents: { list: async () => ({ subscription }) } },
      rpc: async (contract: { name: string }) => {
        calls.push(contract.name);
        return contract.name.startsWith("settings.")
          ? { status: "ready", revision: "r", values: settings() }
          : contract.name === "links.files-available"
            ? { available: true }
            : contract.name === "links.count"
              ? { count: 1 }
              : { tags };
      },
      addTimelineRenderer: (r: { kind: string; version: number }) => {
        expect(Number.isInteger(r.version) && r.version >= 1).toBe(true);
        return accept("timeline renderer kind", r.kind);
      },
      addSlashCommand: (c: { name: string }) => accept("slash command name", c.name),
      addComposerPill: (p: { id: string; agentId: string; button: { label?: string } }) => {
        expect(p.id).toMatch(PASEO_NAME);
        const pill = { agentId: p.agentId, id: p.id, label: p.button.label };
        pills.push(pill);
        return { update: (patch: { label?: string }) => Object.assign(pill, patch), remove: () => {} };
      },
    },
    {
      get: (target, prop: string) =>
        (target as Record<string, unknown>)[prop] ??
        ((c: { id: string }) => {
          registered.set(c.id, c);
          return accept(prop, c.id);
        }),
    },
  );
  const names = (kind: string) => [...(seen.get(kind) ?? [])];
  return { client, names, pills, registered, calls };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("every name the plugin registers in the app is one Paseo accepts", async () => {
  const { client, names, pills, registered } = fakeClient(() => ({ showPill: true, pillLabel: "count" }));
  const { default: contribute } = await import("../index.client");
  const cleanup = contribute(client as never);
  await settled();
  expect(names("timeline renderer kind")).toEqual(["receipt", "history-note", "fetch-result"]);
  // Attach > Tag is added once the settings say tags are on; Attach > Project file once a workspace
  // has an attached project.
  expect(names("addAttachmentSource").sort()).toEqual(["agent", "attached-file", "knowledge", "tag", "terminal"]);
  // Paseo lists sources in registration order: Project (knowledge) stays right after Chat, and Tag,
  // added once the settings are read, comes after the sources registered at start.
  expect(names("addAttachmentSource").filter((name) => name !== "attached-file")).toEqual(["agent", "knowledge", "terminal", "tag"]);
  expect(names("addCommandCenterItem")).toEqual(["pin-agent", "unpin-agent", "open-knowledge", "open-workspace-knowledge", "tag-agent", "open-tags"]);
  expect(names("slash command name")).toEqual(["history", "tag", "untag", "tag-link", "tag-fetch"]);
  expect(names("addWorkspacePanel")).toEqual(["knowledge"]);
  expect(pills).toEqual([
    { agentId: "a1", id: "tags", label: "1 tag", visible: true },
    { agentId: "a1", id: "linked-projects", label: "Attached (1)" },
  ]);
  // Pin and Unpin each set their own state, so selecting one twice never flips it back.
  for (const [id, pinned] of [["pin-agent", true], ["unpin-agent", false], ["pin-agent", true]] as const) {
    const rpc = vi.fn(async () => ({}));
    await (registered.get(id) as { onSelect(context: unknown): Promise<void> }).onSelect({ agent: { id: "a1", workspaceId: "w1" }, rpc });
    expect(rpc).toHaveBeenCalledWith(pinAgentRpc, { agentId: "a1", pinned });
  }
  cleanup();
});

test("while tags are off nothing tag-only is registered, and switching them on in this client adds it all", async () => {
  let values: Record<string, unknown> = { tagsEnabled: false };
  const { client, names, pills, calls } = fakeClient(() => values);
  const { default: contribute } = await import("../index.client");
  const cleanup = contribute(client as never);
  await settled();
  expect(names("addAttachmentSource")).not.toContain("tag");
  expect(names("slash command name")).toEqual(["history"]);
  expect(names("addCommandCenterItem")).toEqual(["pin-agent", "unpin-agent", "open-knowledge", "open-workspace-knowledge"]);
  expect(pills.find((pill) => pill.id === "tags")).toMatchObject({ visible: false });
  expect(calls).not.toContain("tags.list");
  values = { tagsEnabled: true };
  tagsChanged();
  await settled();
  expect(names("addAttachmentSource")).toContain("tag");
  expect(names("slash command name")).toEqual(["history", "tag", "untag", "tag-link", "tag-fetch"]);
  expect(names("addCommandCenterItem")).toContain("open-tags");
  expect(pills.find((pill) => pill.id === "tags")).toMatchObject({ visible: true });
  values = { tagsEnabled: false };
  tagsChanged();
  await settled();
  expect(names("slash command name")).toEqual(["history"]);
  cleanup();
});
