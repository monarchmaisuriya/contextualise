import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderListings, listFolderFiles, rankEntries, searchAttachedFiles } from "./attached-files";

const options = { titleMaxChars: 44, prefix: "none" as const };

describe("attached files", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-attached-files-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const write = (path: string, text = "x") => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  const gitRepo = (folder: string) => {
    execFileSync("git", ["init", "-q", folder]);
    execFileSync("git", ["-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"]);
  };
  const commit = (folder: string) => {
    execFileSync("git", ["-C", folder, "add", "-A"]);
    execFileSync("git", ["-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "files"]);
  };

  describe("listFolderFiles", () => {
    it("lists a git folder's tracked and untracked files, without gitignored ones", async () => {
      const repo = join(root, "api");
      gitRepo(repo);
      write(join(repo, ".gitignore"), "secret.txt\n");
      write(join(repo, "src", "queue.ts"));
      write(join(repo, "secret.txt"));
      commit(repo);
      write(join(repo, "notes.md"));
      expect((await listFolderFiles(repo)).sort()).toEqual([".gitignore", "notes.md", "src/queue.ts"]);
    });

    it("lists an attached subfolder of a repository relative to that subfolder", async () => {
      const repo = join(root, "mono");
      gitRepo(repo);
      write(join(repo, "web", "app.ts"));
      write(join(repo, "api", "main.go"));
      commit(repo);
      expect(await listFolderFiles(join(repo, "web"))).toEqual(["app.ts"]);
    });

    it("lists the files of a nested repository and of a checked-out submodule, and none from one not checked out", async () => {
      const repo = join(root, "app");
      gitRepo(repo);
      write(join(repo, "main.ts"));
      const lib = join(root, "lib");
      gitRepo(lib);
      write(join(lib, "index.ts"));
      commit(lib);
      execFileSync("git", ["-C", repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "modules/core"]);
      execFileSync("git", ["-C", repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "modules/blank"]);
      commit(repo);
      rmSync(join(repo, "modules", "blank"), { recursive: true, force: true });
      mkdirSync(join(repo, "modules", "blank"));
      const nested = join(repo, "tools");
      gitRepo(nested);
      write(join(nested, "run.sh"));
      expect((await listFolderFiles(repo)).sort()).toEqual([".gitmodules", "main.ts", "modules/core/index.ts", "tools/run.sh"]);
    });

    it("lists a conflicted file once", async () => {
      const repo = join(root, "merge");
      gitRepo(repo);
      write(join(repo, "f.txt"), "base");
      commit(repo);
      execFileSync("git", ["-C", repo, "switch", "-q", "-c", "other"]);
      write(join(repo, "f.txt"), "other");
      commit(repo);
      execFileSync("git", ["-C", repo, "switch", "-q", "-"]);
      write(join(repo, "f.txt"), "main");
      commit(repo);
      expect(() => execFileSync("git", ["-C", repo, "merge", "-q", "other"], { stdio: "ignore" })).toThrow();
      expect(await listFolderFiles(repo)).toEqual(["f.txt"]);
    });

    it("walks an attached folder that its repository ignores", async () => {
      const repo = join(root, "site");
      gitRepo(repo);
      write(join(repo, ".gitignore"), "generated/\n");
      write(join(repo, "generated", "page.html"));
      commit(repo);
      expect(await listFolderFiles(join(repo, "generated"))).toEqual(["page.html"]);
    });

    it("lists a folder outside git without hidden files, skipped folders, or nested repositories' ignored files", async () => {
      const folder = join(root, "notes");
      write(join(folder, "plan.md"));
      write(join(folder, ".env"), "TOKEN=1");
      write(join(folder, "node_modules", "lib", "index.js"));
      const nested = join(folder, "tools");
      gitRepo(nested);
      write(join(nested, ".gitignore"), "build/\n");
      write(join(nested, "run.sh"));
      write(join(nested, "build", "out.bin"));
      commit(nested);
      expect((await listFolderFiles(folder)).sort()).toEqual(["plan.md", "tools/.gitignore", "tools/run.sh"]);
    });
  });

  describe("FolderListings", () => {
    it("lists a folder once within the cache time, again after it, and never keeps a failure", async () => {
      let now = 0;
      const list = vi.fn(async (folder: string) => [`${folder}.md`]);
      const listings = new FolderListings(list, 10_000, () => now);
      await Promise.all([listings.files("a"), listings.files("a")]);
      expect(await listings.files("a")).toEqual(["a.md"]);
      expect(list).toHaveBeenCalledTimes(1);
      now = 10_001;
      await listings.files("a");
      expect(list).toHaveBeenCalledTimes(2);
      list.mockRejectedValueOnce(new Error("gone"));
      await expect(listings.files("b")).rejects.toThrow("gone");
      expect(await listings.files("b")).toEqual(["b.md"]);
    });

    it("answers from an expired listing while the new one is read, then from the new one, and drops listings unused for a minute", async () => {
      let now = 0;
      let finish: (files: string[]) => void = () => {};
      const list = vi.fn(async () => ["old.md"]);
      const listings = new FolderListings(list, 10_000, () => now);
      await listings.files("a");
      list.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      now = 10_001;
      expect(await listings.files("a")).toEqual(["old.md"]);
      expect(await listings.files("a")).toEqual(["old.md"]);
      finish(["new.md"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await listings.files("a")).toEqual(["new.md"]);
      expect(list).toHaveBeenCalledTimes(2);
      now = 100_000;
      await listings.files("b");
      now = 100_001;
      // "a" was dropped, so it is listed again and waited for, not answered from the old listing.
      list.mockResolvedValueOnce(["again.md"]);
      expect(await listings.files("a")).toEqual(["again.md"]);
    });
  });

  describe("rankEntries", () => {
    const api = { path: "/w/api", name: "api" };
    const files = ["src/queue.ts", "src/queue/worker.ts", "docs/queue-design.md", "README.md", "src/jobs/requeue.ts", "src/jobs/backoff.ts"];

    it("puts an exact name first, then names that start with the words, contain them, and paths that do", () => {
      const ranked = rankEntries([{ folder: api, files }], "queue", 10).map((entry) => entry.path);
      expect(ranked).toEqual(["src/queue", "src/queue.ts", "docs/queue-design.md", "src/jobs/requeue.ts", "src/queue/worker.ts"]);
    });

    it("matches every word anywhere in the path, ignoring case", () => {
      expect(rankEntries([{ folder: api, files }], "JOBS back", 10).map((entry) => entry.path)).toEqual(["src/jobs/backoff.ts"]);
    });

    it("offers each attached folder and its top-level entries when nothing is typed, folders first", () => {
      const web = { path: "/w/web", name: "web" };
      const ranked = rankEntries([{ folder: api, files }, { folder: web, files: ["index.html"] }], " ", 10);
      expect(ranked.map((entry) => [entry.folder.name, entry.path, entry.kind])).toEqual([
        ["api", "", "folder"],
        ["web", "", "folder"],
        ["api", "docs", "folder"],
        ["api", "src", "folder"],
        ["api", "README.md", "file"],
        ["web", "index.html", "file"],
      ]);
    });

    it("returns at most the limit", () => {
      expect(rankEntries([{ folder: api, files }], "s", 2)).toHaveLength(2);
    });
  });

  describe("searchAttachedFiles", () => {
    let repo: string;
    beforeEach(() => {
      repo = join(root, "dashboard");
      gitRepo(repo);
      write(join(repo, "src", "automation", "useActivateAutomation.ts"));
      write(join(repo, "src", "removed.ts"));
      commit(repo);
    });
    const search = (query: string, prefix: "none" | "word" = "none", titleMaxChars = 44) =>
      searchAttachedFiles([{ path: repo, name: "dashboard" }], new FolderListings(listFolderFiles), query, { titleMaxChars, prefix });

    it("gives a file row its absolute path as id, its path in the project as title, and the project in its subtitle", async () => {
      const [row] = await search("useActivate");
      expect(row).toMatchObject({
        id: join(repo, "src/automation/useActivateAutomation.ts"),
        identifier: "",
        title: "src/automation/useActivateAutomation.ts",
        subtitle: "dashboard · src/automation/useActivateAutomation.ts",
        url: `file://${join(repo, "src/automation/useActivateAutomation.ts")}`,
        resourceType: "attached-file",
      });
    });

    it("attaches a reference, not the content, saying where to read it", async () => {
      const [file] = await search("useActivate");
      expect(file.text).toContain(`File ${JSON.stringify(join(repo, "src/automation/useActivateAutomation.ts"))}`);
      expect(file.text).toContain('in the attached project "dashboard"');
      expect(file.text).toContain("Its content is not included");
      expect(file.text).not.toContain("\nx");
      const folder = (await search("automation")).find((row) => row.title === "src/automation");
      expect(folder?.text).toContain(`Folder ${JSON.stringify(join(repo, "src/automation"))}`);
    });

    it("leaves out a deleted tracked file", async () => {
      rmSync(join(repo, "src", "removed.ts"));
      expect((await search("removed")).map((row) => row.title)).toEqual([]);
    });

    it("keeps the end of a long path in the title, and labels rows when asked", async () => {
      const [row] = await search("useActivate", "word", 30);
      expect(row.title).toBe("…/useActivateAutomation.ts");
      // A name longer than the limit keeps its end.
      expect((await search("useActivate", "none", 20))[0].title).toBe("…tivateAutomation.ts");
      expect(row.identifier).toBe("File");
    });

    it("tells rows apart whose titles would look the same, by the folder where their paths differ", async () => {
      for (const kind of ["email-automation", "sms-automation"]) write(join(repo, "src", "modules", kind, "hooks", "useActivateAutomation.ts"));
      write(join(repo, "src", "a", "index.ts"));
      write(join(repo, "src", "b", "index.ts"));
      const web = join(root, "web");
      gitRepo(web);
      write(join(web, "src", "a", "index.ts"));
      const titles = async (query: string) =>
        (await searchAttachedFiles([{ path: repo, name: "dashboard" }, { path: web, name: "web" }], new FolderListings(listFolderFiles), query, options)).map((row) => row.title).sort();
      expect(await titles("useActivateAutomation")).toEqual(["email-automation/…/useActivateAutomation.ts", "sms-automation/…/useActivateAutomation.ts", "src/automation/useActivateAutomation.ts"]);
      // Only titles that collide change; the same path in two projects is told apart by the project.
      expect(await titles("index.ts")).toEqual(["dashboard/…/index.ts", "src/b/index.ts", "web/…/index.ts"]);
    });

    // Paseo keeps a row when every word is in its label ("identifier title") or id, or else every word
    // is in its subtitle (app/src/components/ui/combobox-options.ts), each word inside one field.
    it("returns rows Paseo's own filter keeps", async () => {
      for (const query of ["useActivate", "src automation", "AUTO", "dashboard src"]) {
        const rows = await search(query);
        expect(rows.length, query).toBeGreaterThan(0);
        const words = query.toLowerCase().split(/\s+/);
        for (const row of rows) {
          const has = (fields: string[]) => words.every((word) => fields.some((field) => field.toLowerCase().includes(word)));
          expect(has([`${row.identifier} ${row.title}`, row.id]) || has([row.subtitle ?? ""]),`${query}: ${row.id}`).toBe(true);
        }
      }
    });

    it("keeps a path with a newline on one line of the text", async () => {
      write(join(repo, "odd\nname.md"));
      const [row] = await search("odd");
      expect(row.text.split("\n").filter((line) => line.startsWith("File"))).toHaveLength(1);
    });

    it("searches the other folders when one cannot be listed", async () => {
      const gone = { path: join(root, "gone"), name: "gone" };
      const rows = await searchAttachedFiles([gone, { path: repo, name: "dashboard" }], new FolderListings(listFolderFiles), "useActivate", options);
      expect(rows.map((row) => row.title)).toEqual(["src/automation/useActivateAutomation.ts"]);
    });
  });
});
