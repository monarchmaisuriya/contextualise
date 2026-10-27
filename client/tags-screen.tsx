import { openExternalUrl, type PluginScreenProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  addLinkRpc,
  type AgentMember,
  FETCH_PROVIDER_LABELS,
  type LinkMember,
  listTagsRpc,
  type NoteMember,
  previewTagRpc,
  refreshNoteRpc,
  removeLinkRpc,
  removeNoteRpc,
  removeTagRpc,
  type TagSummary,
  VENDOR_LABELS,
} from "../shared/contracts";
import { AgentTags } from "./agent-tags";
import { errorText } from "./errors";
import { FetchForm } from "./fetch-form";
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
            {note.url ? <Button label="Open" styles={styles} onPress={() => void openExternalUrl(note.url ?? "").catch((error: unknown) => toast.error(errorText(error)))} /> : null}
            <Button label="Copy" styles={styles} onPress={() => void copyText(note.text).then(() => toast.show("Copied", { variant: "success" }), (error: unknown) => toast.error(errorText(error)))} />
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
      <Pressable style={styles.grow} disabled={note.status !== "ready"} onPress={() => setReading(true)} accessibilityRole={note.status === "ready" ? "button" : undefined} accessibilityLabel={`Read ${note.title}`}>
        <Text style={note.status === "ready" ? styles.text : styles.muted} numberOfLines={1}>
          {note.title}
        </Text>
        <Text style={note.status === "failed" ? styles.danger : styles.muted} numberOfLines={2}>
          {VENDOR_LABELS[note.vendor]} {note.ref === note.title ? "" : `${note.ref} `}· {state}
        </Text>
      </Pressable>
      {note.status === "fetching" ? null : (
        <Pressable onPress={() => refreshing.mutate(undefined)} disabled={refreshing.isPending} accessibilityRole="button" accessibilityLabel={`Fetch ${note.title} again`}>
          <Text style={styles.link}>{note.status === "failed" ? "Retry" : "Refresh"}</Text>
        </Pressable>
      )}
      <Pressable onPress={() => removal.mutate(undefined)} disabled={removal.isPending} accessibilityRole="button" accessibilityLabel={`Remove ${note.title} from ${tag.name}`}>
        <Text style={styles.danger}>{removal.isPending ? "Removing" : "Remove"}</Text>
      </Pressable>
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

