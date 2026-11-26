import type { PluginAttachmentItem } from "@getpaseo/plugin";

// Paseo 0.17.4's client.composers contract; the plugin still typechecks against SDK 0.13.
export interface AttachmentComposer {
  readonly context: "agent" | "draft" | "new-workspace";
  readonly attachments: readonly { sourceId: string; item: PluginAttachmentItem }[];
  addAttachment(input: { sourceId: string; item: PluginAttachmentItem }): void;
}
export interface ComposerAttachments {
  composers(selector: { agentId: string }): readonly AttachmentComposer[];
}

export function supportsComposerAttachments(client: unknown): client is ComposerAttachments {
  return typeof (client as Partial<ComposerAttachments> | null)?.composers === "function";
}

export function attachChat(client: ComposerAttachments, agentId: string, item: PluginAttachmentItem): "added" | "already-attached" {
  const composers = client.composers({ agentId });
  if (composers.length !== 1 || composers[0].context !== "agent") throw new Error("This chat's composer is unavailable. Open the chat and try again.");
  const composer = composers[0];
  if (composer.attachments.some((attached) => attached.sourceId === "agent" && attached.item.id === item.id)) return "already-attached";
  composer.addAttachment({ sourceId: "agent", item });
  return "added";
}
