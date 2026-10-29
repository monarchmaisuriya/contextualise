import { describe, expect, it } from "vitest";
import { areaOf, buildFacts, type FactsFile, MIN_AREA_FILES, OTHER, TOP_LEVEL } from "./facts";

const file = (path: string, imports: FactsFile["imports"] = [], symbols: string[] = []): FactsFile => ({ path, imports, symbols: symbols.map((name, index) => ({ name, kind: /^[A-Z]/.test(name) ? "class" : "function", line: index + 1 })) });
// Small fixtures keep every area; the folding test uses the real minimum.
const facts = (files: FactsFile[], others: string[] = [], manifests: Record<string, string> = {}, minAreaFiles = 1) =>
  buildFacts({ files, allPaths: new Set([...files.map((entry) => entry.path), ...others]), manifests: new Map(Object.entries(manifests)), minAreaFiles });
const areaPaths = (result: ReturnType<typeof facts>) => result.areas.map((area) => area.path).sort();

describe("buildFacts", () => {
  it("splits a Django-style apps folder into apps and links them through imports", () => {
    const result = facts(
      [
        file("manage.py"),
        file("apps/__init__.py"),
        file("apps/orders/__init__.py"),
        file("apps/orders/views.py", [{ spec: "core.models", names: ["User"] }, { spec: "apps.billing.client", names: ["charge"] }, { spec: "django.db", names: ["models"] }]),
        file("apps/orders/models.py", [], ["Order"]),
        file("apps/billing/__init__.py"),
        file("apps/billing/client.py", [], ["charge"]),
        file("apps/billing/tests/test_client.py", [{ spec: "apps.billing.client", names: ["charge"] }]),
        file("apps/notes/__init__.py"),
        file("apps/notes/models.py", [{ spec: "core.models", names: ["User"] }], ["Note"]),
        file("core/__init__.py"),
        file("core/models.py", [], ["User"]),
        file("core/migrations/0001_initial.py"),
      ],
      [],
      { "requirements.txt": "Django==5.0\ncelery>=5\n-r base.txt\n" },
    );
    expect(areaPaths(result)).toEqual([TOP_LEVEL, "apps", "apps/billing", "apps/notes", "apps/orders", "core"].sort());
    expect(result.links).toContainEqual({ from: "apps/orders", to: "core", count: 1 });
    expect(result.links).toContainEqual({ from: "apps/orders", to: "apps/billing", count: 1 });
    const core = result.areas.find((area) => area.path === "core");
    expect(core?.keyNames[0]).toEqual({ name: "User", kind: "class", path: "core/models.py", line: 1, uses: 2 });
    expect(core?.mainFiles[0]).toEqual({ path: "core/models.py", usedBy: 2 });
    // Tests count toward their area, not as one; migrations are the area's code.
    expect(result.areas.find((area) => area.path === "apps/billing")).toMatchObject({ files: 2, tests: 1 });
    expect(result.areas.find((area) => area.path === "core")).toMatchObject({ files: 3, tests: 0 });
    expect(result.libraries).toEqual([{ name: "Django", files: 1 }]);
    expect(result.testFiles).toBe(1);
  });

  it("links TypeScript packages through relative imports, and counts declared libraries", () => {
    const result = facts(
      [
        file("packages/x/src/index.ts", [{ spec: "../../y/src/store.js", names: ["Store"] }, { spec: "react", names: [] }, { spec: "@tanstack/react-query", names: ["useQuery"] }, { spec: "node:fs", names: [] }]),
        file("packages/y/src/store.ts", [], ["Store"]),
        file("packages/z/src/index.tsx", [{ spec: "../../y/src", names: [] }]),
        file("packages/y/src/index.ts"),
      ],
      [],
      { "package.json": JSON.stringify({ dependencies: { react: "19", "@tanstack/react-query": "5" } }) },
    );
    expect(areaPaths(result)).toEqual(["packages/x", "packages/y", "packages/z"]);
    expect(result.links).toEqual(expect.arrayContaining([{ from: "packages/x", to: "packages/y", count: 1 }, { from: "packages/z", to: "packages/y", count: 1 }]));
    expect(result.areas.find((area) => area.path === "packages/y")?.keyNames.map((key) => key.name)).toEqual(["Store"]);
    expect(result.libraries).toEqual([{ name: "@tanstack/react-query", files: 1 }, { name: "react", files: 1 }]);
  });

  it("links Go packages under the module path", () => {
    const result = facts(
      [file("cmd/api/main.go", [{ spec: "example.com/m/internal/db", names: [] }, { spec: "fmt", names: [] }, { spec: "github.com/lib/pq", names: [] }]), file("internal/db/db.go"), file("internal/http/server.go"), file("internal/auth/auth.go")],
      [],
      { "go.mod": "module example.com/m\n\ngo 1.22\n\nrequire (\n\tgithub.com/lib/pq v1.10.9\n)\n" },
    );
    expect(areaPaths(result)).toEqual(["cmd", "internal/auth", "internal/db", "internal/http"]);
    expect(result.links).toEqual([{ from: "cmd", to: "internal/db", count: 1 }]);
    expect(result.libraries).toEqual([{ name: "github.com/lib/pq", files: 1 }]);
  });

  it("splits a single src folder, keeps root files as the top level, and folds tiny areas into Other", () => {
    const big = Array.from({ length: 300 }, (_, index) => file(`src/area${index % 3}/f${index}.py`));
    const result = facts([...big, file("setup.py"), file("scripts/one.py"), file("scripts/two.py"), file("tools/three.py"), file("tools/a/four.py"), file("tools/b/five.py"), file("tests/test_all.py")], [], {}, MIN_AREA_FILES);
    expect(areaPaths(result)).toEqual([TOP_LEVEL, OTHER, "src/area0", "src/area1", "src/area2", "tools"].sort());
    // scripts has 2 files and is folded; tools has 3 (in its subfolders) and stays.
    expect(areaPaths(result)).toContain("tools");
    expect(result.areas.find((area) => area.path === OTHER)?.merged).toEqual(["scripts"]);
    expect(result.areas.find((area) => area.path === TOP_LEVEL)).toMatchObject({ files: 1, tests: 1 });
    expect(areaOf("scripts/one.py", result)).toBe(OTHER);
    expect(areaOf("src/area1/deep/x.py", result)).toBe("src/area1");
    expect(areaOf("docs/guide.md", result)).toBeNull();
    expect(areaOf("README.md", result)).toBe(TOP_LEVEL);
  });

  it("resolves relative Python imports and submodules named in from-imports", () => {
    const result = facts([
      file("pkg/__init__.py"),
      file("pkg/a/__init__.py"),
      file("pkg/a/views.py", [{ spec: "..b", names: ["helper"] }, { spec: "pkg", names: ["c"] }]),
      file("pkg/b/__init__.py", [], ["helper"]),
      file("pkg/c/__init__.py"),
      file("other/x.py"),
    ]);
    // pkg holds most of the code but has only 3 subfolders with code, so it is split.
    expect(areaPaths(result)).toEqual(["other", "pkg", "pkg/a", "pkg/b", "pkg/c"]);
    expect(result.links).toEqual(expect.arrayContaining([{ from: "pkg/a", to: "pkg/b", count: 1 }, { from: "pkg/a", to: "pkg/c", count: 1 }]));
    expect(result.areas.find((area) => area.path === "pkg/b")?.keyNames[0]).toMatchObject({ name: "helper", path: "pkg/b/__init__.py", uses: 1 });
  });

  it("gives the same fingerprint for the same structure and a new one when areas change", () => {
    const one = facts([file("a/x.py"), file("b/y.py")]);
    expect(facts([file("a/x.py"), file("b/y.py")]).fingerprint).toBe(one.fingerprint);
    expect(facts([file("a/x.py"), file("c/y.py")]).fingerprint).not.toBe(one.fingerprint);
  });
});
