import { type PluginScreenProps, type PluginWorkspacePanelProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { snapshotSettings } from "../shared/contracts";
import { BRIEF_ID, browseKnowledgeRpc, describeProjectRpc, explainAreaRpc, fileConnectionsRpc, generateKnowledgeRpc, KIND_LABELS, type KnowledgeKind, knowledgeOverviewRpc, knowledgeUsageRpc, listProjectsRpc, listTasksRpc, pinEntryRpc, type Project, projectForWorkspaceRpc, readKnowledgeRpc, reindexRpc, type SearchHit, searchKnowledgeRpc, setProjectEnabledRpc } from "../shared/knowledge";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { ActionSheet, ago, Button, IconButton, ListRow, Page, plural, Prose, ReaderSheet, SearchField, SectionHeader, Segmented, StateView, type Styles, Toggle, useActionSheet, usePagedList, useStyles } from "./kit";
import { entryMeta, glanceLine, readerBody } from "./knowledge/text";
import { memoriseNote } from "./memorise-note";
import { type Navigation, Pulse } from "./knowledge/pulse";
import { AreaPage, AreasView, Connections, EntryBody, type ReadTarget, TaskRow, useFacts } from "./project-map";
import { overviewLine, usageLine } from "./usage-line";

const PROJECTS_QUERY = ["contextualise", "knowledge", "projects"];
const knowledgeKey = (part: string, repoKey: string) => ["contextualise", "knowledge", part, repoKey];

const OVERVIEW_ROWS = 5;
const PAGE = 50;
// The kinds of written documents, listed together under Documents.
const DOCUMENT_KINDS = ["architecture", "convention", "adr", "doc"] as const;
type DocumentKind = (typeof DOCUMENT_KINDS)[number];
const isDocumentKind = (kind: KnowledgeKind | null): kind is DocumentKind => (DOCUMENT_KINDS as readonly (KnowledgeKind | null)[]).includes(kind);
type ScreenView = "overview" | "areas" | "documents" | "code" | "tasks";

// The views, with what each counts on its tab; a view with nothing in it is left out.
const VIEWS: readonly (readonly [ScreenView, string, (project: Project) => number])[] = [
  ["overview", "Overview", () => 0],
  ["areas", "Areas", () => 0],
  ["documents", "Documents", (project) => DOCUMENT_KINDS.reduce((sum, kind) => sum + project.counts[kind], 0)],
  ["code", "Code", (project) => project.counts.code],
  ["tasks", "Past work", (project) => project.counts.task],
];

type Pins = { isPinned(id: string): boolean; setPinned(id: string, pinned: boolean): void };
const pad = { paddingHorizontal: 12 };

// One entry: its title, kind, and place; pressed, it opens in the reader. The pin beside it puts it
// in the overview agents get.
function HitRow({ hit, pins, onRead, styles }: { hit: SearchHit; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const pinned = pins.isPinned(hit.id);
  return (
    <ListRow
      title={hit.title}
      meta={entryMeta(hit)}
      accessibilityLabel={`Read ${hit.title}`}
      onPress={() => onRead({ id: hit.id, title: hit.title })}
      trailing={<IconButton icon={pinned ? ICONS.unpin : ICONS.pin} label={`${pinned ? "Unpin" : "Pin"} ${hit.title} ${pinned ? "from" : "to"} the project map`} onPress={() => pins.setPinned(hit.id, !pinned)} styles={styles} />}
      styles={styles}
    />
  );
}

// One kind under Documents > All: its first entries and a way to see all of them.
function KindSection({ repoKey, kind, total, onShowAll, pins, onRead, styles }: { repoKey: string; kind: DocumentKind; total: number; onShowAll(): void; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const browse = useRpc(browseKnowledgeRpc);
  const page = useQuery({ queryKey: ["contextualise", "knowledge", "browse", repoKey, kind, "overview"], queryFn: () => browse({ repoKey, kind, limit: OVERVIEW_ROWS, offset: 0 }) });
  return (
    <>
      <SectionHeader label={KIND_LABELS[kind]} count={total} action={total > OVERVIEW_ROWS ? { label: "Show all", onPress: onShowAll } : undefined} styles={styles} />
      {page.error ? <StateView state="error" text={errorText(page.error)} styles={styles} /> : null}
      {page.data?.hits.map((hit) => <HitRow key={hit.id} hit={hit} pins={pins} onRead={onRead} styles={styles} />)}
    </>
  );
}

// Every entry of one kind, a page at a time.
function KindList({ repoKey, kind, pins, onRead, styles }: { repoKey: string; kind: Exclude<KnowledgeKind, "task">; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const browse = useRpc(browseKnowledgeRpc);
  const { pages, items: hits, total } = usePagedList(["contextualise", "knowledge", "browse", repoKey, kind], (offset) => browse({ repoKey, kind, limit: PAGE, offset }), (page) => page.hits);
  return (
    <>
      <SectionHeader label={hits.length < total ? `${KIND_LABELS[kind]} · showing ${hits.length} of ${total}` : KIND_LABELS[kind]} count={hits.length < total ? undefined : total} styles={styles} />
      {pages.isLoading ? <StateView state="loading" styles={styles} /> : null}
      {pages.error ? <StateView state="error" text={errorText(pages.error)} styles={styles} /> : null}
      {hits.map((hit) => <HitRow key={hit.id} hit={hit} pins={pins} onRead={onRead} styles={styles} />)}
      {pages.hasNextPage ? <Button label="Show more" styles={styles} disabled={pages.isFetchingNextPage} onPress={() => void pages.fetchNextPage()} /> : null}
    </>
  );
}

// Every recorded conversation, newest first, a page at a time.
function TaskList({ repoKey, onRead, styles }: { repoKey: string; onRead(target: ReadTarget): void; styles: Styles }) {
  const listTasks = useRpc(listTasksRpc);
  const { pages, items: tasks, total } = usePagedList([...knowledgeKey("tasks", repoKey), "all"], (offset) => listTasks({ repoKey, limit: PAGE, offset }), (page) => page.tasks);
  return (
    <>
      <SectionHeader label={tasks.length < total ? `Past work · showing ${tasks.length} of ${total}` : "Past work"} count={tasks.length < total ? undefined : total} styles={styles} />
      {pages.isLoading ? <StateView state="loading" styles={styles} /> : null}
      {pages.error ? <StateView state="error" text={errorText(pages.error)} styles={styles} /> : null}
      {tasks.length === 0 && !pages.isLoading ? <Text style={[styles.muted, pad]}>No work recorded yet.</Text> : null}
      {tasks.map((task) => <TaskRow key={task.id} task={task} onOpen={onRead} styles={styles} />)}
      {pages.hasNextPage ? <Button label="Show more" styles={styles} disabled={pages.isFetchingNextPage} onPress={() => void pages.fetchNextPage()} /> : null}
    </>
  );
}

// One entry in the reader, with Copy and Pin.
function EntryReader({ repoKey, target, pins, onClose, styles }: { repoKey: string; target: ReadTarget; pins: Pins; onClose(): void; styles: Styles }) {
  const read = useRpc(readKnowledgeRpc);
  const entry = useQuery({ queryKey: ["contextualise", "knowledge", "read", repoKey, target.id], queryFn: () => read({ repoKey, id: target.id }) });
  const body = entry.data ? readerBody(entry.data) : undefined;
  return (
    <ReaderSheet
      title={entry.data?.title ?? target.title}
      text={body && target.lead ? `${target.lead}\n\n${body.text}` : body?.text}
      plain={body?.plain}
      meta={entry.data ? entryMeta(entry.data) : undefined}
      error={entry.error ? errorText(entry.error) : undefined}
      pin={{ pinned: pins.isPinned(target.id), onChange: (pinned) => pins.setPinned(target.id, pinned) }}
      footer={entry.data?.connections ? <Connections connections={entry.data.connections} styles={styles} /> : undefined}
      onClose={onClose}
      styles={styles}
    />
  );
}

// The overview: the pulse first (what needs M, numbers, activity, risk, where to start), then recent
// work, then what the project says about itself and what agents get.
function Overview({ project, hostKey, navigation, writing, change, onShow, onRead, styles }: { project: Project; hostKey: string; navigation: Navigation; writing: boolean; change(work: Promise<unknown>): void; onShow(view: ScreenView): void; onRead(target: ReadTarget): void; styles: Styles }) {
  const { repoKey } = project;
  const running = project.generation?.state === "running";
  const read = useRpc(readKnowledgeRpc);
  // The description is read like any entry; a project without one answers with an error, shown as nothing.
  const brief = useQuery({ queryKey: knowledgeKey("brief", repoKey), queryFn: () => read({ repoKey, id: BRIEF_ID }), retry: false });
  // Without a written description, the README's opening section stands in.
  const readme = useQuery({ queryKey: knowledgeKey("readme", repoKey), queryFn: () => read({ repoKey, id: "doc:README.md:1" }), enabled: brief.isError, retry: false });
  const listTasks = useRpc(listTasksRpc);
  const tasks = useQuery({ queryKey: knowledgeKey("tasks", repoKey), queryFn: () => listTasks({ repoKey, limit: OVERVIEW_ROWS }) });
  const getUsage = useRpc(knowledgeUsageRpc);
  // Advisory: a count that cannot be read shows nothing.
  const usage = useQuery({ queryKey: knowledgeKey("usage", repoKey), queryFn: () => getUsage({ repoKey }) });
  const getOverview = useRpc(knowledgeOverviewRpc);
  const overview = useQuery({ queryKey: knowledgeKey("overview", repoKey), queryFn: () => getOverview({ repoKey }) });
  const describe = useRpc(describeProjectRpc);
  const generate = useRpc(generateKnowledgeRpc);
  const [previewing, setPreviewing] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const used = usage.data ? usageLine(usage.data) : null;
  const total = tasks.data?.total ?? 0;
  return (
    <>
      <Pulse
        repoKey={repoKey}
        hostKey={hostKey}
        navigation={navigation}
        onReadTask={(id, title) => onRead({ id, title })}
        onReadReadme={() => onRead({ id: "doc:README.md:1", title: "README.md" })}
        onOpenFile={setFile}
        onShow={onShow}
        styles={styles}
      />
      {file ? <FileReader repoKey={repoKey} path={file} onClose={() => setFile(null)} styles={styles} /> : null}

      <SectionHeader label="Recent work" count={total} action={total > OVERVIEW_ROWS ? { label: "Show all", onPress: () => onShow("tasks") } : undefined} styles={styles} />
      {tasks.error ? <StateView state="error" text={errorText(tasks.error)} styles={styles} /> : null}
      {tasks.data && total === 0 ? (
        <StateView
          state="empty"
          text={running ? "No conversations recorded here yet. Adding past conversations…" : "No conversations recorded here yet."}
          actions={running ? [] : [{ label: "Add past conversations", onPress: () => change(generate({ repoKey, generate: false })) }]}
          styles={styles}
        />
      ) : null}
      {tasks.data?.tasks.map((task) => <TaskRow key={task.id} task={task} onOpen={onRead} styles={styles} />)}

      <SectionHeader label="About" action={writing && !running ? { label: brief.data ? "Rewrite" : "Write description", onPress: () => change(describe({ repoKey })) } : undefined} styles={styles} />
      {brief.data ? (
        <>
          <Text style={[styles.sm, pad]}>Written by an agent from the project's facts; may contain mistakes.</Text>
          {/* Written by a model that read repository text, so shown as plain text: no links or images. */}
          <Prose>
            <Text style={[styles.text, pad]} selectable>
              {brief.data.body}
            </Text>
          </Prose>
        </>
      ) : readme.data ? (
        <>
          <Text style={[styles.sm, pad]}>From the README.</Text>
          <Prose>
            <View style={pad}>
              <EntryBody entry={readme.data} styles={styles} />
            </View>
          </Prose>
        </>
      ) : (
        <Text style={[styles.muted, pad]}>No description yet.</Text>
      )}
      {!writing && !brief.data ? <Text style={[styles.sm, pad]}>Turn on Settings &gt; Contextualise &gt; Conversation summaries to get a written description and a line for each area.</Text> : null}

      <SectionHeader
        label="What agents get"
        action={overview.data?.text ? { label: "Preview", onPress: () => {
          void overview.refetch();
          setPreviewing(true);
        } } : undefined}
        styles={styles}
      />
      {overview.error ? <StateView state="error" text={errorText(overview.error)} styles={styles} /> : null}
      {overview.data ? <Text style={[overview.data.state === "given" ? styles.text : styles.muted, pad]}>{overviewLine(overview.data)}</Text> : null}
      {used ? <Text style={[styles.muted, pad]}>{used}</Text> : null}
      {previewing ? (
        <ReaderSheet
          title="What agents get"
          text={overview.isFetching ? undefined : (overview.data?.text ?? "")}
          meta={overview.data ? `${plural(overview.data.lines, "line")}, as a new agent here would get it from the current index` : undefined}
          error={overview.error ? errorText(overview.error) : undefined}
          plain
          onClose={() => setPreviewing(false)}
          styles={styles}
        />
      ) : null}
    </>
  );
}

// One code file opened from the pulse: its path to copy, and what it imports, uses it, and tests it.
function FileReader({ repoKey, path, onClose, styles }: { repoKey: string; path: string; onClose(): void; styles: Styles }) {
  const getConnections = useRpc(fileConnectionsRpc);
  const connections = useQuery({ queryKey: knowledgeKey("connections", repoKey).concat(path), queryFn: () => getConnections({ repoKey, path }) });
  return (
    <ReaderSheet
      title={path}
      text={connections.data ? path : undefined}
      plain
      meta="Code file"
      error={connections.error ? errorText(connections.error) : undefined}
      footer={connections.data ? <Connections connections={connections.data} styles={styles} /> : undefined}
      onClose={onClose}
      styles={styles}
    />
  );
}

// The project last shown on the global screen, per host, so opening it again returns there. Hosts
// index different folders, so one host's choice means nothing on another.
const lastRepoKeys = new Map<string, string>();

// Project knowledge for one project: what it is, what agents get, and its documents, code, and past
// work to search and read. On the global screen the user picks the project, remembered for its host; a
// workspace tab passes its own as `fixedRepoKey`.
export function KnowledgeView(props: ({ fixedRepoKey: string } | { hostId: string; initialRepoKey?: string }) & { styles: Styles; navigation: Navigation }) {
  const { styles, navigation } = props;
  const fixedRepoKey = "fixedRepoKey" in props ? props.fixedRepoKey : undefined;
  const hostId = "hostId" in props ? props.hostId : null;
  const listProjects = useRpc(listProjectsRpc);
  const projects = useQuery({ queryKey: PROJECTS_QUERY, queryFn: () => listProjects({}), refetchInterval: (query) => {
      const listed = query.state.data?.projects ?? [];
      // Polls while a project is being read or written, and, in a workspace tab, until its project appears.
      const waiting = listed.some((project) => project.indexing || project.generation?.state === "running") || (fixedRepoKey !== undefined && !listed.some((project) => project.repoKey === fixedRepoKey));
      return waiting ? 3_000 : false;
    },
  });
  const [repoKey, setRepoKey] = useState<string | null>(fixedRepoKey ?? ("initialRepoKey" in props ? props.initialRepoKey : undefined) ?? (hostId === null ? null : (lastRepoKeys.get(hostId) ?? null)));
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState("");
  // The view, an area opened from it, and, under Documents, one kind. Search narrows to the kind.
  const [view, setView] = useState<ScreenView>("overview");
  const [area, setArea] = useState<string | null>(null);
  const [kind, setKind] = useState<KnowledgeKind | null>(null);
  // Another project's counts differ, so its views start from the overview.
  useEffect(() => {
    setView("overview");
    setKind(null);
  }, [repoKey]);
  const [reading, setReading] = useState<ReadTarget | null>(null);
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
    if (repoKey && hostId !== null) lastRepoKeys.set(hostId, repoKey);
  }, [repoKey, hostId]);
  useEffect(() => {
    setArea(null);
    setReading(null);
  }, [repoKey]);
  const project = all.find((candidate) => candidate.repoKey === repoKey) ?? null;
  const facts = useFacts(project?.repoKey ?? null);
  const search = useRpc(searchKnowledgeRpc);
  const hits = useQuery({
    queryKey: ["contextualise", "knowledge", "search", repoKey, query.trim(), kind],
    queryFn: () => search({ repoKey: repoKey ?? "", query: query.trim(), kinds: kind ? [kind] : [], limit: 50 }),
    enabled: repoKey !== null && query.trim() !== "",
  });
  const reindex = useRpc(reindexRpc);
  const setProjectEnabled = useRpc(setProjectEnabledRpc);
  const generate = useRpc(generateKnowledgeRpc);
  const pin = useRpc(pinEntryRpc);
  const explain = useRpc(explainAreaRpc);
  // Writing is offered only once settings are read and summaries are on.
  const settings = useSettings(snapshotSettings);
  const writing = settings.status === "ready" && settings.values.knowledgeGenerate;
  const queryClient = useQueryClient();
  const refresh = (part: string) => (repoKey ? queryClient.invalidateQueries({ queryKey: knowledgeKey(part, repoKey) }) : Promise.resolve());
  // A finished background job refreshes what it wrote: the description, area lines, and area pages.
  const finishedAt = project?.generation?.state === "running" ? null : (project?.generation?.at ?? null);
  useEffect(() => {
    if (finishedAt === null) return;
    for (const part of ["brief", "facts", "area", "overview", "tasks"]) void refresh(part);
  }, [finishedAt]);
  const toast = useToast();
  // A project change, then fresh project, task, description, and overview data; failures as toasts.
  const change = (work: Promise<unknown>) =>
    void work
      .then(() => Promise.all([queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY }), ...["tasks", "brief", "overview"].map(refresh)]))
      .catch((error: unknown) => toast.error(errorText(error)));
  const pins: Pins = {
    isPinned: (id) => project?.pins.includes(id) ?? false,
    setPinned: (id, pinned) => project && change(pin({ repoKey: project.repoKey, id, pinned })),
  };
  const note = projects.data ? memoriseNote(projects.data.memorise) : null;
  const running = project?.generation?.state === "running";
  const canPick = !fixedRepoKey && all.length > 1;
  const menu = useActionSheet(project?.name ?? "this project", [
    ...(canPick ? [{ label: "Choose project", onPress: () => setChoosing(true) }] : []),
    { label: "Re-index", icon: ICONS.refresh, disabled: project?.indexing ?? true, onPress: () => project && change(reindex({ repoKey: project.repoKey })) },
    { label: "Add past conversations", disabled: running, onPress: () => project && change(generate({ repoKey: project.repoKey, generate: false })) },
    { label: "Summarise past conversations", disabled: running, onPress: () => project && change(generate({ repoKey: project.repoKey, generate: true })) },
  ], styles);

  if (projects.isPending) return <StateView state="loading" styles={styles} />;
  if (projects.error) return <StateView state="error" text={errorText(projects.error)} styles={styles} />;
  if (!project) {
    return <StateView state="empty" text={fixedRepoKey ? "No knowledge for this project yet. It is read when an agent starts here." : "No project knowledge yet. It is read when an agent starts in a project folder, in git or not."} styles={styles} />;
  }
  const readLine = !project.enabled ? "Off: new agents here start without project knowledge" : project.indexing ? "Reading the project…" : project.indexedAt ? `Read ${ago(project.indexedAt)}` : "";
  const viewOptions = VIEWS.filter(([value, , count]) => value === "overview" || value === "areas" || count(project) > 0).map(([value, label, count]) => ({ value, label: count(project) > 0 ? `${label} ${count(project)}` : label }));
  const named = (candidate: Project) => (all.filter((other) => other.name === candidate.name).length > 1 ? `${candidate.name} (${candidate.repoKey})` : candidate.name);
  const generation = project.generation;
  return (
    <>
      <View style={styles.row}>
        <Pressable style={[styles.inline, { flexShrink: 1 }]} disabled={!canPick} onPress={() => setChoosing(true)} accessibilityRole={canPick ? "button" : undefined} accessibilityLabel={canPick ? `Project ${project.name}; choose another of ${all.length}` : project.name}>
          <Text style={[styles.lg, { flexShrink: 1 }]} numberOfLines={1}>
            {project.name}
          </Text>
          {canPick ? <Icon name={ICONS.expanded} size={16} color={styles.colors.foregroundMuted} /> : null}
        </Pressable>
        {!styles.compact && readLine ? (
          <Text style={styles.sm} numberOfLines={1}>
            {readLine}
          </Text>
        ) : null}
        <View style={styles.grow} />
        <Toggle value={project.enabled} onValueChange={(enabled) => change(setProjectEnabled({ repoKey: project.repoKey, enabled }))} label={`Project knowledge for ${project.name}`} styles={styles} />
        {menu.button}
      </View>
      {menu.sheet}
      <ActionSheet
        title="Choose project"
        open={choosing}
        onOpenChange={setChoosing}
        actions={all.map((candidate) => ({ label: candidate.repoKey === repoKey ? `${named(candidate)} · shown` : named(candidate), onPress: () => setRepoKey(candidate.repoKey) }))}
        styles={styles}
      />
      {styles.compact && readLine ? <Text style={styles.sm}>{readLine}</Text> : null}
      {facts.data ? <Text style={styles.sm}>{glanceLine(facts.data.facts)}</Text> : null}
      {generation?.state === "running" ? <Text style={styles.sm}>{generation.message}…</Text> : null}
      {generation?.state === "done" ? <Text style={styles.sm}>Done {ago(generation.at)}: {generation.message}</Text> : null}
      {generation?.state === "failed" ? <StateView state="error" text={`Failed ${ago(generation.at)}: ${generation.message}`} styles={styles} /> : null}
      {project.problem ? <StateView state="error" text={project.problem} styles={styles} /> : null}
      <View style={styles.compact ? { gap: 8 } : [styles.row, { flexWrap: "wrap" }]}>
        <View style={styles.compact ? null : { flexGrow: 1, flexBasis: 240, maxWidth: 420 }}>
          <SearchField value={query} onChange={setQuery} placeholder="Search documents, code, and past work" label="Search project knowledge" styles={styles} />
        </View>
        <Segmented options={viewOptions} value={view} onChange={show} label="Project knowledge views" styles={styles} />
      </View>
      {view === "documents" ? (
        <Segmented
          options={[{ label: "All", value: "all" as const }, ...DOCUMENT_KINDS.filter((entry) => project.counts[entry] > 0).map((entry) => ({ label: `${KIND_LABELS[entry]} ${project.counts[entry]}`, value: entry }))]}
          value={isDocumentKind(kind) ? kind : "all"}
          onChange={(next) => setKind(next === "all" ? null : next)}
          label="Document kinds"
          styles={styles}
        />
      ) : null}
      {query.trim() !== "" ? (
        <>
          <SectionHeader label={kind ? `Results · ${KIND_LABELS[kind]}` : "Results"} count={hits.data?.hits.length} styles={styles} />
          {hits.isLoading ? <StateView state="loading" styles={styles} /> : null}
          {hits.error ? <StateView state="error" text={errorText(hits.error)} styles={styles} /> : null}
          {hits.data?.hits.length === 0 ? <Text style={[styles.muted, pad]}>Nothing matches. Try other words, or fewer.</Text> : null}
          {hits.data?.hits.map((hit) => <HitRow key={hit.id} hit={hit} pins={pins} onRead={setReading} styles={styles} />)}
        </>
      ) : area !== null ? (
        <AreaPage
          repoKey={project.repoKey}
          path={area}
          onOpenArea={setArea}
          onBack={() => setArea(null)}
          onRead={setReading}
          styles={styles}
          onExplain={writing && !running ? () => change(explain({ repoKey: project.repoKey, path: area })) : null}
        />
      ) : view === "tasks" ? (
        <TaskList repoKey={project.repoKey} onRead={setReading} styles={styles} />
      ) : view === "code" ? (
        <KindList repoKey={project.repoKey} kind="code" pins={pins} onRead={setReading} styles={styles} />
      ) : view === "areas" ? (
        <AreasView repoKey={project.repoKey} onOpenArea={setArea} styles={styles} />
      ) : view === "documents" ? (
        isDocumentKind(kind) ? (
          <KindList repoKey={project.repoKey} kind={kind} pins={pins} onRead={setReading} styles={styles} />
        ) : (
          DOCUMENT_KINDS.filter((entry) => project.counts[entry] > 0).map((entry) => (
            <KindSection key={entry} repoKey={project.repoKey} kind={entry} total={project.counts[entry]} onShowAll={() => setKind(entry)} pins={pins} onRead={setReading} styles={styles} />
          ))
        )
      ) : (
        <Overview project={project} hostKey={hostId ?? "workspace"} navigation={navigation} writing={writing} change={change} onShow={show} onRead={setReading} styles={styles} />
      )}
      {reading ? <EntryReader repoKey={project.repoKey} target={reading} pins={pins} onClose={() => setReading(null)} styles={styles} /> : null}
      {note ? (
        <Text style={styles.sm}>
          {note.text}
          {note.command ? ` Run: ${note.command}` : ""}
        </Text>
      ) : null}
      {!fixedRepoKey ? <Text style={styles.sm}>{plural(all.length, "project")} indexed on this computer.</Text> : null}
    </>
  );
}

