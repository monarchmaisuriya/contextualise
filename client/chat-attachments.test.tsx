import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({ data: undefined as unknown, error: null as unknown, isFetching: false, refetch: vi.fn(), show: vi.fn(), reportError: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (value: unknown) => [value, vi.fn()] }));
vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => vi.fn() }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ ScrollView: "ScrollView", useToast: () => ({ show: host.show, error: host.reportError }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: host.data, error: host.error, isFetching: host.isFetching, refetch: host.refetch }) }));
import { ChatAttachments } from "./chat-attachments";

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
const source = { id: "other", identifier: "Claude", title: "API work", subtitle: "Backend", text: "Snapshot with grant", url: "https://example.com/chat", resourceType: "agent" };
const styles = { colors: {} } as never;
beforeEach(() => {
  host.data = undefined;
  host.error = null;
  host.isFetching = false;
  vi.clearAllMocks();
});

test("selecting a chat preserves its full snapshot, excludes the receiver, and confirms draft insertion", () => {
  host.data = { items: [{ ...source, id: "receiver" }, source] };
  const attach = vi.fn(() => "added" as const);
  const nodes = elements(ChatAttachments({ workspaceId: "workspace", agentId: "receiver", styles, attach }));
  const rows = nodes.filter((node) => node.props.accessibilityLabel?.startsWith("Attach "));
  expect(rows).toHaveLength(1);
  expect(rows[0].props.title).toBe("API work");
  rows[0].props.onPress();
  expect(attach).toHaveBeenCalledWith(source);
  expect(host.show).toHaveBeenCalledWith("Chat attached to this message", { variant: "success" });
});

test("errors remove stale selectable rows and provide retry", () => {
  host.data = { items: [source] };
  host.error = new Error("Offline");
  const nodes = elements(ChatAttachments({ workspaceId: "workspace", agentId: "receiver", styles, attach: () => "added" }));
  expect(nodes.filter((node) => node.props.accessibilityLabel?.startsWith("Attach "))).toHaveLength(0);
  expect(nodes.find((node) => node.props.state === "error")?.props.text).toContain("Offline");
  nodes.find((node) => node.props.label === "Retry")!.props.onPress();
  expect(host.refetch).toHaveBeenCalledOnce();
});

test("loading and empty results are distinct and a refreshing row is disabled", () => {
  host.isFetching = true;
  expect(elements(ChatAttachments({ workspaceId: "workspace", agentId: "receiver", styles, attach: () => "added" })).some((node) => node.props.children === "Searching chats…")).toBe(true);
  host.isFetching = false;
  expect(elements(ChatAttachments({ workspaceId: "workspace", agentId: "receiver", styles, attach: () => "added" })).some((node) => node.props.children === "No chats match this search")).toBe(true);
  host.data = { items: [source] };
  host.isFetching = true;
  expect(elements(ChatAttachments({ workspaceId: "workspace", agentId: "receiver", styles, attach: () => "added" })).find((node) => node.props.title === "API work")?.props.disabled).toBe(true);
});

test("an unavailable composer reports an error rather than successful attachment", () => {
  host.data = { items: [source] };
  const nodes = elements(ChatAttachments({ workspaceId: "workspace", agentId: "receiver", styles, attach: () => { throw new Error("Composer unavailable"); } }));
  nodes.find((node) => node.props.title === "API work")!.props.onPress();
  expect(host.reportError).toHaveBeenCalledWith("Composer unavailable");
  expect(host.show).not.toHaveBeenCalled();
});
