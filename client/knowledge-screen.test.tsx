import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  queries: [] as { queryKey: string[]; enabled?: boolean }[],
  projects: [] as Record<string, unknown>[],
  knowledgeEnabled: true,
}));

// The host hooks are external boundaries. Inspect real screen elements and invoke their handlers
// without a DOM renderer, which this plugin does not depend on.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory(),
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
  useSettings: () => ({ status: "ready", values: { knowledgeGenerate: true, knowledgeEnabled: host.knowledgeEnabled } }),
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

import { KnowledgeView, WorkspaceKnowledgePanel } from "./knowledge-screen";
import { StartHere } from "./knowledge/pulse";

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
  host.knowledgeEnabled = true;
  // Choose the project using the same synchronization effect as the host screen.
  render();
  host.effects.forEach((effect) => effect());
});

test("normal navigation has exactly three tabs at every width", () => {
  expect(render().find((node) => node.props.label === "Project knowledge views")!.props.options).toEqual([
    { value: "overview", label: "Overview" }, { value: "files", label: "Files" }, { value: "history", label: "History" },
  ]);
  expect(render(true).find((node) => node.props.label === "Project knowledge views")!.props.options).toEqual([
    { value: "overview", label: "Overview" }, { value: "files", label: "Files" }, { value: "history", label: "History" },
  ]);
});

test("overview keeps About and Start here visible but has no dashboard disclosures", () => {
  const nodes = overview()();
  expect(nodes.some((node) => node.props.label === "About")).toBe(true);
  expect(nodes.some((node) => typeof node.type === "function" && node.type.name === "StartHere")).toBe(true);
  expect(nodes.some((node) => node.props.label === "Recent work")).toBe(false);
  expect(nodes.some((node) => node.props.label === "What agents get")).toBe(false);
  expect(nodes.some((node) => node.props.accessibilityLabel === "Show activity")).toBe(false);
  expect(nodes.some((node) => node.props.accessibilityLabel === "Show agent context")).toBe(false);
});

test("history opens project activity and returns to the conversation list", () => {
  render().find((node) => node.props.label === "Project knowledge views")!.props.onChange("history");
  render().find((node) => node.props.label === "Project activity")!.props.onPress();
  expect(render().some((node) => typeof node.type === "function" && node.type.name === "ProjectActivity")).toBe(true);
  render().find((node) => node.props.label === "Back to history")!.props.onPress();
  expect(render().some((node) => typeof node.type === "function" && node.type.name === "TaskList")).toBe(true);
});

test("advanced tools open from the menu and return to the prior tab", () => {
  render().find((node) => node.props.label === "Project knowledge views")!.props.onChange("files");
  const menu = render().find((node) => node.props.title === "api" && node.props.actions)!;
  menu.props.actions.find((action: { label: string }) => action.label === "Agent context").onPress();
  expect(render().some((node) => typeof node.type === "function" && node.type.name === "AgentContext")).toBe(true);
  expect(render().some((node) => node.props.label === "Project knowledge views")).toBe(false);
  render().find((node) => node.props.label === "Back to files")!.props.onPress();
  expect(render().find((node) => node.props.label === "Project knowledge views")!.props.value).toBe("files");
});

test("compact navigation clears search before showing another view", () => {
  render().find((node) => node.props.label === "Search project knowledge")!.props.onChange("auth");
  render().find((node) => node.props.label === "Project knowledge views")!.props.onChange("files");
  expect(render().find((node) => node.props.label === "Search project knowledge")!.props.value).toBe("");
});

test("project synchronization clears search", () => {
  render().find((node) => node.props.label === "Search project knowledge")!.props.onChange("auth");
  render();
  host.effects.forEach((effect) => effect());
  expect(render().find((node) => node.props.label === "Search project knowledge")!.props.value).toBe("");
});

test("desktop project title is the chooser without a separate sidebar", () => {
  host.projects = [project, { ...project, repoKey: "acme/web", name: "web" }];
  const nodes = render(true);
  expect(nodes.filter((node) => node.props.title === "Choose project").length).toBe(1);
  expect(nodes.some((node) => node.props.title === "web")).toBe(false);
  expect(nodes.some((node) => node.props.accessibilityLabel === "Project api; choose another of 2")).toBe(true);
  expect(nodes.some((node) => node.type === "ScrollView")).toBe(false);
});

test("overview identity resets local disclosures when switching projects", () => {
  const entry = render().find((node) => typeof node.type === "function" && node.type.name === "Overview")!;
  expect(entry.key).toBe("acme/api");
});

test("overview does not mount task or diagnostic queries", () => {
  overview()();
  expect(host.queries.some((query) => query.queryKey.includes("tasks"))).toBe(false);
  expect(host.queries.some((query) => query.queryKey.includes("usage"))).toBe(false);
  expect(host.queries.some((query) => query.queryKey.includes("overview"))).toBe(false);
});

