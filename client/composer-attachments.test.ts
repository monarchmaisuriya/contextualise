import { expect, test } from "vitest";
import { attachChat, supportsComposerAttachments, type AttachmentComposer } from "./composer-attachments";

const item = { id: "source-chat", identifier: "Claude", title: "Source", text: "Exact snapshot and grant", url: "https://example.com/chat", resourceType: "agent" };

test("adds the original snapshot to the exact agent, not the focused composer, and prevents duplicates", () => {
  const a: AttachmentComposer["attachments"][number][] = [];
  const b: AttachmentComposer["attachments"][number][] = [];
  const client = { composers: ({ agentId }: { agentId: string }) => [{ context: "agent" as const, attachments: agentId === "a" ? a : b, addAttachment: (value: AttachmentComposer["attachments"][number]) => (agentId === "a" ? a : b).push(value) }] };
  expect(attachChat(client, "a", item)).toBe("added");
  expect(a).toEqual([{ sourceId: "agent", item }]);
  expect(a[0].item).toBe(item);
  expect(b).toEqual([]);
  expect(attachChat(client, "a", item)).toBe("already-attached");
  expect(a).toHaveLength(1);
});

test("never falls back to another composer and identifies unsupported clients", () => {
  expect(supportsComposerAttachments({})).toBe(false);
  expect(supportsComposerAttachments({ composers: () => [] })).toBe(true);
  expect(() => attachChat({ composers: () => [] }, "missing", item)).toThrow("unavailable");
});
