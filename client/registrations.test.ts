import { expect, test, vi } from "vitest";

// The app (not the daemon) checks client registrations, so a bad name only shows up as a failed
// plugin in Paseo. This runs the real index.client.tsx against a fake client that applies the
// app's rules, copied from Paseo 0.13's registry: names match /^[a-z][a-z0-9-]*$/ and are unique.
vi.mock("react-native", () => ({ Pressable: () => null, Text: () => null, View: () => null }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => null, useAgent: () => null, useWorkspace: () => null, useSettings: () => null }));
vi.mock("@getpaseo/plugin/client/ui", () => ({}));
vi.mock("@tanstack/react-query", () => ({}));

const PASEO_NAME = /^[a-z][a-z0-9-]*$/;

test("every name the plugin registers in the app is one Paseo accepts", async () => {
  const seen = new Map<string, Set<string>>();
  const accept = (kind: string, name: string) => {
    expect(name, `${kind} "${name}"`).toMatch(PASEO_NAME);
    const names = seen.get(kind) ?? new Set();
    expect(names.has(name), `duplicate ${kind} "${name}"`).toBe(false);
    seen.set(kind, names.add(name));
    return () => {};
  };
  const pills: { agentId: string; id: string; label?: string }[] = [];
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
      rpc: async (contract: { name: string }) => (contract.name.startsWith("settings.") ? { status: "ready", revision: "r", values: { showPill: true, pillLabel: "count" } } : { tags }),
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
    { get: (target, prop: string) => (target as Record<string, unknown>)[prop] ?? ((c: { id: string }) => accept(prop, c.id)) },
  );
  const { default: contribute } = await import("../index.client");
  const cleanup = contribute(client as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect([...(seen.get("timeline renderer kind") ?? [])]).toEqual(["receipt", "fetch-result"]);
  expect(seen.get("addAttachmentSource")?.size).toBe(3);
  expect([...(seen.get("addCommandCenterItem") ?? [])]).toEqual(["tag-agent", "pin-agent", "unpin-agent", "open-tags"]);
  expect([...(seen.get("slash command name") ?? [])]).toEqual(["tag", "untag", "tag-link", "tag-fetch"]);
  expect(pills).toEqual([{ agentId: "a1", id: "tags", label: "1 tag", visible: true }]);
  cleanup();
});
