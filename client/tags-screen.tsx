import { type PluginScreenProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  addLinkRpc,
  type AgentMember,
  type LinkMember,
  listTagsRpc,
  previewTagRpc,
  removeLinkRpc,
  removeTagRpc,
  type TagSummary,
} from "../shared/contracts";
import { AgentTags } from "./agent-tags";
import { errorText } from "./errors";
import { ago, Button, plural, type Styles, summary, TAGS_QUERY, useStyles, useTagChange } from "./kit";
import { onTagsChanged } from "./tag-events";

type Navigation = PluginScreenProps["navigation"];

function AgentRow({ agent, tag, styles, navigation }: { agent: AgentMember; tag: TagSummary; styles: Styles; navigation: Navigation }) {
  const workspaceName = useWorkspace(agent.workspaceId, (workspace) => workspace.name);
  const remove = useRpc(removeTagRpc);
  const removal = useTagChange(() => remove({ tags: [tag.name], agentId: agent.agentId }));
  const open = navigation && agent.state !== "missing" ? () => navigation.openAgent({ agentId: agent.agentId }) : undefined;
  const state = agent.state === "missing" ? "missing: Paseo no longer has this agent" : agent.state === "archived" ? "archived" : null;
  return (
    <View style={styles.row}>
      <Pressable style={styles.grow} disabled={!open} onPress={open} accessibilityRole={open ? "link" : undefined} accessibilityLabel={`Open agent ${agent.title ?? agent.agentId}`}>
        <Text style={styles.text} numberOfLines={1}>
          {agent.title ?? agent.agentId}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {[agent.provider ?? "unknown provider", workspaceName, state, `tagged ${ago(agent.taggedAt)}`].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      <Pressable onPress={() => removal.mutate(undefined)} disabled={removal.isPending} accessibilityRole="button" accessibilityLabel={`Remove ${agent.title ?? agent.agentId} from ${tag.name}`}>
        <Text style={styles.danger}>{removal.isPending ? "Removing" : "Remove"}</Text>
      </Pressable>
    </View>
  );
}

function LinkRow({ link, tag, styles }: { link: LinkMember; tag: TagSummary; styles: Styles }) {
  const remove = useRpc(removeLinkRpc);
  const removal = useTagChange(() => remove({ tag: tag.name, url: link.url }));
  return (
    <View style={styles.row}>
      <View style={styles.grow}>
        <Text style={styles.text} numberOfLines={1}>
          {link.title}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {link.url}
        </Text>
      </View>
      <Pressable onPress={() => removal.mutate(undefined)} disabled={removal.isPending} accessibilityRole="button" accessibilityLabel={`Remove link ${link.title} from ${tag.name}`}>
        <Text style={styles.danger}>{removal.isPending ? "Removing" : "Remove"}</Text>
      </Pressable>
    </View>
  );
}

function AddLinkForm({ tagName, styles, onClose }: { tagName: string; styles: Styles; onClose(): void }) {
  const add = useRpc(addLinkRpc);
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const adding = useTagChange(
    () => add({ tag: tagName, url, title: title.trim() || undefined }),
    (outcome) => {
      toast.show(outcome.changed ? `Link added to "${outcome.name}"` : `"${outcome.name}" already has this link`, { variant: outcome.changed ? "success" : "info" });
      setUrl("");
      setTitle("");
      onClose();
    },
  );
  return (
    <View style={styles.wrap}>
      <TextInput style={styles.input} value={url} onChangeText={setUrl} placeholder="https://..." autoCapitalize="none" autoCorrect={false} accessibilityLabel="Link URL" />
      <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Title (optional)" accessibilityLabel="Link title" onSubmitEditing={() => adding.mutate(undefined)} />
      <Button label="Add link" kind="primary" styles={styles} onPress={() => adding.mutate(undefined)} disabled={adding.isPending || url.trim() === ""} />
      <Button label="Cancel" styles={styles} onPress={onClose} />
    </View>
  );
}

// Exactly what Attach > Tag would send, so it can be read (and copied) before sending.
function PreviewModal({ tag, styles, onClose }: { tag: TagSummary; styles: Styles; onClose(): void }) {
  const preview = useRpc(previewTagRpc);
  const toast = useToast();
  const query = useQuery({ queryKey: ["contextualise", "preview", tag.key], queryFn: () => preview({ tag: tag.name }), staleTime: 0 });
  return (
    <Modal title={`What Attach > Tag sends for "${tag.name}"`} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        {query.isPending ? <Text style={styles.muted}>Building the attachment</Text> : null}
        {query.error ? <Text style={styles.danger}>{errorText(query.error)}</Text> : null}
        {query.data ? (
          <View style={{ gap: 12 }}>
            <View style={styles.row}>
              <Text style={[styles.muted, styles.grow]}>
                {query.data.subtitle} · {plural(query.data.text.length, "character")}
              </Text>
              <Button
                label="Copy"
                styles={styles}
                onPress={() =>
                  void copyText(query.data.text).then(
                    () => toast.show("Copied", { variant: "success" }),
                    (error: unknown) => toast.error(errorText(error)),
                  )
                }
              />
            </View>
            <Markdown>{query.data.text}</Markdown>
          </View>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

function TagCard({ tag, styles, navigation }: { tag: TagSummary; styles: Styles; navigation: Navigation }) {
  const [linking, setLinking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={styles.title}>{tag.name}</Text>
          <Text style={styles.muted}>{summary(tag) || "empty"}</Text>
        </View>
        <Button label="Preview" styles={styles} onPress={() => setPreviewing(true)} />
        <Button label="Add link" styles={styles} onPress={() => setLinking((open) => !open)} />
      </View>
      {!tag.hasWorkspaceLabel ? (
        <Text style={styles.muted}>No workspace has this label. Add the label "{tag.name}" to a workspace in Paseo to include it; if you renamed a label, tag these again under the new name.</Text>
      ) : null}
      {linking ? <AddLinkForm tagName={tag.name} styles={styles} onClose={() => setLinking(false)} /> : null}
      {tag.workspaces.length > 0 ? <Text style={styles.section}>Workspaces (Paseo label)</Text> : null}
      {tag.workspaces.map((workspace) => (
        <Pressable
          key={workspace.workspaceId}
          disabled={!navigation}
          onPress={() => navigation?.openWorkspace({ workspaceId: workspace.workspaceId })}
          accessibilityRole="link"
          accessibilityLabel={`Open workspace ${workspace.name}`}
        >
          <Text style={styles.text} numberOfLines={1}>
            {workspace.projectName} / {workspace.name}
          </Text>
          <Text style={styles.muted} numberOfLines={1}>
            {workspace.directory}
          </Text>
        </Pressable>
      ))}
      {tag.agents.length > 0 ? <Text style={styles.section}>Agents</Text> : null}
      {tag.agents.map((agent) => (
        <AgentRow key={agent.agentId} agent={agent} tag={tag} styles={styles} navigation={navigation} />
      ))}
      {tag.links.length > 0 ? <Text style={styles.section}>Links</Text> : null}
      {tag.links.map((link) => (
        <LinkRow key={link.url} link={link} tag={tag} styles={styles} />
      ))}
      {previewing ? <PreviewModal tag={tag} styles={styles} onClose={() => setPreviewing(false)} /> : null}
    </View>
  );
}

export function TagsScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const list = useRpc(listTagsRpc);
  const queryClient = useQueryClient();
  const tags = useQuery({ queryKey: TAGS_QUERY, queryFn: () => list({}) });
  const [filter, setFilter] = useState("");
  useEffect(() => onTagsChanged(() => void queryClient.invalidateQueries({ queryKey: TAGS_QUERY })), [queryClient]);
  const wanted = filter.trim().toLowerCase();
  const shown = (tags.data?.tags ?? []).filter(
    (tag) => wanted === "" || [tag.name, ...tag.agents.map((agent) => agent.title ?? ""), ...tag.links.map((link) => link.title)].some((text) => text.toLowerCase().includes(wanted)),
  );
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {params.agentId ? <AgentTags agentId={params.agentId} fallbackWorkspaceId={params.workspaceId} styles={styles} /> : null}
      <TextInput style={styles.input} value={filter} onChangeText={setFilter} placeholder="Filter tags, agents, and links" accessibilityLabel="Filter tags" />
      {tags.isPending ? <Text style={styles.muted}>Loading tags</Text> : null}
      {tags.error ? <Text style={styles.danger}>Could not load tags: {errorText(tags.error)}</Text> : null}
      {tags.data && tags.data.tags.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>No tags yet</Text>
          <Text style={styles.text}>In any agent, press the Tags pill next to the message box, or type /tag auth-rewrite (and /untag to remove it).</Text>
          <Text style={styles.text}>Workspaces you label in Paseo join the tag with the same name.</Text>
          <Text style={styles.text}>Add a web link with /tag-link https://example.com/spec auth-rewrite.</Text>
          <Text style={styles.text}>Then, in any prompt, Attach &gt; Tag sends everything under it.</Text>
        </View>
      ) : null}
      {tags.data && tags.data.tags.length > 0 && shown.length === 0 ? <Text style={styles.muted}>No tag matches "{filter}".</Text> : null}
      {shown.map((tag) => (
        <TagCard key={tag.key} tag={tag} styles={styles} navigation={navigation} />
      ))}
    </ScrollView>
  );
}
