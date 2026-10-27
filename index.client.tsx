import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { readable } from "./client/errors";
import { ReceiptRow } from "./client/receipt";
import { SnapshotSettingsScreen } from "./client/settings-screen";
import { tagsChanged } from "./client/tag-events";
import { TagsScreen } from "./client/tags-screen";
import {
  addLinkRpc,
  addTagRpc,
  agentAttachmentSource,
  parseLinkCommand,
  parseTagNames,
  RECEIPT_KIND,
  receiptSchema,
  removeTagRpc,
  tagAttachmentSource,
  terminalAttachmentSource,
} from "./shared/contracts";

// Shown, hidden, and moved under Paseo's Settings > Sidebar.
function TagsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Tags" active={currentScreen?.screenId === "tags"} onPress={() => openScreen({ screenId: "tags" })} />;
}

export default function contribute(client: PluginClientContext) {
  const openTagsFor = (agentId: string, workspaceId?: string) => client.openScreen({ screenId: "tags", params: workspaceId ? { agentId, workspaceId } : { agentId } });
  const removers = [
    client.addScreen({ id: "tags", title: (params) => (params.agentId ? "Tags for this agent" : "Tags"), Component: TagsScreen }),
    client.addSidebarFooterItem({ id: "tags", title: "Tags", Component: TagsSidebarItem }),
    client.addSettingsScreen({ id: "snapshot", title: "Contextualise", icon: "Tags", Component: SnapshotSettingsScreen }),
    client.addAttachmentSource(tagAttachmentSource),
    client.addAttachmentSource(agentAttachmentSource),
    client.addAttachmentSource(terminalAttachmentSource),
    client.addTimelineRenderer({ kind: RECEIPT_KIND, version: 1, schema: receiptSchema, Component: (props) => <ReceiptRow {...props} openTags={openTagsFor} /> }),
    // Paseo shows a thrown error as a toast and clears the composer either way. Success shows as a
    // confirmation row in the agent's timeline, added by the server.
    client.addSlashCommand({
      name: "tag",
      description: "Tag this agent (several: /tag auth, billing)",
      argumentHint: "<tag>[, <tag>...]",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        await readable(() => rpc(addTagRpc, { tags: parseTagNames(args), agentId: agent.id, workspaceId: agent.workspaceId }));
        tagsChanged();
      },
    }),
    client.addSlashCommand({
      name: "untag",
      description: "Remove this agent from a tag (several: /untag auth, billing)",
      argumentHint: "<tag>[, <tag>...]",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        await readable(() => rpc(removeTagRpc, { tags: parseTagNames(args), agentId: agent.id }));
        tagsChanged();
      },
    }),
    client.addSlashCommand({
      name: "tag-link",
      description: "Add a web link to a tag; it is listed when the tag is attached",
      argumentHint: "<https://...> <tag>",
      context: "agent",
      async onSubmit({ args, rpc }) {
        const { url, tag } = parseLinkCommand(args);
        const outcome = await readable(() => rpc(addLinkRpc, { tag, url }));
        if (!outcome.changed) throw new Error(`"${outcome.name}" already has this link`);
        tagsChanged();
      },
    }),
    client.addSlashCommand({
      name: "tags",
      description: "Show and edit this agent's tags",
      argumentHint: "",
      context: "agent",
      onSubmit({ agent }) {
        openTagsFor(agent.id, agent.workspaceId);
      },
    }),
    client.addCommandCenterItem({
      id: "tag-agent",
      title: "Tag this agent...",
      icon: "Tags",
      keywords: ["tag", "label", "contextualise"],
      context: "agent",
      onSelect({ agent }) {
        openTagsFor(agent.id, agent.workspaceId);
      },
    }),
    client.addCommandCenterItem({
      id: "open-tags",
      title: "Open tags",
      icon: "Tags",
      keywords: ["tag", "label", "contextualise"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "tags" });
      },
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
