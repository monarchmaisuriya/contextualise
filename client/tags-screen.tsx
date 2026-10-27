import { type PluginScreenProps, useAgent, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  addLinkRpc,
  addTagRpc,
  type AgentMember,
  type LinkMember,
  listTagsRpc,
  parseTagNames,
  previewTagRpc,
  removeLinkRpc,
  removeTagRpc,
  type TagSummary,
} from "../shared/contracts";
import { errorText } from "./errors";
import { onTagsChanged } from "./tag-events";

const TAGS_QUERY = ["contextualise", "tags"];
type Theme = PluginScreenProps["theme"];
type Navigation = PluginScreenProps["navigation"];

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: 14, maxWidth: 860, width: "100%" as const, alignSelf: "center" as const },
      card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: compact ? 12 : 16, gap: 10, backgroundColor: theme.colors.surface1 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      section: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const, marginTop: 4 },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      link: { color: theme.colors.accent, fontSize: 13 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      wrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      grow: { flex: 1, minWidth: 0 },
      input: { flex: 1, minWidth: 120, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 },
      button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground },
      ghost: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
      ghostText: { color: theme.colors.foreground, fontSize: 13 },
      chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 },
      chipOn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 13 },
      chipOnText: { color: theme.colors.accentForeground, fontSize: 13 },
    }),
    [theme, compact],
  );
}
type Styles = ReturnType<typeof useStyles>;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function summary(tag: TagSummary): string {
  const parts = [[tag.agents.length, "agent"], [tag.workspaces.length, "workspace"], [tag.links.length, "link"]] as const;
  return parts.filter(([n]) => n > 0).map(([n, word]) => plural(n, word)).join(" · ");
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 60 / 24)} d ago`;
}

// Mutations that change tags refresh the list and report failures as readable toasts.
function useTagChange<Input, Output>(run: (input: Input) => Promise<Output>, onDone?: (output: Output, input: Input) => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: run,
    onSuccess: (output, input) => {
      void queryClient.invalidateQueries({ queryKey: TAGS_QUERY });
      onDone?.(output, input);
    },
    onError: (error) => toast.error(errorText(error)),
  });
}

function Button({ label, onPress, styles, disabled, kind = "ghost" }: { label: string; onPress(): void; styles: Styles; disabled?: boolean; kind?: "ghost" | "primary" }) {
  return (
    <Pressable style={kind === "primary" ? styles.button : styles.ghost} onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={kind === "primary" ? styles.buttonText : styles.ghostText}>{label}</Text>
    </Pressable>
  );
}

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

// Opened for one agent (/tags, "Tag this agent...", or a confirmation row): its tags as chips to
// remove, every other tag as a chip to add, and a box for new names.
function AgentTags({ agentId, fallbackWorkspaceId, tags, styles }: { agentId: string; fallbackWorkspaceId: string | undefined; tags: TagSummary[]; styles: Styles }) {
  const agent = useAgent(agentId, (snapshot) => ({ title: snapshot.title, workspaceId: snapshot.workspaceId }));
  const workspaceId = agent?.workspaceId ?? fallbackWorkspaceId;
  const add = useRpc(addTagRpc);
  const remove = useRpc(removeTagRpc);
  const toast = useToast();
  const [names, setNames] = useState("");
  const adding = useTagChange(
    (list: string[]) => {
      if (!workspaceId) throw new Error("This agent's workspace is not loaded yet; open the agent once and try again");
      return add({ tags: list, agentId, workspaceId });
    },
    () => setNames(""),
  );
  const removing = useTagChange((name: string) => remove({ tags: [name], agentId }));
  const mine = tags.filter((tag) => tag.agents.some((member) => member.agentId === agentId));
  const others = tags.filter((tag) => !mine.includes(tag)).slice(0, 24);
  const submit = () => {
    try {
      adding.mutate(parseTagNames(names));
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{agent?.title ?? "This agent"}</Text>
      <Text style={styles.muted}>{mine.length === 0 ? "No tags yet." : "Tagged with (tap to remove):"}</Text>
      {mine.length > 0 ? (
        <View style={styles.wrap}>
          {mine.map((tag) => (
            <Pressable key={tag.key} style={styles.chipOn} onPress={() => removing.mutate(tag.name)} accessibilityRole="button" accessibilityLabel={`Remove tag ${tag.name}`}>
              <Text style={styles.chipOnText}>{tag.name} ×</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <TextInput style={styles.input} value={names} onChangeText={setNames} placeholder="New tags, separated by commas" onSubmitEditing={submit} accessibilityLabel="Tag names" />
        <Button label="Add" kind="primary" styles={styles} onPress={submit} disabled={adding.isPending} />
      </View>
      {others.length > 0 ? (
        <>
          <Text style={styles.muted}>Add an existing tag:</Text>
          <View style={styles.wrap}>
            {others.map((tag) => (
              <Pressable key={tag.key} style={styles.chip} onPress={() => adding.mutate([tag.name])} accessibilityRole="button" accessibilityLabel={`Add tag ${tag.name}`}>
                <Text style={styles.chipText}>+ {tag.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
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
      {params.agentId && tags.data ? <AgentTags agentId={params.agentId} fallbackWorkspaceId={params.workspaceId} tags={tags.data.tags} styles={styles} /> : null}
      <TextInput style={styles.input} value={filter} onChangeText={setFilter} placeholder="Filter tags, agents, and links" accessibilityLabel="Filter tags" />
      {tags.isPending ? <Text style={styles.muted}>Loading tags</Text> : null}
      {tags.error ? <Text style={styles.danger}>Could not load tags: {errorText(tags.error)}</Text> : null}
      {tags.data && tags.data.tags.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>No tags yet</Text>
          <Text style={styles.text}>In any agent, type /tag auth-rewrite (or several: /tag auth, billing).</Text>
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
