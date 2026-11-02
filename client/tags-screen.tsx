import { openExternalUrl, type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  addLinkRpc,
  type AgentMember,
  FETCH_PROVIDER_LABELS,
  type LinkMember,
  listTagsRpc,
  type NoteMember,
  type PinnedAgent,
  pinAgentRpc,
  previewTagRpc,
  refreshNoteRpc,
  removeLinkRpc,
  removeNoteRpc,
  removeTagRpc,
  tagKey,
  type TagSummary,
  VENDOR_LABELS,
} from "../shared/contracts";
import { shortenLink } from "../shared/links";
import { AgentTags } from "./agent-tags";
import { errorText } from "./errors";
import { FetchForm, FULL_WIDTH_FIELD } from "./fetch-form";
import { ICONS, VENDOR_ICONS } from "./icons";
import { ago, Button, IconButton, ListRow, Page, plural, ReaderSheet, SearchField, SectionHeader, Segmented, StateView, type Styles, summary, TAGS_QUERY, useStyles, useTagChange } from "./kit";
import { onTagsChanged } from "./tag-events";
import { agentStatus, filterPlaceholder, filterTags, liveLine, selectedTag, SORT_LABELS, SORTS, type Sort, sortTags } from "./tag-list";

type Navigation = PluginScreenProps["navigation"];

const LIST_PANE_WIDTH = 320;
// How often an open Tags screen reads agents' states again.
const LIVE_REFRESH_MS = 10_000;
const SORT_OPTIONS = SORTS.map((value) => ({ value, label: SORT_LABELS[value] }));

function fetchingCount(tag: TagSummary): number {
  return tag.notes.filter((note) => note.status === "fetching").length;
}

// What needs M leads the line, then what the tag holds.
function tagMeta(tag: TagSummary): string {
  const pending = fetchingCount(tag);
  return [liveLine(tag) || null, summary(tag) || "empty", pending > 0 ? `${pending} fetching` : null].filter(Boolean).join(" · ");
}

// One agent: opens it when pressed (unless Paseo no longer has it), with `trailing` at the end.
function AgentLine({ agent, when, trailing, styles, navigation }: { agent: AgentMember | PinnedAgent; when: string; trailing: ReactNode; styles: Styles; navigation: Navigation }) {
  const open = navigation && agent.state !== "missing" ? () => navigation.openAgent({ agentId: agent.agentId }) : undefined;
  const state = agent.state === "missing" ? "missing: Paseo no longer has this agent" : agent.state === "archived" ? "archived" : null;
  const now = agentStatus(agent.live);
  return (
    <ListRow
      title={agent.title ?? agent.agentId}
      meta={[now?.text, agent.provider ?? "unknown provider", agent.workspaceName, state, when].filter(Boolean).join(" · ")}
      icon={agent.state === "archived" ? ICONS.archived : now?.urgent ? ICONS.failed : ICONS.agent}
      danger={agent.state === "missing" || Boolean(now?.urgent)}
      onPress={open}
      accessibilityLabel={`Open agent ${agent.title ?? agent.agentId}`}
      trailing={trailing}
      styles={styles}
    />
  );
}

function AgentRow({ agent, tag, styles, navigation }: { agent: AgentMember; tag: TagSummary; styles: Styles; navigation: Navigation }) {
  const remove = useRpc(removeTagRpc);
  const removal = useTagChange(() => remove({ tags: [tag.name], agentId: agent.agentId }));
  const trailing = <IconButton icon={ICONS.close} label={`Remove ${agent.title ?? agent.agentId} from ${tag.name}`} onPress={() => removal.mutate(undefined)} disabled={removal.isPending} styles={styles} />;
  return <AgentLine agent={agent} when={ago(agent.taggedAt)} trailing={trailing} styles={styles} navigation={navigation} />;
}

// Pinned agents come first in Attach > Chat. One Paseo no longer has stays until unpinned.
function PinnedAgents({ pins, styles, navigation }: { pins: readonly PinnedAgent[]; styles: Styles; navigation: Navigation }) {
  const pin = useRpc(pinAgentRpc);
  const unpinning = useTagChange((agentId: string) => pin({ agentId, pinned: false }));
  return (
    <View>
      <SectionHeader label="Pinned" count={pins.length} styles={styles} />
      {pins.map((entry) => (
        <AgentLine
          key={entry.agentId}
          agent={entry}
          when={ago(entry.pinnedAt)}
          trailing={<IconButton icon={ICONS.unpin} label={`Unpin ${entry.title ?? entry.agentId}`} onPress={() => unpinning.mutate(entry.agentId)} disabled={unpinning.isPending} styles={styles} />}
          styles={styles}
          navigation={navigation}
        />
      ))}
    </View>
  );
}

