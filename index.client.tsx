import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { readable } from "./client/errors";
import { FetchResultRow } from "./client/fetch-result";
import { ICONS, LOGO } from "./client/icons";
import { ReceiptRow } from "./client/receipt";
import { SnapshotSettingsScreen } from "./client/settings-screen";
import { tagsChanged } from "./client/tag-events";
import { KnowledgeScreen } from "./client/knowledge-screen";
import { followAgentPills } from "./client/tag-pills";
import { TagsScreen } from "./client/tags-screen";
import {
  addLinkRpc,
  addTagRpc,
  agentAttachmentSource,
  FETCH_RESULT_KIND,
  fetchItemRpc,
  fetchResultSchema,
  parseFetchCommand,
  parseLinkCommand,
  parseTagNames,
  pinAgentRpc,
  removeTagRpc,
  RECEIPT_KIND,
  receiptSchema,
  tagAttachmentSource,
  terminalAttachmentSource,
} from "./shared/contracts";
import { knowledgeAttachmentSource } from "./shared/knowledge";

// Shown, hidden, and moved under Paseo's Settings > Sidebar.
function TagsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon={LOGO} active={currentScreen?.screenId === "tags"} onPress={() => openScreen({ screenId: "tags" })} />;
}

function KnowledgeSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon={ICONS.knowledge} active={currentScreen?.screenId === "knowledge"} onPress={() => openScreen({ screenId: "knowledge" })} />;
}

export default function contribute(client: PluginClientContext) {
  const openTagsFor = (agentId: string, workspaceId?: string) => client.openScreen({ screenId: "tags", params: workspaceId ? { agentId, workspaceId } : { agentId } });
  const openItem = (tag: string, note: string) => client.openScreen({ screenId: "tags", params: { tag, note } });
  const removers = [
    client.addScreen({ id: "tags", title: (params) => (params.agentId ? "Tags for this agent" : "Tags"), Component: TagsScreen }),
    client.addSidebarFooterItem({ id: "tags", title: "Tags", Component: TagsSidebarItem }),
    client.addScreen({ id: "knowledge", title: "Project knowledge", Component: KnowledgeScreen }),
    client.addSidebarFooterItem({ id: "knowledge", title: "Project knowledge", Component: KnowledgeSidebarItem }),
    client.addSettingsScreen({ id: "snapshot", title: "Contextualise", icon: LOGO, Component: SnapshotSettingsScreen }),
    client.addAttachmentSource(tagAttachmentSource),
    client.addAttachmentSource(agentAttachmentSource),
    client.addAttachmentSource(terminalAttachmentSource),
    client.addAttachmentSource(knowledgeAttachmentSource),
    // Tagging no longer adds timeline rows; this still draws the rows v0.2.1 added.
    client.addTimelineRenderer({ kind: RECEIPT_KIND, version: 1, schema: receiptSchema, Component: (props) => <ReceiptRow {...props} openTags={openTagsFor} /> }),
    client.addTimelineRenderer({ kind: FETCH_RESULT_KIND, version: 1, schema: fetchResultSchema, Component: (props) => <FetchResultRow {...props} openItem={openItem} openTags={openTagsFor} /> }),
    followAgentPills(client, openTagsFor),
    // Paseo shows a thrown error as a toast and clears the composer either way. The Tags pill's
    // label is the confirmation; a /tag that changed nothing says so.
    client.addSlashCommand({
      name: "tag",
      description: "Tag this agent (several: /tag auth, billing)",
      argumentHint: "<tag>[, <tag>...]",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        const { results } = await readable(() => rpc(addTagRpc, { tags: parseTagNames(args), agentId: agent.id, workspaceId: agent.workspaceId }));
        tagsChanged();
        if (!results.some((result) => result.changed)) throw new Error(`Already tagged: ${results.map((result) => result.name).join(", ")}`);
      },
    }),
    client.addSlashCommand({
      name: "untag",
      description: "Remove this agent from a tag (several: /untag auth, billing)",
      argumentHint: "<tag>[, <tag>...]",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        const { results } = await readable(() => rpc(removeTagRpc, { tags: parseTagNames(args), agentId: agent.id }));
        tagsChanged();
        if (!results.some((result) => result.changed)) throw new Error(`Not tagged: ${results.map((result) => result.name).join(", ")}`);
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
      name: "tag-fetch",
      description: "Fetch a Jira, Sentry, Slack, or Notion item into a tag through a background agent; the result shows up here",
      argumentHint: "<PROJ-123 or link> <tag>",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        const { ref, tag } = parseFetchCommand(args);
        await readable(() => rpc(fetchItemRpc, { tag, ref, notifyAgentId: agent.id }));
        tagsChanged();
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
    ...([true, false] as const).map((pinned) =>
      client.addCommandCenterItem({
        id: pinned ? "pin-agent" : "unpin-agent",
        title: pinned ? "Pin this agent (first in Attach > Agent conversation)" : "Unpin this agent",
        icon: pinned ? "Pin" : "PinOff",
        keywords: ["pin", "unpin", "favorite", "contextualise"],
        context: "agent",
        async onSelect({ agent, rpc }) {
          await rpc(pinAgentRpc, { agentId: agent.id, pinned });
          tagsChanged();
        },
      }),
    ),
    client.addCommandCenterItem({
      id: "open-knowledge",
      title: "Open project knowledge",
      icon: ICONS.knowledge,
      keywords: ["knowledge", "docs", "adr", "architecture", "tasks", "contextualise"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "knowledge" });
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
