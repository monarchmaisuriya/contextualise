import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "./base";
import { KnowledgeService } from "./service";
import { SymbolReader } from "./symbols";

const commit = (top: string, message: string) => {
  execFileSync("git", ["-C", top, "add", "-A"]);
  execFileSync("git", ["-C", top, "-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-q", "-m", message]);
};

describe("KnowledgeService facts and areas", () => {
  let top: string;
  let home: string;
  let base: KnowledgeBase;
  let service: KnowledgeService;

  beforeEach(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), "contextualise-service-repo-")));
    home = mkdtempSync(join(tmpdir(), "contextualise-service-data-"));
    base = new KnowledgeBase({ root: async () => join(home, "plugin-data", "contextualise"), symbols: new SymbolReader(async () => process.cwd()), indexOptions: async () => ({ codeSymbols: true }) });
    service = new KnowledgeService(base, async () => null);
    mkdirSync(join(top, "core"));
    mkdirSync(join(top, "api"));
    mkdirSync(join(top, "api", "docs"));
    // Areas need three files each, or they are listed together as "Other".
    for (const name of ["__init__.py", "utils.py"]) {
      writeFileSync(join(top, "core", name), "");
      writeFileSync(join(top, "api", name), "");
    }
    writeFileSync(join(top, "core", "models.py"), "class User:\n    pass\n");
    writeFileSync(join(top, "api", "views.py"), "from core.models import User\n");
    writeFileSync(join(top, "api", "docs", "guide.md"), "# Api guide\n\nHow the api works.\n");
  });
  afterEach(() => {
    base.close();
    rmSync(top, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("answers a git project's areas, links, and busiest files, and each area's neighbours and documents", async () => {
    execFileSync("git", ["init", "-q", top]);
    commit(top, "start");
    writeFileSync(join(top, "api", "views.py"), "from core.models import User\nprint(User)\n");
    commit(top, "change views");
    const repo = (await base.repoFor(top))!;
    const { facts, busy } = await service.facts(repo);
    expect(facts.areas.map((area) => area.path).sort()).toEqual(["api", "core"]);
    expect(busy).toMatchObject({ available: true, problem: null });
    expect(busy.files[0]).toMatchObject({ path: "api/views.py", changes: 2 });
    const api = await service.area(repo, "api");
    expect(api.dependsOn).toEqual([{ from: "api", to: "core", count: 1 }]);
    // Any file in the area's folders counts, docs included; views.py changed twice, so it leads.
    expect(api.busy[0]).toMatchObject({ path: "api/views.py", changes: 2, area: "api" });
    expect(api.busy.map((file) => file.path)).toContain("api/docs/guide.md");
    expect(api.busy.every((file) => file.area === "api")).toBe(true);
    expect(api.documents).toEqual([expect.objectContaining({ path: "api/docs/guide.md", title: "Api guide" })]);
    expect((await service.area(repo, "core")).usedBy).toEqual([{ from: "api", to: "core", count: 1 }]);
    await expect(service.area(repo, "billing")).rejects.toThrow('Unknown area "billing"');
  });

  it("says change history needs git for a folder outside git", async () => {
    const repo = (await base.repoFor(top))!;
    expect(repo.git).toBe(false);
    const { facts, busy } = await service.facts(repo);
    expect(facts.links).toEqual([{ from: "api", to: "core", count: 1 }]);
    expect(busy).toMatchObject({ available: false, problem: null, files: [] });
  });
});