function LinkRow({ link, tag, styles }: { link: LinkMember; tag: TagSummary; styles: Styles }) {
  const remove = useRpc(removeLinkRpc);
  const removal = useTagChange(() => remove({ tag: tag.name, url: link.url }));
  return (
    <ListRow
      title={link.title}
      meta={shortenLink(link.url)}
      icon={ICONS.link}
      onPress={() => void openExternalUrl(link.url)}
      accessibilityLabel={`Open ${link.title}`}
      trailing={<IconButton icon={ICONS.close} label={`Remove link ${link.title} from ${tag.name}`} onPress={() => removal.mutate(undefined)} disabled={removal.isPending} styles={styles} />}
      styles={styles}
    />
  );
}

// A fetched item: pressing reads its stored copy (or why it failed); Refresh or Retry and Remove sit beside it.
function NoteRow({ note, tag, styles, onRead }: { note: NoteMember; tag: TagSummary; styles: Styles; onRead(): void }) {
  const refresh = useRpc(refreshNoteRpc);
  const remove = useRpc(removeNoteRpc);
  const refreshing = useTagChange(() => refresh({ tag: tag.name, noteId: note.id }));
  const removal = useTagChange(() => remove({ tag: tag.name, noteId: note.id }));
  const by = note.provider ? FETCH_PROVIDER_LABELS[note.provider] : null;
  const source = `${VENDOR_LABELS[note.vendor]}${note.ref === note.title ? "" : ` ${note.ref}`}`;
  const state = note.status === "fetching" ? `fetching${by ? ` with ${by}` : ""}…` : note.status === "failed" ? `failed: ${note.error ?? "unknown reason"}` : [by, note.fetchedAt ? ago(note.fetchedAt) : null].filter(Boolean).join(" · ");
  const again = note.status === "failed" ? "Retry" : "Refresh";
  const trailing = (
    <View style={styles.row}>
      {note.status === "fetching" ? null : <IconButton icon={ICONS.refresh} label={`${again} ${note.title}`} onPress={() => refreshing.mutate(undefined)} disabled={refreshing.isPending} styles={styles} />}
      <IconButton icon={ICONS.close} label={`Remove ${note.title} from ${tag.name}`} onPress={() => removal.mutate(undefined)} disabled={removal.isPending} styles={styles} />
    </View>
  );
  return (
    <ListRow
      title={note.title}
      meta={`${source} · ${state}`}
      icon={note.status === "failed" ? ICONS.failed : VENDOR_ICONS[note.vendor]}
      danger={note.status === "failed"}
      onPress={note.status === "fetching" ? undefined : onRead}
      accessibilityLabel={`Read ${note.title}`}
      trailing={trailing}
      styles={styles}
    />
  );
}

// A fetched item's stored copy, as the tag attachment will carry it; a failed one shows why.
function NoteReader({ note, styles, onClose }: { note: NoteMember; styles: Styles; onClose(): void }) {
  const toast = useToast();
  const by = note.provider ? ` by ${FETCH_PROVIDER_LABELS[note.provider]}` : "";
  const url = note.url;
  return (
    <ReaderSheet
      title={note.title}
      text={note.text}
      meta={`${VENDOR_LABELS[note.vendor]} · fetched${by} ${note.fetchedAt ? ago(note.fetchedAt) : ""} · ${plural(note.text.length, "character")}`}
      error={note.status === "failed" ? `Could not fetch ${VENDOR_LABELS[note.vendor]} ${note.ref}: ${note.error ?? "unknown reason"}` : undefined}
      onOpen={url ? () => void openExternalUrl(url).catch((error: unknown) => toast.error(errorText(error))) : undefined}
      onClose={onClose}
      styles={styles}
    />
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
    <View style={{ gap: 8 }}>
      <TextInput style={[styles.input, FULL_WIDTH_FIELD]} value={url} onChangeText={setUrl} placeholder="https://..." autoCapitalize="none" autoCorrect={false} accessibilityLabel="Link URL" />
      <TextInput style={[styles.input, FULL_WIDTH_FIELD]} value={title} onChangeText={setTitle} placeholder="Title (optional)" accessibilityLabel="Link title" onSubmitEditing={() => adding.mutate(undefined)} />
      <View style={styles.row}>
        <Button label="Add link" kind="primary" styles={styles} onPress={() => adding.mutate(undefined)} disabled={adding.isPending || url.trim() === ""} />
        <Button label="Cancel" styles={styles} onPress={onClose} />
      </View>
    </View>
  );
}