test("project actions preserve indexing and generation restrictions", () => {
  host.projects = [{ ...project, indexing: true, generation: { state: "running", message: "Adding conversations" } }];
  const menu = render().find((node) => node.props.title === "api" && node.props.actions)!;
  expect(menu.props.actions.slice(-4)).toMatchObject([
    { label: "Turn off knowledge for new agents" },
    { label: "Reading the project…", disabled: true },
    { label: "Add past conversations", disabled: true },
    { label: "Summarise past conversations", disabled: true },
  ]);
});

test("disabled projects offer turning knowledge back on", () => {
  host.projects = [{ ...project, enabled: false }];
  const menu = render().find((node) => node.props.title === "api" && node.props.actions)!;
  expect(menu.props.actions.find((action: { label: string }) => action.label === "Turn on knowledge for new agents")).toBeDefined();
});

test("files retain document and code filters plus area map navigation", () => {
  render().find((node) => node.props.label === "Project knowledge views")!.props.onChange("files");
  expect(render().find((node) => node.props.label === "File type")!.props.value).toBe("documents");
  render().find((node) => node.props.label === "File type")!.props.onChange("code");
  expect(render().some((node) => node.props.kind === "code")).toBe(true);
  render().find((node) => node.props.label === "Area map")!.props.onPress();
  expect(render().some((node) => typeof node.type === "function" && node.type.name === "AreasView")).toBe(true);
  render().find((node) => node.props.label === "Back to files")!.props.onPress();
  expect(render().find((node) => node.props.label === "File type")!.props.value).toBe("documents");
});

test("empty files and history do not remove primary navigation", () => {
  host.projects = [{ ...project, counts: { architecture: 0, convention: 0, adr: 0, doc: 0, code: 0, task: 0 } }];
  render().find((node) => node.props.label === "Project knowledge views")!.props.onChange("files");
  expect(render().find((node) => node.props.label === "Project knowledge views")!.props.options).toHaveLength(3);
  expect(render().some((node) => node.props.children === "No documents indexed yet.")).toBe(true);
});

test("overview limits starting points to three", () => {
  expect(overview()().find((node) => typeof node.type === "function" && node.type.name === "StartHere")!.props.maxItems).toBe(3);
});

test("starting point limit includes the README row", () => {
  const nodes = elements(StartHere({ data: { pulse: { data: { readme: "README.md", startHere: [{ path: "one.ts", area: null, usedBy: 3 }, { path: "two.ts", area: null, usedBy: 2 }, { path: "three.ts", area: null, usedBy: 1 }] } } } as never, maxItems: 3, onReadIntro: vi.fn(), onOpenFile: vi.fn(), styles }));
  expect(nodes.filter((node) => node.props.onPress).map((node) => node.props.title)).toEqual(["README.md", "one.ts", "two.ts"]);
});

test("workspace attachment management stays outside the disabled knowledge boundary", () => {
  host.state = [];
  host.cursor = 0;
  host.knowledgeEnabled = false;
  const props = { workspaceId: "w1", theme: { colors: {} }, navigation: undefined } as never;
  const initial = elements(WorkspaceKnowledgePanel(props));
  initial.find((node) => node.props.label === "Attached projects")!.props.onPress();
  host.cursor = 0;
  const opened = elements(WorkspaceKnowledgePanel(props));
  expect(opened.some((node) => typeof node.type === "function" && node.type.name === "LinkedProjects")).toBe(true);
  expect(opened.some((node) => typeof node.type === "function" && node.type.name === "KnowledgeOn")).toBe(false);
  expect(opened.some((node) => node.props.label === "Back to knowledge")).toBe(true);
});

test("changing projects exits advanced tools and resets navigation", () => {
  const menu = render().find((node) => node.props.title === "api" && node.props.actions)!;
  menu.props.actions.find((action: { label: string }) => action.label === "Diagnostics").onPress();
  expect(render().some((node) => typeof node.type === "function" && node.type.name === "DiagnosticsView")).toBe(true);
  host.projects = [{ ...project, repoKey: "acme/web", name: "web" }];
  render();
  host.effects.forEach((effect) => effect());
  render();
  host.effects.forEach((effect) => effect());
  expect(render().find((node) => node.props.label === "Project knowledge views")!.props.value).toBe("overview");
});

test("empty desktop knowledge has no nested scrolling page", () => {
  host.projects = [];
  const nodes = render(true);
  expect(nodes.some((node) => typeof node.type === "function" && node.type.name === "Page")).toBe(false);
  expect(nodes.some((node) => node.props.state === "empty")).toBe(true);
});

test("every advanced capability has a menu destination", () => {
  const menu = render().find((node) => node.props.title === "api" && node.props.actions)!;
  expect(menu.props.actions.slice(0, 5).map((action: { label: string }) => action.label)).toEqual([
    "Prepare context", "Diagnostics", "Agent context", "Project details", "Write or rewrite description",
  ]);
});
