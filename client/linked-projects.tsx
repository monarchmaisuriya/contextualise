import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { addLinkRpc, mentionPath, newLinkedChatRpc, removeLinkRpc, workspaceFilesRpc, workspaceLinksRpc } from "../shared/linked-projects";
import { type AttachTab, attachTabs, shownTab } from "./attach-tabs";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { Button, IconButton, ListRow, SearchField, Segmented, StateView, type Styles } from "./kit";
import { type WorkspaceItem, workspaceItems } from "./workspace-rows";

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
let lastTab: AttachTab = "projects";

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
  const [chosen, setTab] = useState<AttachTab>(lastTab);
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
  const attachedCount = data ? links.length : null;
  const tab = shownTab(chosen, attachedCount);
  const words = search.trim().toLowerCase();
  const has = (...texts: (string | null)[]) => words === "" || texts.some((text) => text?.toLowerCase().includes(words));
  // One item shape for both tabs: a project by its folder; a workspace by its title, branch, and
  // project, with its repositories under one heading when it offers several.
  const items: WorkspaceItem[] =
    tab === "projects"
      ? (data?.suggestions ?? []).filter((found) => has(found.name, found.path)).map((found) => ({ kind: "row", key: found.path, title: found.name, meta: found.path, path: found.path, nested: false }))
      : workspaceItems(data?.workspaces ?? [], (found) => has(found.name, found.project, found.branch, found.path));
  const rows = items.filter((item) => item.kind === "row");
  const folder = typedFolder(search);
  const attach = (path: string, attachedWorkspaceId?: string) => change.mutate(() => add({ workspaceId, path, ...(attachedWorkspaceId ? { attachedWorkspaceId } : {}) }));
  const noun = tab === "projects" ? "project" : "workspace";
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
        options={attachTabs(attachedCount)}
        value={tab}
        onChange={(next) => {
          lastTab = next;
          setTab(next);
          setShown(PAGE);
        }}
        label="Attached button tabs"
        styles={styles}
        stretch
      />
      {tab === "files" ? (
        <ProjectFiles workspaceId={workspaceId} attached={links.map((link) => link.path)} maxHeight={listHeight(links.length)} styles={styles} />
      ) : (
        <>
          <SearchField value={search} onChange={searchFor} placeholder={`Attach a ${noun}, or type a folder path`} label={`${noun} to attach`} styles={styles} />
          <ScrollView
            style={{ maxHeight: listHeight(links.length) }}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={100}
            onScroll={({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }) => {
              if (shown < items.length && layoutMeasurement.height + contentOffset.y >= contentSize.height - NEAR_END) setShown(shown + PAGE);
            }}
          >
            {folder && !rows.some((row) => row.path === folder) ? <ListRow title={`Attach folder ${folder}`} icon={ICONS.attach} onPress={() => attach(folder)} disabled={change.isPending} styles={styles} /> : null}
            {items.slice(0, shown).map((item) =>
              item.kind === "heading" ? (
                <View key={item.key} style={[styles.inline, { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 }]} accessibilityRole="header">
                  <Icon name={ICONS.workspace} size={16} color={styles.colors.foregroundMuted} />
                  <Text style={[styles.body, styles.grow]} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.note} numberOfLines={1}>
                    {item.meta}
                  </Text>
                </View>
              ) : (
                <View key={item.key} style={item.nested ? { paddingLeft: 20 } : null}>
                  <ListRow title={item.title} meta={item.meta} icon={tab === "projects" ? ICONS.attach : item.nested ? ICONS.folder : ICONS.workspace} onPress={() => attach(item.path, item.attachedWorkspaceId)} disabled={change.isPending} accessibilityLabel={`Attach ${item.title}`} styles={styles} />
                </View>
              ),
            )}
            {rows.length === 0 && !folder && data ? <Text style={[styles.note, { paddingHorizontal: 12, paddingVertical: 8 }]}>{words ? `No ${noun} matches "${search.trim()}"` : `No other ${noun}s`}</Text> : null}
          </ScrollView>
        </>
      )}
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

// The Project files tab: files and folders of this workspace's attached projects, searched on the
// daemon and ranked like Attach > Project file. Picking a row copies its path the way `@` writes one,
// since a plugin cannot write into the message box. The attached folders are part of the query key,
// so attaching or detaching one lists again.
function ProjectFiles({ workspaceId, attached, maxHeight, styles }: { workspaceId: string; attached: readonly string[]; maxHeight: number; styles: Styles }) {
  const toast = useToast();
  const listFiles = useRpc(workspaceFilesRpc);
  const [search, setSearch] = useState("");
  const words = search.trim();
  const files = useQuery({
    queryKey: ["contextualise", "workspace-files", workspaceId, [...attached].sort().join("\n"), words],
    queryFn: () => listFiles({ workspaceId, query: words }),
    placeholderData: keepPreviousData,
  });
  const rows = files.data?.files ?? [];
  const copyPath = (path: string, title: string) =>
    copyText(mentionPath(path)).then(
      () => toast.show(`Copied ${title}; paste it into your message`, { variant: "success" }),
      (error: unknown) => toast.error(`Could not copy the path: ${errorText(error)}`),
    );
  return (
    <>
      <SearchField value={search} onChange={setSearch} placeholder="Search files and folders in attached projects" label="File or folder to copy" styles={styles} />
      <ScrollView style={{ maxHeight }} keyboardShouldPersistTaps="handled">
        {rows.map((row) => (
          <ListRow key={row.path} title={row.title} meta={row.project} icon={row.kind === "folder" ? ICONS.folder : ICONS.file} onPress={() => void copyPath(row.path, row.title)} accessibilityLabel={`Copy the path of ${row.title} in ${row.project}`} styles={styles} />
        ))}
        {files.error ? <StateView state="error" text={`Could not list the attached projects' files: ${errorText(files.error)}`} styles={styles} /> : null}
        {rows.length === 0 && !files.error ? <Text style={[styles.note, { paddingHorizontal: 12, paddingVertical: 8 }]}>{files.isFetching ? "Searching…" : words ? `No file or folder matches "${words}"` : "No files"}</Text> : null}
      </ScrollView>
    </>
  );
}