// Exactly what Attach > Tag would send, so it can be read (and copied) before sending.
function PreviewSheet({ tag, styles, onClose }: { tag: TagSummary; styles: Styles; onClose(): void }) {
  const preview = useRpc(previewTagRpc);
  const query = useQuery({ queryKey: ["contextualise", "preview", tag.key], queryFn: () => preview({ tag: tag.name }), staleTime: 0 });
  return (
    <ReaderSheet
      title={`What Attach > Tag sends for "${tag.name}"`}
      text={query.data?.text}
      meta={query.data ? `${query.data.subtitle} · ${plural(query.data.text.length, "character")}` : undefined}
      error={query.error ? errorText(query.error) : undefined}
      onClose={onClose}
      styles={styles}
    />
  );
}

function TagDetail({ tag, styles, navigation, onBack, onRead }: { tag: TagSummary; styles: Styles; navigation: Navigation; onBack?(): void; onRead(noteId: string): void }) {
  // One form at a time, so the detail never shows two primary buttons.
  const [form, setForm] = useState<"fetch" | "link" | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const close = () => setForm(null);
  return (
    <View style={{ gap: 8 }}>
      {onBack ? <ListRow title="Tags" icon={ICONS.back} onPress={onBack} accessibilityLabel="Back to tags" styles={styles} /> : null}
      <View style={{ gap: 4 }}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {tag.name}
        </Text>
        <Text style={styles.note} numberOfLines={1}>
          {tagMeta(tag)}
        </Text>
      </View>
      <View style={styles.wrap}>
        <Button label="Preview" styles={styles} onPress={() => setPreviewing(true)} />
        <Button label="Fetch item" icon={ICONS.fetch} styles={styles} onPress={() => setForm("fetch")} disabled={form === "fetch"} />
        <Button label="Add link" icon={ICONS.link} styles={styles} onPress={() => setForm("link")} disabled={form === "link"} />
      </View>
      {form === "fetch" ? <FetchForm tagNames={[tag.name]} styles={styles} onDone={close} onCancel={close} /> : null}
      {form === "link" ? <AddLinkForm tagName={tag.name} styles={styles} onClose={close} /> : null}
      {tag.notes.length > 0 ? (
        <View>
          <SectionHeader label="Fetched items" styles={styles} />
          {tag.notes.map((note) => (
            <NoteRow key={note.id} note={note} tag={tag} styles={styles} onRead={() => onRead(note.id)} />
          ))}
        </View>
      ) : null}
      {tag.agents.length > 0 ? (
        <View>
          <SectionHeader label="Agents" styles={styles} />
          {tag.agents.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} tag={tag} styles={styles} navigation={navigation} />
          ))}
        </View>
      ) : null}
      {tag.links.length > 0 ? (
        <View>
          <SectionHeader label="Links" styles={styles} />
          {tag.links.map((link) => (
            <LinkRow key={link.url} link={link} tag={tag} styles={styles} />
          ))}
        </View>
      ) : null}
      {tag.workspaces.length > 0 || !tag.hasWorkspaceLabel ? (
        <View>
          <SectionHeader label="Workspaces" styles={styles} />
          {tag.workspaces.map((workspace) => (
            <ListRow
              key={workspace.workspaceId}
              title={workspace.projectName === workspace.name ? workspace.name : `${workspace.projectName} / ${workspace.name}`}
              meta={workspace.directory}
              icon={ICONS.workspace}
              onPress={navigation ? () => navigation.openWorkspace({ workspaceId: workspace.workspaceId }) : undefined}
              accessibilityLabel={`Open workspace ${workspace.name}`}
              styles={styles}
            />
          ))}
          {/* Workspaces join a tag by Paseo label; this is the one place that says so. */}
          {tag.hasWorkspaceLabel ? null : <Text style={[styles.note, { paddingHorizontal: 12 }]}>Label a workspace "{tag.name}" in Paseo to include it.</Text>}
        </View>
      ) : null}
      {previewing ? <PreviewSheet tag={tag} styles={styles} onClose={() => setPreviewing(false)} /> : null}
    </View>
  );
}

