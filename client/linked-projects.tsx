import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { addLinkRpc, newLinkedChatRpc, removeLinkRpc, workspaceLinksRpc } from "../shared/linked-projects";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { Button, IconButton, ListRow, SearchField, Segmented, StateView, type Styles } from "./kit";

export const linksQuery = (workspaceId: string) => ["contextualise", "links", workspaceId];
// Rows drawn at first; scrolling near the end of the list draws this many more.
const PAGE = 30;
// How close to the end of the list, in points, counts as reaching it.
const NEAR_END = 80;
// Paseo caps a plugin popover at 440 points (app/src/plugins/popover.tsx). The list takes what the
// tabs, search box, buttons, and each attached row (about 50) leave, so the heading stays in view.
const listHeight = (attached: number) => (attached === 0 ? 260 : Math.max(120, 240 - 50 * attached));

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

// The tab last chosen, kept while the app runs, so the popover opens where M left it.
type AttachKind = "projects" | "workspaces";
const KINDS = [
  { label: "Projects", value: "projects" },
  { label: "Workspaces", value: "workspaces" },
] as const;
let lastKind: AttachKind = "projects";

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
  const [kind, setKind] = useState<AttachKind>(lastKind);
  const [shown, setShown] = useState(PAGE);
  const searchFor = (text: string) => {
    setSearch(text);
    setShown(PAGE);
  };
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: (payload) => {
      queryClient.setQueryData(linksQuery(workspaceId), payload);
      linksChanged();
      searchFor("");
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
  const words = search.trim().toLowerCase();
  const has = (...texts: (string | null)[]) => words === "" || texts.some((text) => text?.toLowerCase().includes(words));
  // One row shape for both tabs: a project by its folder, a workspace by its title, branch, and project.
  const rows =
    kind === "projects"
      ? (data?.suggestions ?? []).filter((found) => has(found.name, found.path)).map((found) => ({ key: found.path, title: found.name, meta: found.path, path: found.path, attachedWorkspaceId: undefined }))
      : (data?.workspaces ?? []).filter((found) => has(found.name, found.project, found.branch, found.path)).map((found) => ({ key: found.workspaceId, title: found.name, meta: [found.branch, found.project].filter(Boolean).join(" · "), path: found.path, attachedWorkspaceId: found.workspaceId }));
  const folder = typedFolder(search);
  const attach = (path: string, attachedWorkspaceId?: string) => change.mutate(() => add({ workspaceId, path, ...(attachedWorkspaceId ? { attachedWorkspaceId } : {}) }));
  const noun = kind === "projects" ? "project" : "workspace";
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
      <Segmented
        options={KINDS}
        value={kind}
        onChange={(next) => {
          lastKind = next;
          setKind(next);
          setShown(PAGE);
        }}
        label="What to attach"
        styles={styles}
        stretch
      />
      <SearchField value={search} onChange={searchFor} placeholder={`Attach a ${noun}, or type a folder path`} label={`${noun} to attach`} styles={styles} />
      <ScrollView
        style={{ maxHeight: listHeight(links.length) }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={100}
        onScroll={({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }) => {
          if (shown < rows.length && layoutMeasurement.height + contentOffset.y >= contentSize.height - NEAR_END) setShown(shown + PAGE);
        }}
      >
        {folder && !rows.some((row) => row.path === folder) ? <ListRow title={`Attach folder ${folder}`} icon={ICONS.attach} onPress={() => attach(folder)} disabled={change.isPending} styles={styles} /> : null}
        {rows.slice(0, shown).map((row) => (
          <ListRow key={row.key} title={row.title} meta={row.meta} icon={kind === "projects" ? ICONS.attach : ICONS.workspace} onPress={() => attach(row.path, row.attachedWorkspaceId)} disabled={change.isPending} accessibilityLabel={`Attach ${row.title}`} styles={styles} />
        ))}
        {rows.length === 0 && !folder && data ? <Text style={[styles.note, { paddingHorizontal: 12, paddingVertical: 8 }]}>{words ? `No ${noun} matches "${search.trim()}"` : `No other ${noun}s`}</Text> : null}
      </ScrollView>
      {data?.sharedFolder && links.length > 0 ? (
        <View style={styles.inline}>
          <Icon name={ICONS.info} size={14} color={styles.colors.foregroundMuted} />
          <Text style={[styles.note, styles.grow]}>Shared folder: start chats with New Chat to get these projects.</Text>
        </View>
      ) : null}
      {agentId && links.length > 0 ? (
        // Two equal choices, so neither is primary.
        <View style={[styles.row, { borderTopWidth: 1, borderColor: styles.colors.border, paddingTop: 8, justifyContent: "space-evenly" }]}>
          <Button label="New Chat" icon={ICONS.add} styles={styles} onPress={() => starting.mutate(false)} disabled={starting.isPending} />
          <Button label="Fork Chat" icon={ICONS.fork} styles={styles} onPress={() => starting.mutate(true)} disabled={starting.isPending} />
        </View>
      ) : null}
    </View>
  );
}
