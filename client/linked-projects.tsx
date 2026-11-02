import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { addLinkRpc, newLinkedChatRpc, removeLinkRpc, workspaceLinksRpc } from "../shared/linked-projects";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { Button, Chip, SectionHeader, StateView, type Styles } from "./kit";

export const linksQuery = (workspaceId: string) => ["contextualise", "links", workspaceId];

// Any link change in this client tells the composer pills to relabel.
const listeners = new Set<() => void>();
export function onLinksChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function linksChanged(): void {
  for (const listener of listeners) listener();
}

// One workspace's attached projects: the folders every new Claude or Codex chat in it can read and
// edit. Used by the composer pill's popover (with `agentId`, so it can start chats like that one) and
// by the workspace panel.
export function LinkedProjects({ workspaceId, agentId, styles, openAgent }: { workspaceId: string; agentId?: string; styles: Styles; openAgent?: (agentId: string) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useRpc(workspaceLinksRpc);
  const query = useQuery({ queryKey: linksQuery(workspaceId), queryFn: () => list({ workspaceId }) });
  const add = useRpc(addLinkRpc);
  const remove = useRpc(removeLinkRpc);
  const newChat = useRpc(newLinkedChatRpc);
  const [path, setPath] = useState("");
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: (payload) => {
      queryClient.setQueryData(linksQuery(workspaceId), payload);
      linksChanged();
      setPath("");
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const starting = useMutation({
    mutationFn: (carryConversation: boolean) => newChat({ workspaceId, fromAgentId: agentId as string, carryConversation }),
    onSuccess: ({ agentId: created }, carried) => {
      if (openAgent) openAgent(created);
      else toast.show(carried ? "Started a chat with the attached projects that carries this conversation; it is in this workspace's tabs" : "Started a chat with the attached projects; it is in this workspace's tabs", { variant: "success" });
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const data = query.data;
  const links = data?.links ?? [];
  const submit = () => change.mutate(() => add({ workspaceId, path }));
  return (
    <View style={{ gap: 8 }}>
      {query.error ? <StateView state="error" text={`Could not load attached projects: ${errorText(query.error)}`} styles={styles} /> : null}
      <Text style={styles.note}>
        {links.length === 0
          ? "Attach another project, and every new Claude or Codex chat in this workspace can search, read, and edit it too. Picking a project in Attach > Project attaches it as well. Other workspaces are not affected."
          : "Every new Claude or Codex chat in this workspace can search, read, and edit these projects. Chats already running search them at once, and keep the folders they started with."}
      </Text>
      {links.length > 0 ? (
        <>
          <SectionHeader label="Attached to this workspace" styles={styles} />
          <View style={styles.wrap}>
            {links.map((link) => (
              <Chip key={link.path} label={`Detach ${link.name}`} icon={ICONS.close} on onPress={() => change.mutate(() => remove({ workspaceId, path: link.path }))} accessibilityLabel={`Detach ${link.path}`} styles={styles} />
            ))}
          </View>
        </>
      ) : null}
      {data && data.suggestions.length > 0 ? (
        <>
          <SectionHeader label="Attach a project" styles={styles} />
          <View style={styles.wrap}>
            {data.suggestions.slice(0, 12).map((found) => (
              <Chip key={found.path} label={found.name} icon={ICONS.add} onPress={() => change.mutate(() => add({ workspaceId, path: found.path }))} accessibilityLabel={`Attach ${found.path}`} styles={styles} />
            ))}
          </View>
        </>
      ) : null}
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={path}
          onChangeText={setPath}
          placeholder="Or type a folder path, e.g. ~/Develop/api"
          placeholderTextColor={styles.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submit}
          accessibilityLabel="Folder to attach"
        />
        <Button label="Attach" kind="primary" styles={styles} onPress={submit} disabled={change.isPending || path.trim() === ""} />
      </View>
      {data?.sharedFolder && links.length > 0 ? (
        <Text style={styles.note}>This workspace shares its folder with other workspaces, so chats started from Paseo's own new-chat button cannot be told apart and get no attached projects. Use New chat with attached projects.</Text>
      ) : null}
      {agentId && links.length > 0 ? (
        <View style={[styles.row, { borderTopWidth: 1, borderColor: styles.colors.border, paddingTop: 8, flexWrap: "wrap" }]}>
          <Button label="New chat with attached projects" icon={ICONS.add} kind="primary" styles={styles} onPress={() => starting.mutate(false)} disabled={starting.isPending} />
          <Button label="Continue this chat with them" icon={ICONS.link} styles={styles} onPress={() => starting.mutate(true)} disabled={starting.isPending} />
        </View>
      ) : null}
    </View>
  );
}