export function TagsScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const list = useRpc(listTagsRpc);
  const queryClient = useQueryClient();
  // The list reloads while the screen is open, so agents' states stay current, and faster while a
  // fetch is running so its result shows up on its own.
  const tags = useQuery({
    queryKey: TAGS_QUERY,
    queryFn: () => list({}),
    refetchInterval: (query) => (query.state.data?.tags.some((tag) => tag.notes.some((note) => note.status === "fetching")) ? 3_000 : LIVE_REFRESH_MS),
  });
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [firstFetch, setFirstFetch] = useState(false);
  // Selection is local state, so it works whether or not Paseo pushes a route when params change.
  const [chosen, setChosen] = useState<string | null>(params.tag ? tagKey(params.tag) : null);
  useEffect(() => setChosen(params.tag ? tagKey(params.tag) : null), [params.tag]);
  // Opened from a fetch result's Read: that tag is selected and the item's reader is shown.
  const [readingId, setReadingId] = useState<string | null>(params.note ?? null);
  useEffect(() => setReadingId(params.note ?? null), [params.note]);
  useEffect(() => onTagsChanged(() => void queryClient.invalidateQueries({ queryKey: TAGS_QUERY })), [queryClient]);
  const all = tags.data?.tags ?? [];
  const shown = sortTags(filterTags(all, filter), sort);
  const selected = selectedTag(all, shown, chosen, layout.compact);
  const reading = readingId ? all.flatMap((tag) => tag.notes).find((note) => note.id === readingId) : undefined;
  const pins = tags.data?.pinnedAgents ?? [];

  const editor = params.agentId ? (
    <View>
      <SectionHeader label="This agent" styles={styles} />
      <AgentTags agentId={params.agentId} fallbackWorkspaceId={params.workspaceId} styles={styles} />
    </View>
  ) : null;
  const pinned = pins.length > 0 ? <PinnedAgents pins={pins} styles={styles} navigation={navigation} /> : null;
  const reader = reading && reading.status !== "fetching" ? <NoteReader note={reading} styles={styles} onClose={() => setReadingId(null)} /> : null;
  const lost = readingId && tags.data && !reading ? <Text style={styles.muted}>That fetched item is no longer in any tag.</Text> : null;

  const state = tags.isPending ? (
    <StateView state="loading" styles={styles} />
  ) : tags.error ? (
    <StateView state="error" text={`Could not load tags: ${errorText(tags.error)}`} styles={styles} />
  ) : all.length === 0 ? (
    firstFetch ? (
      <FetchForm tagNames={[]} styles={styles} onDone={() => setFirstFetch(false)} onCancel={() => setFirstFetch(false)} />
    ) : (
      <StateView state="empty" text="No tags yet. Tag an agent with the Tags button in its message box." actions={[{ label: "Fetch an item", icon: ICONS.fetch, onPress: () => setFirstFetch(true) }]} styles={styles} />
    )
  ) : null;
  if (state)
    return (
      <Page styles={styles}>
        {editor}
        {pinned}
        {state}
      </Page>
    );

  const tagList = (
    <>
      {editor}
      <SearchField value={filter} onChange={setFilter} placeholder={filterPlaceholder(all)} label="Filter tags" styles={styles} />
      {all.length > 1 ? <Segmented<Sort> options={SORT_OPTIONS} value={sort} onChange={setSort} label="Sort tags" styles={styles} /> : null}
      {pinned}
      <View>
        <SectionHeader label="Tags" count={all.length} styles={styles} />
        {shown.length === 0 ? <Text style={[styles.muted, { paddingHorizontal: 12 }]}>No tag matches "{filter}".</Text> : null}
        {shown.map((tag) => (
          <ListRow key={tag.key} title={tag.name} meta={tagMeta(tag)} selected={!layout.compact && tag.key === selected?.key} onPress={() => setChosen(tag.key)} accessibilityLabel={`Open tag ${tag.name}`} styles={styles} />
        ))}
      </View>
    </>
  );

  // A phone shows the list or one tag; a wider window shows both, side by side.
  if (layout.compact)
    return (
      <Page styles={styles}>
        {lost}
        {selected ? <TagDetail key={selected.key} tag={selected} styles={styles} navigation={navigation} onBack={() => setChosen(null)} onRead={setReadingId} /> : tagList}
        {reader}
      </Page>
    );
  return (
    <View style={[styles.screen, { flexDirection: "row" }]}>
      <ScrollView style={{ width: LIST_PANE_WIDTH, flexGrow: 0, flexShrink: 0, borderRightWidth: 1, borderColor: styles.colors.border }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {tagList}
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {lost}
        {selected ? <TagDetail key={selected.key} tag={selected} styles={styles} navigation={navigation} onRead={setReadingId} /> : null}
      </ScrollView>
      {reader}
    </View>
  );
}
