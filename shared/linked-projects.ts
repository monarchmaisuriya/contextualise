import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
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
  // The attached workspace, when a workspace's folder was attached rather than a project's.
  workspaceId: z.string().optional(),
});
export type LinkedProject = z.infer<typeof linkedProjectSchema>;

export const workspaceLinksSchema = z.object({
  links: z.array(linkedProjectSchema),
  // The workspace's folder is shared with other workspaces, so chats started from Paseo's own "+"
  // cannot be told apart and get no links; "New linked chat" still does.
  sharedFolder: z.boolean(),
  // Every Paseo project with a workspace, by its own folder, to pick from when adding.
  suggestions: z.array(z.object({ name: z.string(), path: z.string() })),
  // Every other Paseo workspace, by what picking it attaches: a worktree's own folder (the link lapses
  // with the workspace), a repository a local workspace's chats changed, or a local workspace's folder
  // while nothing it changed is recorded. A local workspace that changed several repositories has a row
  // for each.
  workspaces: z.array(z.object({ workspaceId: z.string(), name: z.string(), project: z.string(), path: z.string(), branch: z.string().nullable(), attaches: z.enum(["worktree", "repository", "folder"]) })),
});
export type WorkspaceLinksPayload = z.infer<typeof workspaceLinksSchema>;

export const workspaceLinksRpc = defineRpc({ name: "links.list", input: workspaceInput, output: workspaceLinksSchema });
// How many projects a workspace has attached, for the Attached button's label: it is read on agent
// updates, so it reads only the links, not the popover's suggestions.
export const workspaceLinkCountRpc = defineRpc({ name: "links.count", input: workspaceInput, output: z.object({ count: z.number().int() }) });
// `attachedWorkspaceId` attaches that workspace's own folder (path must be it), so the link lapses with it.
export const addLinkRpc = defineRpc({ name: "links.add", input: workspaceInput.extend({ path: z.string().min(1).max(1_000), attachedWorkspaceId: z.string().min(1).max(200).optional() }), output: workspaceLinksSchema });
export const removeLinkRpc = defineRpc({ name: "links.remove", input: workspaceInput.extend({ path: z.string().min(1).max(1_000) }), output: workspaceLinksSchema });

// A new chat in the workspace with its links, using the provider, model, and mode of `fromAgentId`.
// With `carryConversation`, its first message holds that chat's recent conversation, so a chat that
// started before a link was added can carry on with it.
export const newLinkedChatRpc = defineRpc({
  name: "links.new-chat",
  input: workspaceInput.extend({ fromAgentId: z.string().min(1).max(200), carryConversation: z.boolean() }),
  output: z.object({ agentId: z.string() }),
});

// Attach > Project file: files and folders of every workspace's attached projects (the search is not
// told which workspace it is for). A row attaches the path, not the content.
export const searchAttachedFilesRpc = defineRpc({ name: "links.files-search", input: z.object({ query: z.string() }), output: PluginAttachmentSearchPayloadSchema });

// Whether any workspace has an attached folder Attach > Project file would search; the app lists that
// source only then.
export const attachedFilesAvailableRpc = defineRpc({ name: "links.files-available", input: z.object({}), output: z.object({ available: z.boolean() }) });

export const attachedFileAttachmentSource = defineAttachmentSource({
  id: "attached-file",
  title: "Project file",
  // An export of the installed Paseo 0.15.0 app's lucide table (app-dist web bundle).
  icon: "FileSearch",
  pickerTitle: "Attach a file or folder from an attached project",
  searchPlaceholder: "Search files and folders in attached projects",
  search: searchAttachedFilesRpc,
});

// The Attached button's Project files tab: files and folders of this workspace's attached projects,
// best first. `path` is absolute; the title is the path in the project.
export const workspaceFilesRpc = defineRpc({
  name: "links.workspace-files",
  input: workspaceInput.extend({ query: z.string().max(500) }),
  output: z.object({ files: z.array(z.object({ path: z.string(), kind: z.enum(["file", "folder"]), title: z.string(), project: z.string() })) }),
});

// A path written the way Paseo's `@` writes one into a message (app/src/utils/file-mention-autocomplete.ts).
export function mentionPath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}
