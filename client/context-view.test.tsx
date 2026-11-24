import { beforeEach, expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({ queries: [] as string[][], mutate: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (value: unknown) => [value, vi.fn()], useEffect: vi.fn() }));
vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => vi.fn() }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (input: { queryKey: string[] }) => { boundary.queries.push(input.queryKey); return {}; },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: boundary.mutate }),
}));
import { ContextView, DiagnosticsView } from "./context-view";

beforeEach(() => { boundary.queries = []; boundary.mutate.mockClear(); });

test("preparing context does not mount diagnostics or recording", () => {
  ContextView({ repoKey: "acme/api", styles: { colors: {} } as never });
  expect(boundary.queries.map((key) => key[1])).toEqual(["prepare", "context-select"]);
  expect(boundary.mutate).not.toHaveBeenCalled();
});

test("opening diagnostics neither prepares context nor starts recording", () => {
  DiagnosticsView({ repoKey: "acme/api", styles: { colors: {} } as never });
  expect(boundary.queries).toEqual([["contextualise", "activity", "acme/api"]]);
  expect(boundary.mutate).not.toHaveBeenCalled();
});