function TagCard({ tag, styles, navigation, open, onToggle }: { tag: TagSummary; styles: Styles; navigation: Navigation; open: boolean; onToggle(): void }) {
  const [linking, setLinking] = useState(false);
  const [fetchingOpen, setFetchingOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const pending = tag.notes.filter((note) => note.status === "fetching").length;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Pressable style={styles.grow} onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? "Collapse" : "Expand"} ${tag.name}`}>
          <Text style={styles.title}>
            {open ? "▾" : "▸"} {tag.name}
          </Text>
          <Text style={styles.muted}>
            {summary(tag) || "empty"}
            {pending > 0 ? ` · ${pending} fetching` : ""}
          </Text>
        </Pressable>
        <Button label="Preview" styles={styles} onPress={() => setPreviewing(true)} />
      </View>
      {open ? (
        <>
          <View style={styles.wrap}>
            <Button label={fetchingOpen ? "Close fetch" : "Fetch item"} styles={styles} onPress={() => setFetchingOpen((value) => !value)} />
            <Button label={linking ? "Close link" : "Add link"} styles={styles} onPress={() => setLinking((value) => !value)} />
          </View>
          {fetchingOpen ? <FetchForm tagNames={[tag.name]} styles={styles} onDone={() => setFetchingOpen(false)} /> : null}
          {linking ? <AddLinkForm tagName={tag.name} styles={styles} onClose={() => setLinking(false)} /> : null}
          {!tag.hasWorkspaceLabel && tag.agents.length > 0 ? (
            <Text style={styles.muted}>No workspace has this label. Add the label "{tag.name}" to a workspace in Paseo to include it; if you renamed a label, tag these again under the new name.</Text>
          ) : null}
          {tag.notes.length > 0 ? <Text style={styles.section}>Fetched items</Text> : null}
          {tag.notes.map((note) => (
            <NoteRow key={note.id} note={note} tag={tag} styles={styles} />
          ))}
          {tag.agents.length > 0 ? <Text style={styles.section}>Agents</Text> : null}
          {tag.agents.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} tag={tag} styles={styles} navigation={navigation} />
          ))}
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
          {tag.links.length > 0 ? <Text style={styles.section}>Links</Text> : null}
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
  const isOpen = (key: string) => toggled[key] ?? openByDefault;
  const totals = {
    agents: new Set(all.flatMap((tag) => tag.agents.map((agent) => agent.agentId))).size,
    items: all.reduce((sum, tag) => sum + tag.notes.length, 0),
    fetching: all.reduce((sum, tag) => sum + tag.notes.filter((note) => note.status === "fetching").length, 0),
  };
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {params.agentId ? <AgentTags agentId={params.agentId} fallbackWorkspaceId={params.workspaceId} styles={styles} /> : null}
      {all.length > 0 ? (
        <Text style={styles.muted}>
          {plural(all.length, "tag")} · {plural(totals.agents, "agent")} tagged · {plural(totals.items, "fetched item")}
          {totals.fetching > 0 ? ` (${totals.fetching} fetching)` : ""}
        </Text>
      ) : null}
      <TextInput style={styles.input} value={filter} onChangeText={setFilter} placeholder="Filter tags, agents, links, and items" accessibilityLabel="Filter tags" />
      {all.length > 1 ? (
        <View style={styles.wrap}>
          <Text style={styles.muted}>Sort:</Text>
          {SORTS.map((option) => (
            <Pressable key={option.value} style={option.value === sort ? styles.chipOn : styles.chip} onPress={() => setSort(option.value)} accessibilityRole="button" accessibilityLabel={`Sort by ${option.label}`}>
              <Text style={option.value === sort ? styles.chipOnText : styles.chipText}>{option.label}</Text>
            </Pressable>
          ))}
          <Pressable style={styles.chip} onPress={() => setToggled(Object.fromEntries(shown.map((tag) => [tag.key, true])))} accessibilityRole="button" accessibilityLabel="Expand all tags">
            <Text style={styles.chipText}>Expand all</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => setToggled(Object.fromEntries(shown.map((tag) => [tag.key, false])))} accessibilityRole="button" accessibilityLabel="Collapse all tags">
            <Text style={styles.chipText}>Collapse all</Text>
          </Pressable>
        </View>
      ) : null}
      {tags.isPending ? <Text style={styles.muted}>Loading tags</Text> : null}
      {tags.error ? <Text style={styles.danger}>Could not load tags: {errorText(tags.error)}</Text> : null}
      {tags.data && tags.data.tags.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>No tags yet</Text>
          <Text style={styles.text}>In any agent, press the Tags pill next to the message box, or type /tag auth-rewrite (and /untag to remove it).</Text>
          <Text style={styles.text}>Workspaces you label in Paseo join the tag with the same name.</Text>
          <Text style={styles.text}>Add a web link with /tag-link https://example.com/spec auth-rewrite.</Text>
          <Text style={styles.text}>Pull in a Jira, Sentry, Slack, or Notion item with /tag-fetch PROJ-123 auth-rewrite.</Text>
          <Text style={styles.text}>Then, in any prompt, Attach &gt; Tag sends everything under it.</Text>
        </View>
      ) : null}
      {all.length > 0 && shown.length === 0 ? <Text style={styles.muted}>No tag matches "{filter}".</Text> : null}
      {shown.map((tag) => (
        <TagCard key={tag.key} tag={tag} styles={styles} navigation={navigation} open={isOpen(tag.key)} onToggle={() => setToggled((current) => ({ ...current, [tag.key]: !isOpen(tag.key) }))} />
      ))}
    </ScrollView>
  );
}
