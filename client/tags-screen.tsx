import { openExternalUrl, type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, Markdown, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
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
import { AgentTags } from "./agent-tags";
import { errorText } from "./errors";
import { FetchForm } from "./fetch-form";
import { ICONS, VENDOR_ICONS } from "./icons";
import { ago, Button, Chip, IconButton, NoteStatusIcon, plural, SectionTitle, type Styles, summary, TAGS_QUERY, useStyles, useTagChange } from "./kit";
import { onTagsChanged } from "./tag-events";

type Navigation = PluginScreenProps["navigation"];

// One agent: opens it when tapped (unless Paseo no longer has it), with `action` at the end.
function AgentLine({ agent, when, action, styles, navigation }: { agent: AgentMember | PinnedAgent; when: string; action: ReactNode; styles: Styles; navigation: Navigation }) {
  const open = navigation && agent.state !== "missing" ? () => navigation.openAgent({ agentId: agent.agentId }) : undefined;
  const state = agent.state === "missing" ? "missing: Paseo no longer has this agent" : agent.state === "archived" ? "archived" : null;
  return (
    <View style={styles.row}>
      <Icon name={agent.state === "archived" ? ICONS.archived : ICONS.agent} size={16} color={agent.state === "missing" ? styles.colors.statusDanger : styles.colors.foregroundMuted} />
      <Pressable style={styles.grow} disabled={!open} onPress={open} accessibilityRole={open ? "link" : undefined} accessibilityLabel={`Open agent ${agent.title ?? agent.agentId}`}>
        <Text style={styles.text} numberOfLines={1}>
          {agent.title ?? agent.agentId}
        </Text>
        <Text style={agent.state === "missing" ? styles.danger : styles.muted} numberOfLines={1}>
          {[agent.provider ?? "unknown provider", agent.workspaceName, state, when].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      {action}
    </View>
  );
}

function AgentRow({ agent, tag, styles, navigation }: { agent: AgentMember; tag: TagSummary; styles: Styles; navigation: Navigation }) {
  const remove = useRpc(removeTagRpc);
  const removal = useTagChange(() => remove({ tags: [tag.name], agentId: agent.agentId }));
  const action = <IconButton icon={ICONS.remove} tone="danger" label={`Remove ${agent.title ?? agent.agentId} from ${tag.name}`} onPress={() => removal.mutate(undefined)} disabled={removal.isPending} styles={styles} />;
  return <AgentLine agent={agent} when={`tagged ${ago(agent.taggedAt)}`} action={action} styles={styles} navigation={navigation} />;
}

// Pinned agents come first in Attach > Agent conversation. One Paseo no longer has stays until unpinned.
function PinnedAgents({ pins, styles, navigation }: { pins: readonly PinnedAgent[]; styles: Styles; navigation: Navigation }) {
  const pin = useRpc(pinAgentRpc);
  const unpinning = useTagChange((agentId: string) => pin({ agentId, pinned: false }));
  return (
    <View style={styles.card}>
      <SectionTitle icon={ICONS.pin} label="Pinned agents, first in Attach > Agent conversation" count={pins.length} styles={styles} />
      {pins.map((entry) => (
        <AgentLine
          key={entry.agentId}
          agent={entry}
          when={`pinned ${ago(entry.pinnedAt)}`}
          action={<IconButton icon={ICONS.unpin} label={`Unpin ${entry.title ?? entry.agentId}`} onPress={() => unpinning.mutate(entry.agentId)} disabled={unpinning.isPending} styles={styles} />}
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
    <View style={styles.row}>
      <Icon name={ICONS.link} size={16} color={styles.colors.foregroundMuted} />
      <Pressable style={styles.grow} onPress={() => void openExternalUrl(link.url)} accessibilityRole="link" accessibilityLabel={`Open ${link.title}`}>
        <Text style={styles.text} numberOfLines={1}>
          {link.title}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {link.url}
        </Text>
      </Pressable>
      <IconButton icon={ICONS.remove} tone="danger" label={`Remove link ${link.title} from ${tag.name}`} onPress={() => removal.mutate(undefined)} disabled={removal.isPending} styles={styles} />
    </View>
  );
}

// A fetched item's stored copy, as the tag attachment will carry it.
function NoteReader({ note, styles, onClose }: { note: NoteMember; styles: Styles; onClose(): void }) {
  const toast = useToast();
  const by = note.provider ? ` by ${FETCH_PROVIDER_LABELS[note.provider]}` : "";
  return (
    <Modal title={note.title} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <View style={{ gap: 12 }}>
          <View style={styles.row}>
            <Text style={[styles.muted, styles.grow]}>
              {VENDOR_LABELS[note.vendor]} · fetched{by} {note.fetchedAt ? ago(note.fetchedAt) : ""} · {plural(note.text.length, "character")}
            </Text>
            {note.url ? <Button label="Open" icon={ICONS.open} styles={styles} onPress={() => void openExternalUrl(note.url ?? "").catch((error: unknown) => toast.error(errorText(error)))} /> : null}
            <Button label="Copy" icon={ICONS.copy} styles={styles} onPress={() => void copyText(note.text).then(() => toast.show("Copied", { variant: "success" }), (error: unknown) => toast.error(errorText(error)))} />
          </View>
          <Markdown>{note.text}</Markdown>
        </View>
      </Modal.Content>
    </Modal>
  );
}

function NoteRow({ note, tag, styles }: { note: NoteMember; tag: TagSummary; styles: Styles }) {
  const refresh = useRpc(refreshNoteRpc);
  const remove = useRpc(removeNoteRpc);
  const [reading, setReading] = useState(false);
  const refreshing = useTagChange(() => refresh({ tag: tag.name, noteId: note.id }));
  const removal = useTagChange(() => remove({ tag: tag.name, noteId: note.id }));
  const by = note.provider ? ` with ${FETCH_PROVIDER_LABELS[note.provider]}` : "";
  const state =
    note.status === "fetching" ? `fetching${by}…` : note.status === "failed" ? `failed: ${note.error ?? "unknown reason"}` : `fetched${by} ${note.fetchedAt ? ago(note.fetchedAt) : ""}`;
  return (
    <View style={styles.row}>
      <Icon name={VENDOR_ICONS[note.vendor]} size={16} color={styles.colors.foregroundMuted} />
      <Pressable style={styles.grow} disabled={note.status !== "ready"} onPress={() => setReading(true)} accessibilityRole={note.status === "ready" ? "button" : undefined} accessibilityLabel={`Read ${note.title}`}>
        <Text style={note.status === "ready" ? styles.text : styles.muted} numberOfLines={1}>
          {note.title}
        </Text>
        <View style={styles.inline}>
          <NoteStatusIcon status={note.status} styles={styles} />
          <Text style={[note.status === "failed" ? styles.danger : styles.muted, styles.grow]} numberOfLines={2}>
            {VENDOR_LABELS[note.vendor]} {note.ref === note.title ? "" : `${note.ref} `}· {state}
          </Text>
        </View>
      </Pressable>
      {note.status === "ready" ? <IconButton icon={ICONS.preview} tone="accent" label={`Read ${note.title}`} onPress={() => setReading(true)} styles={styles} /> : null}
      {note.status === "fetching" ? null : (
        <IconButton icon={ICONS.refresh} label={note.status === "failed" ? `Retry fetching ${note.title}` : `Fetch ${note.title} again`} onPress={() => refreshing.mutate(undefined)} disabled={refreshing.isPending} styles={styles} />
      )}
      <IconButton icon={ICONS.remove} tone="danger" label={`Remove ${note.title} from ${tag.name}`} onPress={() => removal.mutate(undefined)} disabled={removal.isPending} styles={styles} />
      {reading ? <NoteReader note={note} styles={styles} onClose={() => setReading(false)} /> : null}
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
      <Button label="Add link" icon={ICONS.add} kind="primary" styles={styles} onPress={() => adding.mutate(undefined)} disabled={adding.isPending || url.trim() === ""} />
      <Button label="Cancel" icon={ICONS.close} styles={styles} onPress={onClose} />
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
                icon={ICONS.copy}
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

function TagCard({ tag, styles, navigation, open, onToggle }: { tag: TagSummary; styles: Styles; navigation: Navigation; open: boolean; onToggle(): void }) {
  const [linking, setLinking] = useState(false);
  const [fetchingOpen, setFetchingOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const pending = tag.notes.filter((note) => note.status === "fetching").length;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Pressable style={[styles.grow, styles.inline, { gap: 10 }]} onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? "Collapse" : "Expand"} ${tag.name}`}>
          <Icon name={open ? ICONS.expanded : ICONS.collapsed} size={16} color={styles.colors.foregroundMuted} />
          <Icon name={ICONS.tag} size={16} color={styles.colors.accent} />
          <View style={styles.grow}>
            <Text style={styles.title} numberOfLines={1}>
              {tag.name}
            </Text>
            <Text style={styles.muted} numberOfLines={1}>
              {summary(tag) || "empty"}
              {pending > 0 ? ` · ${pending} fetching` : ""}
            </Text>
          </View>
        </Pressable>
        <Button label="Preview" icon={ICONS.preview} styles={styles} onPress={() => setPreviewing(true)} />
      </View>
      {open ? (
        <>
          <View style={styles.wrap}>
            <Button label={fetchingOpen ? "Close fetch" : "Fetch item"} icon={fetchingOpen ? ICONS.close : ICONS.fetch} styles={styles} onPress={() => setFetchingOpen((value) => !value)} />
            <Button label={linking ? "Close link" : "Add link"} icon={linking ? ICONS.close : ICONS.link} styles={styles} onPress={() => setLinking((value) => !value)} />
          </View>
          {fetchingOpen ? <FetchForm tagNames={[tag.name]} styles={styles} onDone={() => setFetchingOpen(false)} /> : null}
          {linking ? <AddLinkForm tagName={tag.name} styles={styles} onClose={() => setLinking(false)} /> : null}
          {!tag.hasWorkspaceLabel && tag.agents.length > 0 ? (
            <Text style={styles.muted}>No workspace has this label. Add the label "{tag.name}" to a workspace in Paseo to include it; if you renamed a label, tag these again under the new name.</Text>
          ) : null}
          {tag.notes.length > 0 ? <SectionTitle icon={ICONS.item} label="Fetched items" count={tag.notes.length} styles={styles} /> : null}
          {tag.notes.map((note) => (
            <NoteRow key={note.id} note={note} tag={tag} styles={styles} />
          ))}
          {tag.agents.length > 0 ? <SectionTitle icon={ICONS.agent} label="Agents" count={tag.agents.length} styles={styles} /> : null}
          {tag.agents.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} tag={tag} styles={styles} navigation={navigation} />
          ))}
          {tag.workspaces.length > 0 ? <SectionTitle icon={ICONS.workspace} label="Workspaces (Paseo label)" count={tag.workspaces.length} styles={styles} /> : null}
          {tag.workspaces.map((workspace) => (
            <Pressable
              key={workspace.workspaceId}
              style={styles.row}
              disabled={!navigation}
              onPress={() => navigation?.openWorkspace({ workspaceId: workspace.workspaceId })}
              accessibilityRole="link"
              accessibilityLabel={`Open workspace ${workspace.name}`}
            >
              <Icon name={ICONS.workspace} size={16} color={styles.colors.foregroundMuted} />
              <View style={styles.grow}>
                <Text style={styles.text} numberOfLines={1}>
                  {workspace.projectName} / {workspace.name}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {workspace.directory}
                </Text>
              </View>
            </Pressable>
          ))}
          {tag.links.length > 0 ? <SectionTitle icon={ICONS.link} label="Links" count={tag.links.length} styles={styles} /> : null}
          {tag.links.map((link) => (
            <LinkRow key={link.url} link={link} tag={tag} styles={styles} />
          ))}
        </>
      ) : null}
      {previewing ? <PreviewModal tag={tag} styles={styles} onClose={() => setPreviewing(false)} /> : null}
    </View>
  );
}

type Sort = "recent" | "name" | "size";
const SORTS: ReadonlyArray<{ value: Sort; label: string }> = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "size", label: "Size" },
];
const size = (tag: TagSummary) => tag.agents.length + tag.workspaces.length + tag.links.length + tag.notes.length;

export function TagsScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const list = useRpc(listTagsRpc);
  const queryClient = useQueryClient();
  // While a fetch is running, the list reloads every few seconds so its result shows up on its own.
  const tags = useQuery({
    queryKey: TAGS_QUERY,
    queryFn: () => list({}),
    refetchInterval: (query) => (query.state.data?.tags.some((tag) => tag.notes.some((note) => note.status === "fetching")) ? 3_000 : false),
  });
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  // Cards the user opened or closed; the rest follow the default (open when few tags are shown).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [firstFetch, setFirstFetch] = useState(false);
  // Opened from a fetch result's Read: that tag's card is open and the item's reader is shown.
  const [readingId, setReadingId] = useState<string | null>(params.note ?? null);
  useEffect(() => setReadingId(params.note ?? null), [params.note]);
  const focusKey = params.tag ? tagKey(params.tag) : null;
  useEffect(() => onTagsChanged(() => void queryClient.invalidateQueries({ queryKey: TAGS_QUERY })), [queryClient]);
  const all = tags.data?.tags ?? [];
  const wanted = filter.trim().toLowerCase();
  const matching = all.filter(
    (tag) =>
      wanted === "" ||
      [tag.name, ...tag.agents.map((agent) => agent.title ?? ""), ...tag.links.map((link) => link.title), ...tag.notes.map((note) => `${note.title} ${note.ref}`)].some((text) => text.toLowerCase().includes(wanted)),
  );
  const shown = sort === "recent" ? matching : [...matching].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : size(b) - size(a) || a.name.localeCompare(b.name)));
  const openByDefault = shown.length <= 3 || wanted !== "";
  const isOpen = (key: string) => toggled[key] ?? (openByDefault || key === focusKey);
  const reading = readingId ? all.flatMap((tag) => tag.notes).find((note) => note.id === readingId) : undefined;
  const totals = {
    agents: new Set(all.flatMap((tag) => tag.agents.map((agent) => agent.agentId))).size,
    items: all.reduce((sum, tag) => sum + tag.notes.length, 0),
    fetching: all.reduce((sum, tag) => sum + tag.notes.filter((note) => note.status === "fetching").length, 0),
  };
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {params.agentId ? <AgentTags agentId={params.agentId} fallbackWorkspaceId={params.workspaceId} styles={styles} /> : null}
      {tags.data && tags.data.pinnedAgents.length > 0 ? <PinnedAgents pins={tags.data.pinnedAgents} styles={styles} navigation={navigation} /> : null}
      {all.length > 0 ? (
        <View style={styles.wrap}>
          {[
            [ICONS.tags, plural(all.length, "tag")],
            [ICONS.agent, `${plural(totals.agents, "agent")} tagged`],
            [ICONS.item, plural(totals.items, "fetched item")],
            ...(totals.fetching > 0 ? [[ICONS.fetching, `${totals.fetching} fetching`]] : []),
          ].map(([icon, text]) => (
            <View key={text} style={[styles.inline, { marginRight: 10 }]}>
              <Icon name={icon} size={14} color={styles.colors.foregroundMuted} />
              <Text style={styles.muted}>{text}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={[styles.inline, styles.input, { flex: 0 }]}>
        <Icon name={ICONS.search} size={16} color={styles.colors.foregroundMuted} />
        <TextInput style={[styles.grow, { color: styles.colors.foreground }]} value={filter} onChangeText={setFilter} placeholder="Filter tags, agents, links, and items" accessibilityLabel="Filter tags" />
        {filter !== "" ? <IconButton icon={ICONS.close} label="Clear filter" onPress={() => setFilter("")} styles={styles} /> : null}
      </View>
      {all.length > 1 ? (
        <View style={styles.wrap}>
          <Icon name={ICONS.sort} size={14} color={styles.colors.foregroundMuted} />
          {SORTS.map((option) => (
            <Chip key={option.value} label={option.label} on={option.value === sort} onPress={() => setSort(option.value)} accessibilityLabel={`Sort by ${option.label}`} styles={styles} />
          ))}
          <Chip label="Expand all" icon={ICONS.expandAll} onPress={() => setToggled(Object.fromEntries(shown.map((tag) => [tag.key, true])))} styles={styles} />
          <Chip label="Collapse all" icon={ICONS.collapseAll} onPress={() => setToggled(Object.fromEntries(shown.map((tag) => [tag.key, false])))} styles={styles} />
        </View>
      ) : null}
      {tags.isPending ? <Text style={styles.muted}>Loading tags</Text> : null}
      {tags.error ? <Text style={styles.danger}>Could not load tags: {errorText(tags.error)}</Text> : null}
      {tags.data && tags.data.tags.length === 0 ? (
        <View style={styles.card}>
          <View style={styles.inline}>
            <Icon name={ICONS.empty} size={20} color={styles.colors.foregroundMuted} />
            <Text style={styles.title}>No tags yet</Text>
          </View>
          <Text style={styles.text}>In any agent, press the Tags pill next to the message box, or type /tag auth-rewrite (and /untag to remove it).</Text>
          <Text style={styles.text}>Workspaces you label in Paseo join the tag with the same name.</Text>
          <Text style={styles.text}>Add a web link with /tag-link https://example.com/spec auth-rewrite.</Text>
          <Text style={styles.text}>Pull in a Jira, Sentry, Slack, or Notion item with /tag-fetch PROJ-123 auth-rewrite.</Text>
          <Text style={styles.text}>Then, in any prompt, Attach &gt; Tag sends everything under it.</Text>
          <View style={styles.wrap}>
            <Button label={firstFetch ? "Close fetch" : "Fetch an item"} icon={firstFetch ? ICONS.close : ICONS.fetch} kind={firstFetch ? "ghost" : "primary"} styles={styles} onPress={() => setFirstFetch((value) => !value)} />
          </View>
          {firstFetch ? <FetchForm tagNames={[]} styles={styles} onDone={() => setFirstFetch(false)} /> : null}
        </View>
      ) : null}
      {all.length > 0 && shown.length === 0 ? <Text style={styles.muted}>No tag matches "{filter}".</Text> : null}
      {readingId && tags.data && !reading ? <Text style={styles.muted}>That fetched item is no longer in any tag.</Text> : null}
      {reading?.status === "ready" ? <NoteReader note={reading} styles={styles} onClose={() => setReadingId(null)} /> : null}
      {shown.map((tag) => (
        <TagCard key={tag.key} tag={tag} styles={styles} navigation={navigation} open={isOpen(tag.key)} onToggle={() => setToggled((current) => ({ ...current, [tag.key]: !isOpen(tag.key) }))} />
      ))}
    </ScrollView>
  );
}
