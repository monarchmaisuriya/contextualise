import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { PaseoApi } from "./paseo-types";
import { LOCKDOWN, runWorker } from "./workers";

// Modes Paseo 0.13 accepts (from its error for "read-only"), and the lockdown each worker needs.
test("fetch workers start in a mode Paseo accepts, locked down", () => {
  expect(["auto", "auto-review"]).toContain(LOCKDOWN.codex.modeId);
  expect(LOCKDOWN.codex.options).toMatchObject({ sandbox_mode: "read-only", web_search: "disabled" });
  expect(LOCKDOWN.claude.modeId).toBe("default");
  expect(LOCKDOWN.claude.options).toMatchObject({ disallowedTools: expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch", "mcp__paseo"]) });
});

test("gives up when the worker cannot be started in time, archives one that starts late, and frees later runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "contextualise-workers-"));
  let releaseCreate: (handle: unknown) => void = () => undefined;
  const archive = vi.fn(async () => {});
  const create = vi.fn(() => new Promise((done) => (releaseCreate = done)));
  const paseo = {
    workspaces: {
      list: async () => ({ entries: [{ id: "w1", workspaceDirectory: join(root, "workers") }], pageInfo: { hasMore: false } }),
      ref: () => ({ agents: { create } }),
    },
    providers: { listModels: async () => ({ models: [{ id: "claude-x" }] }) },
  } as unknown as PaseoApi;
  const job = { provider: "claude" as const, title: "t", prompt: "p", model: "claude-x", timeoutMs: 300, outputSchema: {}, notify: false };
  try {
    const started = Date.now();
    await expect(runWorker(paseo, root, job, () => undefined)).rejects.toThrow("did not start");
    expect(Date.now() - started).toBeLessThan(2_000);
    releaseCreate({ id: "late", archive });
    await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
    await expect(runWorker(paseo, root, job, () => undefined)).rejects.toThrow("did not start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Paseo raises "Agent finished" for an agent unless it is a background agent, so a worker is created
// as one unless the "notify when a helper agent finishes" setting is on.
test.each([
  [false, true],
  [true, false],
])("a worker with notify %s is created with background %s", async (notify, background) => {
  const root = await mkdtemp(join(tmpdir(), "contextualise-workers-"));
  const create = vi.fn(async () => ({ id: "a1", run: async () => ({ finalText: "done" }), wait: async () => ({ finalText: "done" }), archive: async () => {} }));
  const paseo = {
    workspaces: {
      list: async () => ({ entries: [{ id: "w1", workspaceDirectory: join(root, "workers") }], pageInfo: { hasMore: false } }),
      ref: () => ({ agents: { create } }),
    },
    providers: { listModels: async () => ({ models: [{ id: "claude-x" }] }) },
  } as unknown as PaseoApi;
  try {
    await runWorker(paseo, root, { provider: "claude", title: "t", prompt: "p", model: "claude-x", timeoutMs: 1_000, outputSchema: {}, notify }, () => undefined).catch(() => undefined);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ background }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
