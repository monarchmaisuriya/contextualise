import { type PluginScreenProps, type PluginWorkspacePanelProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { snapshotSettings } from "../shared/contracts";
import { BRIEF_ID, browseKnowledgeRpc, describeProjectRpc, explainAreaRpc, generateKnowledgeRpc, KIND_LABELS, type KnowledgeKind, listProjectsRpc, listTasksRpc, pinEntryRpc, type Project, projectForWorkspaceRpc, readKnowledgeRpc, reindexRpc, type SearchHit, searchKnowledgeRpc, setProjectEnabledRpc, type TaskSummary } from "../shared/knowledge";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { ago, Button, Chip, CopyButton, IconButton, plural, SearchField, SectionTitle, type Styles, usePagedList, useStyles } from "./kit";
import { useMoreActions } from "./more-actions";
import { AreaList, AreaPage, EntryBody, ProjectOverview, TaskRow } from "./project-map";
import { memoriseNote } from "./memorise-note";

const PROJECTS_QUERY = ["contextualise", "knowledge", "projects"];

function where(hit: Pick<SearchHit, "path" | "line">): string {
  return `${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}`;
}

// One result: its kind, place, and snippet; pressed, it opens the full entry below it.
function HitRow({ hit, repoKey, pinned, onPin, styles }: { hit: SearchHit; repoKey: string; pinned: boolean; onPin(pinned: boolean): void; styles: Styles }) {
  const [open, setOpen] = useState(false);
  const read = useRpc(readKnowledgeRpc);
  const entry = useQuery({ queryKey: ["contextualise", "knowledge", "read", repoKey, hit.id], queryFn: () => read({ repoKey, id: hit.id }), enabled: open });
  return (
    <View style={[styles.card, { gap: 4 }]}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityLabel={`${open ? "Close" : "Open"} ${hit.title}`} style={{ gap: 2 }}>
        <View style={styles.row}>
          <Icon name={open ? ICONS.expanded : ICONS.collapsed} size={14} color={styles.colors.foregroundMuted} />
          <Text style={[styles.text, styles.grow]} numberOfLines={1}>
            {hit.title}
          </Text>
          <Text style={styles.faint}>{KIND_LABELS[hit.kind]}</Text>
          <IconButton icon={pinned ? ICONS.unpin : ICONS.pin} label={`${pinned ? "Unpin" : "Pin"} ${hit.title} ${pinned ? "from" : "to"} the project map`} tone={pinned ? "accent" : "muted"} onPress={() => onPin(!pinned)} styles={styles} />
        </View>
        <Text style={styles.faint} numberOfLines={1}>
          {hit.kind === "task" ? (hit.path ? `changed ${hit.path}` : "task") : where(hit)}
          {hit.needsCheck ? <Text style={styles.warning}> · needs check</Text> : null}
        </Text>
        {!open && hit.snippet ? (
          <Text style={styles.muted} numberOfLines={2}>
            {hit.snippet}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        entry.error ? (
          <Text style={styles.danger}>{errorText(entry.error)}</Text>
        ) : entry.data ? (
          <>
            <EntryBody entry={entry.data} styles={styles} />
            <View style={styles.row}>
              <CopyButton text={entry.data.body} styles={styles} />
            </View>
          </>
        ) : (
          <Text style={styles.muted}>Loading</Text>
        )
      ) : null}
      {hit.relatedMemories.length > 0 ? (
        <Text style={styles.faint} numberOfLines={2}>
          Memorise: {hit.relatedMemories.map((memory) => memory.subject).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

const OVERVIEW_ROWS = 5;
const PAGE = 50;
// Fewer recorded conversations than this, and the screen offers to add the earlier ones.
const FEW_TASKS = 5;
// The kinds of written documents, listed together under Documents.
const DOCUMENT_KINDS = ["architecture", "convention", "adr", "doc"] as const;
type ScreenView = "overview" | "areas" | "documents" | "code" | "tasks";

type PinRow = (hit: SearchHit) => { pinned: boolean; onPin(pinned: boolean): void };

// The views, with what each counts on its tab.
const VIEWS: readonly (readonly [ScreenView, string, (project: Project) => number])[] = [
  ["overview", "Overview", () => 0],
  ["areas", "Areas", () => 0],
  ["documents", "Documents", (project) => DOCUMENT_KINDS.reduce((sum, kind) => sum + project.counts[kind], 0)],
  ["code", "Code", (project) => project.counts.code],
  ["tasks", "Past work", (project) => project.counts.task],
];

// One kind in the overview: its first entries and a way to see all of them.
function KindSection({ repoKey, kind, total, onShowAll, pinRow, styles }: { repoKey: string; kind: (typeof DOCUMENT_KINDS)[number]; total: number; onShowAll(): void; pinRow: PinRow; styles: Styles }) {
  const browse = useRpc(browseKnowledgeRpc);
  const page = useQuery({ queryKey: ["contextualise", "knowledge", "browse", repoKey, kind, "overview"], queryFn: () => browse({ repoKey, kind, limit: OVERVIEW_ROWS, offset: 0 }) });
  return (
    <>
      <View style={styles.row}>
        <SectionTitle label={KIND_LABELS[kind]} count={total} styles={styles} />
        <View style={styles.grow} />
        {total > OVERVIEW_ROWS ? <Button label={`Show all ${total}`} styles={styles} onPress={onShowAll} /> : null}
      </View>
      {page.error ? <Text style={styles.danger}>{errorText(page.error)}</Text> : null}
      {page.data?.hits.map((hit) => <HitRow key={hit.id} hit={hit} repoKey={repoKey} {...pinRow(hit)} styles={styles} />)}
    </>
  );
}

// Every entry of one kind, a page at a time.
function KindList({ repoKey, kind, pinRow, styles }: { repoKey: string; kind: Exclude<KnowledgeKind, "task">; pinRow: PinRow; styles: Styles }) {
  const browse = useRpc(browseKnowledgeRpc);
  const { pages, items: hits, total } = usePagedList(["contextualise", "knowledge", "browse", repoKey, kind], (offset) => browse({ repoKey, kind, limit: PAGE, offset }), (page) => page.hits);
  return (
    <>
      <SectionTitle label={KIND_LABELS[kind]} count={total} hint={hits.length < total ? `showing ${hits.length}` : undefined} styles={styles} />
      {pages.error ? <Text style={styles.danger}>{errorText(pages.error)}</Text> : null}
      {hits.map((hit) => <HitRow key={hit.id} hit={hit} repoKey={repoKey} {...pinRow(hit)} styles={styles} />)}
      {pages.hasNextPage ? <Button label="Show more" styles={styles} disabled={pages.isFetchingNextPage} onPress={() => void pages.fetchNextPage()} /> : null}
    </>
  );
}

// Every recorded conversation, newest first, a page at a time.
function TaskList({ repoKey, styles }: { repoKey: string; styles: Styles }) {
  const listTasks = useRpc(listTasksRpc);
  const { pages, items: tasks, total } = usePagedList(["contextualise", "knowledge", "tasks", repoKey, "all"], (offset) => listTasks({ repoKey, limit: PAGE, offset }), (page) => page.tasks);
  return (
    <>
      <SectionTitle label="Past work" count={total} hint={tasks.length < total ? `showing ${tasks.length}` : undefined} styles={styles} />
      <View style={styles.card}>
        {pages.error ? <Text style={styles.danger}>{errorText(pages.error)}</Text> : null}
        {tasks.length === 0 && !pages.isLoading ? <Text style={styles.muted}>No work recorded yet.</Text> : null}
        {tasks.map((task) => <TaskRow key={task.id} task={task} styles={styles} />)}
      </View>
      {pages.hasNextPage ? <Button label="Show more" styles={styles} disabled={pages.isFetchingNextPage} onPress={() => void pages.fetchNextPage()} /> : null}
    </>
  );
}

// The project last shown on the global screen, so opening it again returns there.
let lastRepoKey: string | null = null;

// Project knowledge for one project: search its docs, ADRs, code, and finished tasks, see what is
// indexed, and re-index it. Agents get the same through their knowledge tools. On the global screen
// the user picks the project; a workspace tab passes its own as `fixedRepoKey`.
export function KnowledgeView({ styles, fixedRepoKey, initialRepoKey }: { styles: Styles; fixedRepoKey?: string; initialRepoKey?: string }) {
  const listProjects = useRpc(listProjectsRpc);
  const projects = useQuery({ queryKey: PROJECTS_QUERY, queryFn: () => listProjects({}), refetchInterval: (query) => {
      const listed = query.state.data?.projects ?? [];
      // Polls while a project is being read or written, and, in a workspace tab, until its project appears.
      const waiting = listed.some((project) => project.indexing || project.generation?.state === "running") || (fixedRepoKey !== undefined && !listed.some((project) => project.repoKey === fixedRepoKey));
      return waiting ? 3_000 : false;
    },
  });
  const [repoKey, setRepoKey] = useState<string | null>(fixedRepoKey ?? initialRepoKey ?? lastRepoKey);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  // The view, an area opened from it, and, under Documents, one kind. Search narrows to the kind.
  const [view, setView] = useState<ScreenView>("overview");
  const [area, setArea] = useState<string | null>(null);
  const [kind, setKind] = useState<KnowledgeKind | null>(null);
  const show = (next: ScreenView) => {
    setView(next);
    setArea(null);
    setKind(next === "code" ? "code" : next === "tasks" ? "task" : null);
  };
  const all = projects.data?.projects ?? [];
  useEffect(() => {
    if (fixedRepoKey) setRepoKey(fixedRepoKey);
    else if (all.length > 0 && !all.some((project) => project.repoKey === repoKey)) setRepoKey(all[0].repoKey);
  }, [all, repoKey, fixedRepoKey]);
  useEffect(() => {
    if (repoKey && !fixedRepoKey) lastRepoKey = repoKey;
  }, [repoKey, fixedRepoKey]);
  useEffect(() => setArea(null), [repoKey]);
  const project = all.find((candidate) => candidate.repoKey === repoKey) ?? null;
  const search = useRpc(searchKnowledgeRpc);
  const hits = useQuery({
    queryKey: ["contextualise", "knowledge", "search", repoKey, query.trim(), kind],
    queryFn: () => search({ repoKey: repoKey ?? "", query: query.trim(), kinds: kind ? [kind] : [], limit: 50 }),
    enabled: repoKey !== null && query.trim() !== "",
  });
  const listTasks = useRpc(listTasksRpc);
  const tasks = useQuery({ queryKey: ["contextualise", "knowledge", "tasks", repoKey], queryFn: () => listTasks({ repoKey: repoKey ?? "", limit: OVERVIEW_ROWS }), enabled: project !== null });
  const reindex = useRpc(reindexRpc);
  const setProjectEnabled = useRpc(setProjectEnabledRpc);
  const generate = useRpc(generateKnowledgeRpc);
  const pin = useRpc(pinEntryRpc);
  const read = useRpc(readKnowledgeRpc);
  // The brief is read like any entry; a project without one answers with an error, shown as nothing.
  const brief = useQuery({ queryKey: ["contextualise", "knowledge", "brief", repoKey], queryFn: () => read({ repoKey: repoKey ?? "", id: BRIEF_ID }), enabled: project !== null, retry: false });
  // Without a written description, the README's opening section stands in.
  const readme = useQuery({ queryKey: ["contextualise", "knowledge", "readme", repoKey], queryFn: () => read({ repoKey: repoKey ?? "", id: "doc:README.md:1" }), enabled: project !== null && brief.isError, retry: false });
  // Writing is offered only once settings are read and summaries are on.
  const settings = useSettings(snapshotSettings);
  const writing = settings.status === "ready" && settings.values.knowledgeGenerate;
  const describe = useRpc(describeProjectRpc);
  const explain = useRpc(explainAreaRpc);
  const queryClient = useQueryClient();
  // A finished background job refreshes what it wrote: the description, area lines, and area pages.
  const finishedAt = project?.generation?.state === "running" ? null : (project?.generation?.at ?? null);
  useEffect(() => {
    if (finishedAt === null || repoKey === null) return;
    void brief.refetch();
    void queryClient.invalidateQueries({ queryKey: ["contextualise", "knowledge", "facts", repoKey] });
    void queryClient.invalidateQueries({ queryKey: ["contextualise", "knowledge", "area", repoKey] });
  }, [finishedAt]);
  const toast = useToast();
  // A project change, then fresh project, task, and brief data; failures as readable toasts.
  const change = (work: Promise<unknown>) =>
    void work
      .then(() => Promise.all([projects.refetch(), tasks.refetch(), brief.refetch()]))
      .catch((error: unknown) => toast.error(errorText(error)));
  const note = projects.data ? memoriseNote(projects.data.memorise) : null;
  const pinRow = (hit: SearchHit) => ({ pinned: project?.pins.includes(hit.id) ?? false, onPin: (pinned: boolean) => project && change(pin({ repoKey: project.repoKey, id: hit.id, pinned })) });

  const running = project?.generation?.state === "running";
  const more = useMoreActions(project?.name ?? "this project", [
    { label: "Re-index", disabled: project?.indexing ?? true, onPress: () => project && change(reindex({ repoKey: project.repoKey })) },
    { label: "Add past conversations", disabled: running, onPress: () => project && change(generate({ repoKey: project.repoKey, generate: false })) },
    { label: "Summarise past conversations", disabled: running, onPress: () => project && change(generate({ repoKey: project.repoKey, generate: true })) },
  ], styles);
  const canPick = !fixedRepoKey && all.length > 1;

  if (projects.isPending) return <Text style={styles.muted}>Reading projects</Text>;
  return (
    <>
      {projects.error ? <Text style={styles.danger}>{errorText(projects.error)}</Text> : null}
      {projects.data && all.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>No project knowledge yet</Text>
          <Text style={styles.muted}>Start an agent in a project folder, in git or not. Its docs, conventions, ADRs, and code are indexed then, and each task an agent finishes there is logged.</Text>
        </View>
      ) : null}
      {fixedRepoKey && projects.data && !project ? <Text style={styles.muted}>This project has no knowledge yet. It is read when an agent starts here.</Text> : null}
      {project ? (
        <>
          <View style={styles.row}>
            <Pressable style={styles.grow} disabled={!canPick} onPress={() => setPicking(!picking)} accessibilityRole={canPick ? "button" : undefined} accessibilityState={canPick ? { expanded: picking } : undefined} accessibilityLabel={canPick ? `Project ${project.name}; choose another of ${all.length}` : project.name}>
              <View style={styles.inline}>
                <Text style={[styles.title, { flexShrink: 1 }]} numberOfLines={1}>
                  {project.name}
                </Text>
                {canPick ? <Icon name={ICONS.expanded} size={16} color={styles.colors.foregroundMuted} /> : null}
              </View>
              <Text style={styles.faint} numberOfLines={1}>
                {!project.enabled ? "Off: new agents here start without project knowledge" : project.indexing ? "Reading the project…" : project.indexedAt ? `Read ${ago(project.indexedAt)}` : ""}
              </Text>
            </Pressable>
            <Switch
              value={project.enabled}
              onValueChange={(enabled) => change(setProjectEnabled({ repoKey: project.repoKey, enabled }))}
              trackColor={{ true: styles.colors.accent, false: styles.colors.surface2 }}
              accessibilityLabel={`Project knowledge for ${project.name}`}
            />
            {more.button}
          </View>
          {more.panel}
          {picking ? (
            <View style={styles.wrap}>
              {all.map((candidate) => (
                <Chip
                  key={candidate.repoKey}
                  label={candidate.name}
                  on={candidate.repoKey === repoKey}
                  onPress={() => {
                    setRepoKey(candidate.repoKey);
                    setPicking(false);
                  }}
                  accessibilityLabel={`Show ${candidate.name} (${candidate.repoKey})`}
                  styles={styles}
                />
              ))}
            </View>
          ) : null}
          {project.problem ? <Text style={styles.danger}>{project.problem}</Text> : null}
          {project.generation ? (
            <Text style={project.generation.state === "failed" ? styles.danger : styles.faint} numberOfLines={2}>
              {project.generation.state === "running" ? `${project.generation.message}…` : `${project.generation.state === "failed" ? "Failed" : "Done"} ${ago(project.generation.at)}: ${project.generation.message}`}
            </Text>
          ) : null}
          {view === "overview" && area === null && query.trim() === "" ? (
            <View style={styles.card}>
              <View style={styles.row}>
                <View style={styles.grow}>
                  <SectionTitle label="About this project" hint={brief.data ? "written by an agent from the facts below; may contain mistakes" : readme.data ? "from the README" : undefined} styles={styles} />
                </View>
                {writing ? (
                  <Button
                    label={brief.data ? "Rewrite" : "Write a description"}
                    icon={ICONS.knowledge}
                    styles={styles}
                    disabled={project.generation?.state === "running"}
                    onPress={() => change(describe({ repoKey: project.repoKey }))}
                  />
                ) : null}
              </View>
              {/* Written by a model that read repository text, so shown as plain text: no links or images. */}
              {brief.data ? (
                <Text style={styles.text} selectable>
                  {brief.data.body}
                </Text>
              ) : readme.data ? (
                <EntryBody entry={readme.data} styles={styles} />
              ) : (
                <Text style={styles.muted}>No description yet.</Text>
              )}
              {!writing && !brief.data ? <Text style={styles.faint}>Turn on Settings &gt; Contextualise &gt; Conversation summaries to get a written description and a line for each area.</Text> : null}
            </View>
          ) : null}
          <SearchField value={query} onChange={setQuery} placeholder="Search documents, code, and past work" label="Search project knowledge" styles={styles} />
          <View style={styles.wrap}>
            {VIEWS.map(([value, label, count]) => {
              const n = count(project);
              return n === 0 && value !== "overview" && value !== "areas" ? null : (
                <Chip key={value} label={n > 0 ? `${label} ${n}` : label} on={view === value} onPress={() => show(value)} accessibilityLabel={`Show ${label}`} styles={styles} />
              );
            })}
          </View>
          {view === "documents" ? (
            <View style={styles.wrap}>
              {DOCUMENT_KINDS.filter((entry) => project.counts[entry] > 0).map((entry) => (
                <Chip
                  key={entry}
                  label={`${KIND_LABELS[entry]} ${project.counts[entry]}`}
                  on={kind === entry}
                  onPress={() => setKind(kind === entry ? null : entry)}
                  accessibilityLabel={kind === entry ? `Showing ${KIND_LABELS[entry]}; show every document` : `Show only ${KIND_LABELS[entry]}`}
                  styles={styles}
                />
              ))}
            </View>
          ) : null}
          {query.trim() !== "" ? (
            <>
              <SectionTitle label="Results" count={hits.data?.hits.length} hint={kind ? KIND_LABELS[kind] : undefined} styles={styles} />
              {hits.error ? <Text style={styles.danger}>{errorText(hits.error)}</Text> : null}
              {hits.data?.hits.length === 0 ? <Text style={styles.muted}>Nothing matches. Try other words, or fewer.</Text> : null}
              {hits.data?.hits.map((hit) => <HitRow key={hit.id} hit={hit} repoKey={project.repoKey} {...pinRow(hit)} styles={styles} />)}
            </>
          ) : area !== null ? (
            <AreaPage
              repoKey={project.repoKey}
              path={area}
              onOpenArea={setArea}
              onBack={() => setArea(null)}
              styles={styles}
              onExplain={writing && project.generation?.state !== "running" ? () => change(explain({ repoKey: project.repoKey, path: area })) : null}
            />
          ) : view === "tasks" ? (
            <TaskList repoKey={project.repoKey} styles={styles} />
          ) : view === "code" ? (
            <KindList repoKey={project.repoKey} kind="code" pinRow={pinRow} styles={styles} />
          ) : view === "areas" ? (
            <AreaList repoKey={project.repoKey} onOpenArea={setArea} styles={styles} />
          ) : view === "documents" ? (
            kind && kind !== "task" ? (
              <KindList repoKey={project.repoKey} kind={kind} pinRow={pinRow} styles={styles} />
            ) : (
              DOCUMENT_KINDS.filter((entry) => project.counts[entry] > 0).map((entry) => (
                <KindSection key={entry} repoKey={project.repoKey} kind={entry} total={project.counts[entry]} onShowAll={() => setKind(entry)} pinRow={pinRow} styles={styles} />
              ))
            )
          ) : (
            <>
              <ProjectOverview repoKey={project.repoKey} onOpenArea={setArea} onShowAreas={() => show("areas")} styles={styles} />
              <View style={styles.row}>
                <SectionTitle label="Recent work" count={tasks.data?.total} styles={styles} />
                <View style={styles.grow} />
                {(tasks.data?.total ?? 0) > OVERVIEW_ROWS ? <Button label={`Show all ${tasks.data?.total}`} styles={styles} onPress={() => show("tasks")} /> : null}
              </View>
              {(tasks.data?.total ?? 0) < FEW_TASKS && project.generation?.state !== "running" ? (
                <View style={[styles.card, styles.row]}>
                  <Text style={[styles.muted, styles.grow]}>
                    {tasks.data?.total ? `Only ${plural(tasks.data.total, "conversation")} recorded here so far.` : "No conversations recorded here yet."} Add past conversations to bring in the earlier ones.
                  </Text>
                  <Button label="Add past conversations" kind="primary" styles={styles} disabled={running} onPress={() => change(generate({ repoKey: project.repoKey, generate: false }))} />
                </View>
              ) : null}
              {(tasks.data?.tasks.length ?? 0) > 0 ? <View style={styles.card}>{tasks.data?.tasks.map((task) => <TaskRow key={task.id} task={task} styles={styles} />)}</View> : null}
            </>
          )}
        </>
      ) : null}
      {note ? (
        <Text style={styles.faint}>
          {note.text}
          {note.command ? ` Run: ${note.command}` : ""}
        </Text>
      ) : null}
      {project && !fixedRepoKey ? <Text style={styles.faint}>{plural(all.length, "project")} indexed on this computer.</Text> : null}
    </>
  );
}

export function KnowledgeScreen({ theme, layout, params }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <KnowledgeView styles={styles} initialRepoKey={params.repoKey} />
    </ScrollView>
  );
}

// A workspace's own Project knowledge tab: the server says which project the workspace's folder
// belongs to (worktrees and subfolders included), and the view shows that one, with no picker.
export function WorkspaceKnowledgePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme, layout.compact);
  const projectFor = useRpc(projectForWorkspaceRpc);
  const owner = useQuery({ queryKey: ["contextualise", "knowledge", "project-for", workspaceId], queryFn: () => projectFor({ workspaceId }) });
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {owner.error ? <Text style={styles.danger}>{errorText(owner.error)}</Text> : null}
      {owner.isPending ? <Text style={styles.muted}>Finding this workspace's project</Text> : null}
      {owner.data && owner.data.repoKey === null ? <Text style={styles.muted}>This folder gets no project knowledge (it is your home folder, a drive root, or plugin data).</Text> : null}
      {owner.data?.repoKey ? <KnowledgeView styles={styles} fixedRepoKey={owner.data.repoKey} /> : null}
    </ScrollView>
  );
}
