import { describe, expect, it } from "vitest";
import { areaLabel, neighbourDiagram, overviewDiagram } from "./diagram";
import type { Area } from "./knowledge";

const area = (path: string, files: number): Area => ({ path, files, tests: 0, symbols: 0, languages: {}, keyNames: [], mainFiles: [], merged: [] });

describe("diagrams", () => {
  it("draws the biggest areas and only links between drawn areas, strongest thickest", () => {
    const facts = {
      areas: [area("core", 300), area("apps/orders", 120), area("apps/billing", 80), area("scripts", 2)],
      links: [
        { from: "apps/orders", to: "core", count: 42 },
        { from: "apps/billing", to: "core", count: 5 },
        { from: "scripts", to: "core", count: 1 },
      ],
    };
    const diagram = overviewDiagram(facts, 3, 25) ?? "";
    expect(diagram.split("\n")).toEqual([
      "flowchart TB",
      '  a0["core<br/>300 files"]',
      '  a1["apps/orders<br/>120 files"]',
      '  a2["apps/billing<br/>80 files"]',
      "  a1 ==> a0",
      "  a2 --> a0",
    ]);
  });

  it("leaves out areas no drawn link touches", () => {
    const diagram = overviewDiagram({ areas: [area("big", 900), area("a", 2), area("b", 2)], links: [{ from: "a", to: "b", count: 1 }] }) ?? "";
    expect(diagram).not.toContain("big");
    expect(diagram.split("\n")).toEqual(["flowchart TB", '  a0["a<br/>2 files"]', '  a1["b<br/>2 files"]', "  a0 ==> a1"]);
  });

  it("draws nothing without links", () => {
    expect(overviewDiagram({ areas: [area("a", 1), area("b", 1)], links: [] })).toBeNull();
    expect(neighbourDiagram({ areas: [area("a", 1)], links: [] }, "a")).toBeNull();
  });

  it("drops characters Mermaid would read as syntax from folder names", () => {
    const diagram = overviewDiagram({ areas: [area('we"ird]; click a0 call x()', 2), area("b", 1)], links: [{ from: "b", to: 'we"ird]; click a0 call x()', count: 1 }] }) ?? "";
    expect(diagram).toContain('a0["we ird click a0 call x<br/>2 files"]');
    expect(diagram.split("\n")).toHaveLength(4);
  });

  it("puts an area between the areas that use it and the areas it uses", () => {
    const facts = { areas: [area("api", 10), area("core", 20), area("web", 5)], links: [{ from: "web", to: "api", count: 3 }, { from: "api", to: "core", count: 7 }] };
    expect(neighbourDiagram(facts, "api")?.split("\n")).toEqual([
      "flowchart LR",
      '  focus["api<br/>10 files"]',
      "  style focus stroke-width:3px",
      '  n0["web<br/>5 files"]',
      "  n0 -->|3| focus",
      '  n1["core<br/>20 files"]',
      "  focus -->|7| n1",
    ]);
  });

  it("draws an area that both uses and is used by this one once, with arrows both ways", () => {
    const facts = { areas: [area("orders", 5), area("pricing", 5)], links: [{ from: "pricing", to: "orders", count: 1 }, { from: "orders", to: "pricing", count: 2 }] };
    const diagram = neighbourDiagram(facts, "orders") ?? "";
    expect(diagram.match(/pricing/g)).toHaveLength(1);
    expect(diagram).toContain("n0 -->|1| focus");
    expect(diagram).toContain("focus -->|2| n0");
  });

  it("names the top level and the folded small areas", () => {
    expect([areaLabel(""), areaLabel("(other)"), areaLabel("core")]).toEqual(["Top level", "Other", "core"]);
  });
});
