import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { linkableFolder, linkedProviderOptions, MAX_LINKS, WorkspaceLinks } from "./links";

// Paseo 0.14.0's own checks for these two keys (agent/providers/claude/options.js and
// codex/options.js), reduced to the parts a link touches. Both are strict: an unknown key fails the chat.
const claudeOptions = z.object({ additionalDirectories: z.array(z.string()).optional(), allowedTools: z.array(z.string()).optional() }).strict();
const codexOptions = z
  .object({
    sandbox_mode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    sandbox_workspace_write: z.object({ writable_roots: z.array(z.string()).optional(), network_access: z.boolean().optional() }).strict().optional(),
  })
  .strict();

describe("linkableFolder", () => {
  let root: string;
  let workspace: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-links-")));
    workspace = join(root, "web");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(root, "api"));
  });

  it("returns another project's folder as a real path, following symlinks", async () => {
    symlinkSync(join(root, "api"), join(root, "api-link"));
    expect(await linkableFolder(` ${join(root, "api-link")} `, workspace)).toBe(join(root, "api"));
  });

  it("refuses what is not a folder, does not exist, is too broad, or overlaps the workspace", async () => {
    writeFileSync(join(root, "notes.txt"), "x");
    await expect(linkableFolder(join(root, "gone"), workspace)).rejects.toThrow("does not exist");
    await expect(linkableFolder(join(root, "notes.txt"), workspace)).rejects.toThrow("is not a folder");
    await expect(linkableFolder("/", workspace)).rejects.toThrow("too broad");
    await expect(linkableFolder(homedir(), workspace)).rejects.toThrow("too broad");
    await expect(linkableFolder("~", workspace)).rejects.toThrow("too broad");
    await expect(linkableFolder(workspace, workspace)).rejects.toThrow("overlaps");
    await expect(linkableFolder(join(workspace, "src"), workspace)).rejects.toThrow("overlaps");
    await expect(linkableFolder(root, workspace)).rejects.toThrow("overlaps");
  });
});

describe("WorkspaceLinks", () => {
  let dir: string;
  let links: WorkspaceLinks;
  const link = (path: string) => ({ path, repoKey: null, addedAt: "2026-11-02T00:00:00.000Z" });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "contextualise-links-store-"));
    links = new WorkspaceLinks(async () => dir);
  });

  it("keeps each workspace's links apart, refuses duplicates and more than the limit, and removes", async () => {
    await links.add("w1", link("/a"));
    await expect(links.add("w1", link("/a"))).rejects.toThrow("already linked");
    expect(await links.list("w2")).toEqual([]);
    for (let i = 1; i < MAX_LINKS; i += 1) await links.add("w1", link(`/b${i}`));
    await expect(links.add("w1", link("/c"))).rejects.toThrow(`at most ${MAX_LINKS}`);
    expect((await links.remove("w1", "/a")).map((found) => found.path)).not.toContain("/a");
    await expect(links.remove("w1", "/a")).rejects.toThrow("not linked");
    expect(JSON.parse(readFileSync(join(dir, "links.json"), "utf8")).workspaces.w1).toHaveLength(MAX_LINKS - 1);
  });

  it("drops a workspace from the file when its last link is removed, and serializes writes", async () => {
    await Promise.all([links.add("w1", link("/a")), links.add("w1", link("/b")), links.add("w2", link("/a"))]);
    expect((await links.list("w1")).map((found) => found.path).sort()).toEqual(["/a", "/b"]);
    await links.remove("w2", "/a");
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "links.json"), "utf8")).workspaces)).toEqual(["w1"]);
  });

  it("names the file when it cannot be read", async () => {
    writeFileSync(join(dir, "links.json"), JSON.stringify({ version: 2 }));
    await expect(links.list("w1")).rejects.toThrow(/links\.json could not be read/);
  });
});

describe("linkedProviderOptions", () => {
  it("adds the folders to Claude's additional directories, keeping what was set and passing Paseo's check", () => {
    const options = linkedProviderOptions("claude", { additionalDirectories: ["/x", "/a"], allowedTools: ["Read"] }, ["/a", "/b"]);
    expect(options).toEqual({ additionalDirectories: ["/x", "/a", "/b"], allowedTools: ["Read"] });
    expect(claudeOptions.safeParse(options).success).toBe(true);
  });

  it("adds the folders to Codex's writable roots, keeping its other sandbox settings and passing Paseo's check", () => {
    const options = linkedProviderOptions("codex", { sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: true } }, ["/a"]);
    expect(options).toEqual({ sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: true, writable_roots: ["/a"] } });
    expect(codexOptions.safeParse(options).success).toBe(true);
    expect(codexOptions.safeParse(linkedProviderOptions("codex", undefined, ["/a"])).success).toBe(true);
  });

  it("gives any other provider nothing, so Paseo's strict check cannot fail the chat", () => {
    expect(linkedProviderOptions("opencode", {}, ["/a"])).toBeNull();
  });
});
