import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { addLinkRpc, newLinkedChatRpc, removeLinkRpc, workspaceLinksRpc } from "../shared/linked-projects";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { Button, IconButton, ListRow, SearchField, StateView, type Styles } from "./kit";

export const linksQuery = (workspaceId: string) => ["contextualise", "links", workspaceId];
// Rows drawn at once; with hundreds of projects the search narrows the rest.
const SHOWN = 30;

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

// What was typed is a folder, not a search: it starts like a path.
const typedFolder = (text: string) => (/^[~/.]/.test(text.trim()) ? text.trim() : null);

// One workspace's attached projects: the folders every new Claude, Codex, or OpenCode chat in it can read and
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
  const [search, setSearch] = useState("");
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: (payload) => {
      queryClient.setQueryData(linksQuery(workspaceId), payload);
      linksChanged();
      setSearch("");
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
  const suggestions = data?.suggestions ?? [];
  const words = search.trim().toLowerCase();
  const matches = suggestions.filter((found) => words === "" || found.name.toLowerCase().includes(words) || found.path.toLowerCase().includes(words));
  const folder = typedFolder(search);
  const attach = (path: string) => change.mutate(() => add({ workspaceId, path }));
  return (
    <View style={{ gap: 8 }}>
      {query.error ? <StateView state="error" text={`Could not load attached projects: ${errorText(query.error)}`} styles={styles} /> : null}
      {links.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.heading}>{`Attached ${links.length}`}</Text>
          {links.map((link) => (
            // Attached rows stand out: a fill and a folder-with-check icon.
            <View key={link.path} style={[styles.row, { paddingVertical: 6, paddingLeft: 12, paddingRight: 4, borderRadius: 8, backgroundColor: styles.colors.surface2 }]}>
              <Icon name={ICONS.attached} size={16} color={styles.colors.accent} />
              <View style={styles.grow}>
                <Text style={styles.body} numberOfLines={1}>
                  {link.name}
                </Text>
                <Text style={styles.note} numberOfLines={1}>
                  {link.path}
                </Text>
              </View>
              <IconButton icon={ICONS.close} label={`Remove ${link.name} from this workspace`} onPress={() => change.mutate(() => remove({ workspaceId, path: link.path }))} disabled={change.isPending} styles={styles} />
            </View>
          ))}
        </View>
      ) : null}
      <SearchField value={search} onChange={setSearch} placeholder={suggestions.length > 0 ? "Attach a project, or type a folder path" : "Type a folder path to attach"} label="Project to attach" styles={styles} />
      <ScrollView style={{ maxHeight: 240 }} keyboardShouldPersistTaps="handled">
        {folder && !matches.some((found) => found.path === folder) ? <ListRow title={`Attach folder ${folder}`} icon={ICONS.attach} onPress={() => attach(folder)} disabled={change.isPending} styles={styles} /> : null}
        {matches.slice(0, SHOWN).map((found) => (
          <ListRow key={found.path} title={found.name} meta={found.path} icon={ICONS.attach} onPress={() => attach(found.path)} disabled={change.isPending} accessibilityLabel={`Attach ${found.path}`} styles={styles} />
        ))}
        {matches.length === 0 && !folder && data ? <Text style={[styles.note, { paddingHorizontal: 12, paddingVertical: 8 }]}>{words ? `No project matches "${search.trim()}"` : "No other projects"}</Text> : null}
        {matches.length > SHOWN ? <Text style={[styles.note, { paddingHorizontal: 12, paddingVertical: 8 }]}>{`${matches.length - SHOWN} more; type to narrow`}</Text> : null}
      </ScrollView>
      {data?.sharedFolder && links.length > 0 ? (
        <View style={styles.inline}>
          <Icon name={ICONS.info} size={14} color={styles.colors.foregroundMuted} />
          <Text style={[styles.note, styles.grow]}>Shared folder: start chats with New chat to get these projects.</Text>
        </View>
      ) : null}
      {agentId && links.length > 0 ? (
        <View style={[styles.row, { borderTopWidth: 1, borderColor: styles.colors.border, paddingTop: 8, flexWrap: "wrap" }]}>
          <Button label="New chat" icon={ICONS.add} kind="primary" styles={styles} onPress={() => starting.mutate(false)} disabled={starting.isPending} />
          <Button label="Fork with projects" icon={ICONS.link} styles={styles} onPress={() => starting.mutate(true)} disabled={starting.isPending} />
        </View>
      ) : null}
    </View>
  );
}