export function KnowledgeScreen({ theme, layout, host, params, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  return (
    <Page styles={styles}>
      <KnowledgeView styles={styles} navigation={navigation} hostId={host.id} initialRepoKey={params.repoKey} />
    </Page>
  );
}

// A workspace's own Project knowledge tab: the server says which project the workspace's folder
// belongs to (worktrees and subfolders included), and the view shows that one, with no chooser.
// The tab can be narrow when split, and panels are told only whether the window is compact, so it
// always uses the phone layout.
export function WorkspaceKnowledgePanel({ theme, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme, true);
  const projectFor = useRpc(projectForWorkspaceRpc);
  const owner = useQuery({ queryKey: ["contextualise", "knowledge", "project-for", workspaceId], queryFn: () => projectFor({ workspaceId }) });
  return (
    <Page styles={styles}>
      {owner.error ? <StateView state="error" text={errorText(owner.error)} styles={styles} /> : null}
      {owner.isPending ? <StateView state="loading" styles={styles} /> : null}
      {owner.data && owner.data.repoKey === null ? <StateView state="empty" text="This folder gets no project knowledge (it is your home folder, a drive root, or plugin data)." styles={styles} /> : null}
      {owner.data?.repoKey ? <KnowledgeView styles={styles} navigation={navigation} fixedRepoKey={owner.data.repoKey} /> : null}
    </Page>
  );
}
