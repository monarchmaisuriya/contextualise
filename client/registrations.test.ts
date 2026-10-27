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
  const client = new Proxy(
    {
      addTimelineRenderer: (r: { kind: string; version: number }) => {
        expect(Number.isInteger(r.version) && r.version >= 1).toBe(true);
        return accept("timeline renderer kind", r.kind);
      },
      addSlashCommand: (c: { name: string }) => accept("slash command name", c.name),
    },
    { get: (target, prop: string) => (target as Record<string, unknown>)[prop] ?? ((c: { id: string }) => accept(prop, c.id)) },
  );
  const { default: contribute } = await import("../index.client");
  const cleanup = contribute(client as never);
  expect(seen.get("timeline renderer kind")?.size).toBe(1);
  expect(seen.get("addAttachmentSource")?.size).toBe(3);
  cleanup();
});
