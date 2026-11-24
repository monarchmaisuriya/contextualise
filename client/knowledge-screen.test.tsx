import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  queries: [] as { queryKey: string[]; enabled?: boolean }[],
  projects: [] as Record<string, unknown>[],
}));

// The host hooks are external boundaries. Inspect real screen elements and invoke their handlers
// without a DOM renderer, which this plugin does not depend on.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = host.cursor++;
    if (!(slot in host.state)) host.state[slot] = initial;
    return [host.state[slot], (next: unknown) => { host.state[slot] = typeof next === "function" ? next(host.state[slot]) : next; }];
  },
  useEffect: (effect: () => void) => { host.effects.push(effect); },
}));
vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => vi.fn(async () => ({})),
  useSettings: () => ({ status: "ready", values: { knowledgeGenerate: true } }),
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ ScrollView: "ScrollView", Icon: "Icon", useToast: () => ({ error: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: string[]; enabled?: boolean }) => {
    host.queries.push(options);
    if (options.queryKey.includes("projects")) return { data: { projects: host.projects } };
    if (options.queryKey.includes("tasks")) return { data: { tasks: [], total: 0 } };
    return {};
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { KnowledgeView } from "./knowledge-screen";

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
const styles = { colors: {}, content: {}, compact: false } as never;
const project = { repoKey: "acme/api", name: "api", enabled: true, counts: { architecture: 0, convention: 0, adr: 0, doc: 1, code: 2, task: 1 }, pins: [] };
function render(wide = false) {
  host.cursor = 0;
  host.effects = [];
  return elements(KnowledgeView({ hostId: "test-host", styles, navigation: undefined, wide }));
}
function overview() {
  const entry = render().find((node) => typeof node.type === "function" && node.type.name === "Overview")!;
  host.state = [];
  host.cursor = 0;
  return () => {
    host.cursor = 0;
    return elements((entry.type as (props: unknown) => unknown)(entry.props));
  };
}

beforeEach(() => {
  host.state = [];
  host.cursor = 0;
  host.queries = [];
  host.projects = [project];
  // Choose the project using the same synchronization effect as the host screen.
  render();
  host.effects.forEach((effect) => effect());
});

test("overview keeps About and Start here visible but collapses activity and agent context", () => {
  const nodes = overview()();
  expect(nodes.some((node) => node.props.label === "About")).toBe(true);
  expect(nodes.some((node) => typeof node.type === "function" && node.type.name === "StartHere")).toBe(true);
  expect(nodes.some((node) => node.props.label === "Recent work")).toBe(false);
  expect(nodes.some((node) => node.props.label === "What agents get")).toBe(false);
});

test("activity disclosure opens and closes with an expanded accessibility state", () => {
  const draw = overview();
  const closed = draw().find((node) => node.props.accessibilityLabel === "Show activity")!;
  expect(closed.props.accessibilityRole).toBe("button");
  expect(closed.props.accessibilityState).toEqual({ expanded: false });
  closed.props.onPress();
  expect(draw().some((node) => node.props.label === "Recent work")).toBe(true);
  const open = draw().find((node) => node.props.accessibilityLabel === "Hide activity")!;
  expect(open.props.accessibilityState).toEqual({ expanded: true });
  open.props.onPress();
  expect(draw().some((node) => node.props.label === "Recent work")).toBe(false);
});

test("agent context disclosure exposes diagnostics only when requested", () => {
  const draw = overview();
  draw().find((node) => node.props.accessibilityLabel === "Show agent context")!.props.onPress();
  expect(draw().some((node) => node.props.label === "What agents get")).toBe(true);
  draw().find((node) => node.props.accessibilityLabel === "Hide agent context")!.props.onPress();
  expect(draw().some((node) => node.props.label === "What agents get")).toBe(false);
});

test("compact navigation clears search before showing another view", () => {
  render().find((node) => node.props.label === "Search project knowledge")!.props.onChange("auth");
  render().find((node) => node.props.label === "Project knowledge views")!.props.onChange("documents");
  expect(render().find((node) => node.props.label === "Search project knowledge")!.props.value).toBe("");
});

test("project synchronization clears search", () => {
  render().find((node) => node.props.label === "Search project knowledge")!.props.onChange("auth");
  render();
  host.effects.forEach((effect) => effect());
  expect(render().find((node) => node.props.label === "Search project knowledge")!.props.value).toBe("");
});

test("desktop uses one project chooser instead of nesting view links under every project", () => {
  host.projects = [project, { ...project, repoKey: "acme/web", name: "web" }];
  const nodes = render(true);
  expect(nodes.filter((node) => node.props.title === "Choose project").length).toBe(2);
  expect(nodes.some((node) => node.props.title === "web")).toBe(false);
  expect(nodes.some((node) => node.props.title === "Overview")).toBe(true);
});

test("overview identity resets local disclosures when switching projects", () => {
  const entry = render().find((node) => typeof node.type === "function" && node.type.name === "Overview")!;
  expect(entry.key).toBe("acme/api");
});

test("closed overview defers recent work and diagnostic queries", () => {
  overview()();
  expect(host.queries.findLast((query) => query.queryKey.includes("tasks"))?.enabled).toBe(false);
  expect(host.queries.findLast((query) => query.queryKey.includes("usage"))?.enabled).toBe(false);
  expect(host.queries.findLast((query) => query.queryKey.includes("overview"))?.enabled).toBe(false);
});

test("project actions preserve indexing and generation restrictions", () => {
  host.projects = [{ ...project, indexing: true, generation: { state: "running", message: "Adding conversations" } }];
  const menu = render().find((node) => node.props.title === "api" && node.props.actions)!;
  expect(menu.props.actions).toMatchObject([
    { label: "Turn off knowledge for new agents" },
    { label: "Reading the project…", disabled: true },
    { label: "Add past conversations", disabled: true },
    { label: "Summarise past conversations", disabled: true },
  ]);
});

test("disabled projects offer turning knowledge back on", () => {
  host.projects = [{ ...project, enabled: false }];
  const menu = render().find((node) => node.props.title === "api" && node.props.actions)!;
  expect(menu.props.actions[0].label).toBe("Turn on knowledge for new agents");
});
