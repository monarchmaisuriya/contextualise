import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SnapshotSettingsScreen } from "./client/settings-screen";
import { tagsChanged } from "./client/tag-events";
import { TagsScreen } from "./client/tags-screen";
import { addTagRpc, parseTagName, removeTagRpc, tagAttachmentSource } from "./shared/contracts";

// Shown, hidden, and moved under Paseo's Settings > Sidebar.
function TagsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Tags" active={currentScreen?.screenId === "tags"} onPress={() => openScreen({ screenId: "tags" })} />;
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: "tags", title: "Tags", Component: TagsScreen }),
    client.addSidebarFooterItem({ id: "tags", title: "Tags", Component: TagsSidebarItem }),
    client.addSettingsScreen({ id: "snapshot", title: "Contextualise", icon: "Tags", Component: SnapshotSettingsScreen }),
    client.addAttachmentSource(tagAttachmentSource),
    // Paseo shows a thrown error as a toast and clears the composer either way.
    client.addSlashCommand({
      name: "tag",
      description: "Tag this agent so it shows under the tag and in Attach > Tag",
      argumentHint: "<tag name>",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        const tag = parseTagName(args);
        const { added } = await rpc(addTagRpc, { tag, agentId: agent.id, workspaceId: agent.workspaceId });
        if (!added) throw new Error(`This agent is already tagged "${tag}"`);
        tagsChanged();
      },
    }),
    client.addSlashCommand({
      name: "untag",
      description: "Remove this agent from a tag",
      argumentHint: "<tag name>",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        const tag = parseTagName(args);
        const { removed } = await rpc(removeTagRpc, { tag, agentId: agent.id });
        if (!removed) throw new Error(`This agent is not tagged "${tag}"`);
        tagsChanged();
      },
    }),
    client.addCommandCenterItem({
      id: "tag-agent",
      title: "Tag this agent...",
      icon: "Tags",
      keywords: ["tag", "label", "contextualise"],
      context: "agent",
      onSelect({ agent, openScreen }) {
        openScreen({ screenId: "tags", params: { agentId: agent.id, workspaceId: agent.workspaceId, agentTitle: agent.title ?? agent.id } });
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
