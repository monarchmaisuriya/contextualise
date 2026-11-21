import { afterEach, expect, it } from "vitest";
import { KnowledgeStore } from "./store";
import { prepareContext } from "./prepare";

const stores: KnowledgeStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

it("keeps the grant first and reports missing selected entries without substituting full context", () => {
  const store = new KnowledgeStore(":memory:");
  stores.push(store);
  store.replaceSource({ path: "guide.md", kind: "doc", blob: "a", chunks: [{ title: "Guide", body: "Hello 😀", line: 1 }] });
  const result = prepareContext(store, { name: "API", repoKey: "p" }, "selected", ["doc:guide.md:1", "missing", "doc:guide.md:1"], "Attach grant (project_attach): test\n\n", null);
  expect(result.text.startsWith("Attach grant (project_attach): test\n\n")).toBe(true);
  expect(result.receipt).toMatchObject({ included: 1, omitted: 1, state: "prepared" });
  expect(result.receipt.characters).toBe(result.text.length);
  expect(result.receipt.bytes).toBe(Buffer.byteLength(result.text));
  expect(result.omissions).toEqual(["missing"]);
});

it("refuses an empty selection and gives retrieval guidance for a disabled map", () => {
  const store = new KnowledgeStore(":memory:");
  stores.push(store);
  expect(() => prepareContext(store, { name: "API", repoKey: "p" }, "selected", [], "", null)).toThrow("Choose at least one entry");
  expect(prepareContext(store, { name: "API", repoKey: "p" }, "overview", [], "", null).text).toContain("No startup map is configured");
});
