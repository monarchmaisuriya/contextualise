import { type PluginScreenProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { addTagRpc, type AgentMember, listTagsRpc, removeTagRpc, type TagSummary } from "../shared/contracts";
import { onTagsChanged } from "./tag-events";

const TAGS_QUERY = ["contextualise", "tags"];
type Theme = PluginScreenProps["theme"];

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: 16 },
      card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 14, gap: 8, backgroundColor: theme.colors.surface1 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      warning: { color: theme.colors.statusWarning, fontSize: 13 },
      danger: { color: theme.colors.statusDanger },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      grow: { flex: 1 },
      input: { flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: theme.colors.foreground },
      button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground },
      link: { color: theme.colors.accent, fontSize: 13 },
    }),
    [theme, compact],
  );
}
type Styles = ReturnType<typeof useStyles>;

function describeAgent(agent: AgentMember): string {
  if (agent.state === "missing") return "missing: Paseo no longer has this agent";
  return [agent.provider ?? "unknown provider", agent.state === "archived" ? "archived" : null].filter(Boolean).join(", ");
}

function AgentRow({ agent, tag, styles, navigation }: { agent: AgentMember; tag: TagSummary; styles: Styles; navigation: PluginScreenProps["navigation"] }) {
  const workspaceName = useWorkspace(agent.workspaceId, (workspace) => workspace.name);
  const remove = useRpc(removeTagRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const removal = useMutation({
    mutationFn: () => remove({ tag: tag.name, agentId: agent.agentId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: TAGS_QUERY }),
    onError: (error) => toast.error(String((error as Error).message ?? error)),
  });
  const open = navigation && agent.state !== "missing" ? () => navigation.openAgent({ agentId: agent.agentId }) : undefined;
  return (
    <View style={styles.row}>
      <Pressable style={styles.grow} disabled={!open} onPress={open} accessibilityRole={open ? "link" : undefined} accessibilityLabel={`Open agent ${agent.title ?? agent.agentId}`}>
        <Text style={styles.text}>{agent.title ?? agent.agentId}</Text>
        <Text style={styles.muted}>
          {describeAgent(agent)}
          {workspaceName ? ` · ${workspaceName}` : ""}
        </Text>
      </Pressable>
      <Pressable onPress={() => removal.mutate()} disabled={removal.isPending} accessibilityRole="button" accessibilityLabel={`Remove ${agent.title ?? agent.agentId} from ${tag.name}`}>
        <Text style={styles.danger}>{removal.isPending ? "Removing" : "Remove"}</Text>
      </Pressable>
    </View>
  );
}

function TagCard({ tag, styles, navigation }: { tag: TagSummary; styles: Styles; navigation: PluginScreenProps["navigation"] }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{tag.name}</Text>
      {!tag.hasWorkspaceLabel ? <Text style={styles.warning}>No workspace label with this name. If you renamed a label, tag these agents again under the new name.</Text> : null}
      {tag.workspaces.map((workspace) => (
        <Pressable
          key={workspace.workspaceId}
          disabled={!navigation}
          onPress={() => navigation?.openWorkspace({ workspaceId: workspace.workspaceId })}
          accessibilityRole="link"
          accessibilityLabel={`Open workspace ${workspace.name}`}
        >
          <Text style={styles.text}>
            {workspace.projectName} / {workspace.name}
          </Text>
          <Text style={styles.muted}>workspace label · {workspace.directory}</Text>
        </Pressable>
      ))}
      {tag.agents.map((agent) => (
        <AgentRow key={agent.agentId} agent={agent} tag={tag} styles={styles} navigation={navigation} />
      ))}
      {tag.workspaces.length > 0 ? <Text style={styles.muted}>Workspace labels are managed in Paseo: Manage labels on the workspace.</Text> : null}
    </View>
  );
}

// Opened with an agent ("Tag this agent..."), the screen starts with a box to tag that agent.
function TagAgentForm({ params, styles }: { params: PluginScreenProps["params"]; styles: Styles }) {
  const add = useRpc(addTagRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const adding = useMutation({
    mutationFn: () => add({ tag: name, agentId: params.agentId, workspaceId: params.workspaceId }),
    onSuccess: ({ added }) => {
      toast.show(added ? `Tagged ${params.agentTitle ?? "agent"} "${name.trim()}"` : `Already tagged "${name.trim()}"`, { variant: added ? "success" : "info" });
      setName("");
      void queryClient.invalidateQueries({ queryKey: TAGS_QUERY });
    },
    onError: (error) => toast.error(String((error as Error).message ?? error)),
  });
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Tag {params.agentTitle ?? "this agent"}</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Tag name, for example auth-rewrite" onSubmitEditing={() => adding.mutate()} accessibilityLabel="Tag name" />
        <Pressable style={styles.button} onPress={() => adding.mutate()} disabled={adding.isPending} accessibilityRole="button" accessibilityLabel="Add tag">
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function TagsScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const list = useRpc(listTagsRpc);
  const queryClient = useQueryClient();
  const tags = useQuery({ queryKey: TAGS_QUERY, queryFn: () => list({}) });
  useEffect(() => onTagsChanged(() => void queryClient.invalidateQueries({ queryKey: TAGS_QUERY })), [queryClient]);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {params.agentId && params.workspaceId ? <TagAgentForm params={params} styles={styles} /> : null}
      {tags.isPending ? <Text style={styles.muted}>Loading tags</Text> : null}
      {tags.error ? <Text style={styles.danger}>Could not load tags: {String(tags.error.message)}</Text> : null}
      {tags.data && tags.data.tags.length === 0 ? (
        <Text style={styles.muted}>No tags yet. In any agent, type /tag followed by a name, or add a workspace label in Paseo.</Text>
      ) : null}
      {tags.data?.tags.map((tag) => <TagCard key={tag.key} tag={tag} styles={styles} navigation={navigation} />)}
    </ScrollView>
  );
}

