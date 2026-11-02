import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Linked projects: folders M links to one Paseo workspace. Every new Claude or Codex chat in that
// workspace can read and edit them as well as its own folder. Other workspaces are not affected.

// Set by Contextualise on chats it creates, so the agent-create hook knows their workspace exactly
// (Paseo does not give the hook a workspace id).
export const LINK_WORKSPACE_ENV = "CONTEXTUALISE_LINK_WORKSPACE";

const workspaceInput = z.object({ workspaceId: z.string().min(1).max(200) });

export const linkedProjectSchema = z.object({
  path: z.string(),
  name: z.string(),
  repoKey: z.string().nullable(),
  addedAt: z.string(),
});
export type LinkedProject = z.infer<typeof linkedProjectSchema>;

export const workspaceLinksSchema = z.object({
  links: z.array(linkedProjectSchema),
  // The workspace's folder is shared with other workspaces, so chats started from Paseo's own "+"
  // cannot be told apart and get no links; "New linked chat" still does.
  sharedFolder: z.boolean(),
  // Every Paseo project with a workspace, by its own folder, to pick from when adding.
  suggestions: z.array(z.object({ name: z.string(), path: z.string() })),
});
export type WorkspaceLinksPayload = z.infer<typeof workspaceLinksSchema>;

export const workspaceLinksRpc = defineRpc({ name: "links.list", input: workspaceInput, output: workspaceLinksSchema });
export const addLinkRpc = defineRpc({ name: "links.add", input: workspaceInput.extend({ path: z.string().min(1).max(1_000) }), output: workspaceLinksSchema });
export const removeLinkRpc = defineRpc({ name: "links.remove", input: workspaceInput.extend({ path: z.string().min(1).max(1_000) }), output: workspaceLinksSchema });

// A new chat in the workspace with its links, using the provider, model, and mode of `fromAgentId`.
// With `carryConversation`, its first message holds that chat's recent conversation, so a chat that
// started before a link was added can carry on with it.
export const newLinkedChatRpc = defineRpc({
  name: "links.new-chat",
  input: workspaceInput.extend({ fromAgentId: z.string().min(1).max(200), carryConversation: z.boolean() }),
  output: z.object({ agentId: z.string() }),
});
