import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotSettingsSchema } from "../../shared/contracts";
import { overviewFor, withoutMarkers } from "./overview";
import { buildSection, SECTION_END, SECTION_START, unavailableSection } from "./section";
import { KnowledgeStore } from "./store";

describe("overviewFor", () => {
  let dir: string;
  let store: KnowledgeStore;
  const settings = snapshotSettingsSchema.parse({});
  const open = vi.fn(async () => ({ store, updating: false }));
  const inputs = (overrides: Partial<Parameters<typeof overviewFor>[0]> = {}) =>
    overviewFor({ repoKey: "github.com/acme/api", settings, prefs: { enabled: true, pins: [] }, problem: async () => null, open, memoriseAvailable: async () => false, ...overrides });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "contextualise-overview-"));
    store = new KnowledgeStore(join(dir, "index.sqlite"));
    store.replaceSource({ path: "ARCHITECTURE.md", kind: "architecture", blob: "a", chunks: [{ title: "Overview", body: "x", line: 1 }] });
    open.mockClear();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives the section buildSection makes from the same settings and pins, counting its lines without the markers", async () => {
    const overview = await inputs({ prefs: { enabled: true, pins: ["architecture:ARCHITECTURE.md:1"] } });
    const expected = buildSection({ repoKey: "github.com/acme/api", store, maxLines: settings.knowledgeMapLines, memoriseAvailable: false, updating: false, parts: settings.knowledgeMapParts, recentTasks: settings.knowledgeRecentTasks, pins: ["architecture:ARCHITECTURE.md:1"] });
    expect(overview).toEqual({ state: "given", text: expected, lines: (expected as string).split("\n").length - 2 });
  });

  it("is off, without opening the index, when knowledge or the project is switched off", async () => {
    expect(await inputs({ settings: { ...settings, knowledgeEnabled: false } })).toEqual({ state: "off", text: null, lines: 0 });
    expect(await inputs({ prefs: { enabled: false, pins: [] } })).toEqual({ state: "off", text: null, lines: 0 });
    expect(open).not.toHaveBeenCalled();
  });

  it("is unavailable with the one-line notice when the tool server could not start", async () => {
    expect(await inputs({ problem: async () => "port taken" })).toEqual({ state: "unavailable", text: unavailableSection("port taken"), lines: 1 });
    expect(open).not.toHaveBeenCalled();
  });

  it("is given with no text when the overview is set to 0 lines", async () => {
    expect(await inputs({ settings: { ...settings, knowledgeMapLines: 0 } })).toEqual({ state: "given", text: null, lines: 0 });
  });

  it("removes only the marker lines", () => {
    expect(withoutMarkers([SECTION_START, "a", "b", SECTION_END].join("\n"))).toBe("a\nb");
  });
});
