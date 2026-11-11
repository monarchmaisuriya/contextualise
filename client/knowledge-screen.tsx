import { type PluginScreenProps, type PluginWorkspacePanelProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { snapshotSettings } from "../shared/contracts";
import { BRIEF_ID, describeProjectRpc, explainAreaRpc, fileConnectionsRpc, generateKnowledgeRpc, KIND_LABELS, type KnowledgeKind, knowledgeIntroRpc, knowledgeOverviewRpc, knowledgeUsageRpc, listProjectsRpc, listTasksRpc, pinEntryRpc, type Project, projectForWorkspaceRpc, readKnowledgeRpc, reindexRpc, type SearchHit, searchKnowledgeRpc, setProjectEnabledRpc } from "../shared/knowledge";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { ActionSheet, ago, Button, IconButton, ListRow, Page, plural, Prose, ReaderSheet, SearchField, SectionHeader, Segmented, StateView, type Styles, Toggle, useActionSheet, usePagedList, useStyles } from "./kit";
import { KindFiles, type Pins } from "./knowledge/files";
import { entryMeta, glanceLine, readerBody } from "./knowledge/text";
import { LinkedProjects } from "./linked-projects";
import { memoriseNote } from "./memorise-note";
import { type Navigation, NeedsYou, Period, RiskyFiles, StartHere, usePulse } from "./knowledge/pulse";
import { AreaPage, AreasView, Connections, EntryBody, type ReadTarget, TaskRow, useFacts } from "./project-map";
import { overviewLine, usageLine } from "./usage-line";

const PROJECTS_QUERY = ["contextualise", "knowledge", "projects"];
const knowledgeKey = (part: string, repoKey: string) => ["contextualise", "knowledge", part, repoKey];

const OVERVIEW_ROWS = 5;
const PAGE = 50;
// The kinds of written documents, listed together under Documents.
const DOCUMENT_KINDS = ["architecture", "convention", "adr", "doc"] as const;
type ScreenView = "overview" | "areas" | "documents" | "code" | "tasks";

// The views, with what each counts on its tab; a view with nothing in it is left out.
const VIEWS: readonly (readonly [ScreenView, string, (project: Project) => number])[] = [
  ["overview", "Overview", () => 0],
  ["areas", "Areas", () => 0],
  ["documents", "Documents", (project) => DOCUMENT_KINDS.reduce((sum, kind) => sum + project.counts[kind], 0)],
  ["code", "Code", (project) => project.counts.code],
  ["tasks", "Past work", (project) => project.counts.task],
];

const pad = { paddingHorizontal: 12 };
// The rail of projects and views on a wide screen.
const RAIL_WIDTH = 232;

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

// The overview, read top to bottom: what needs M, what the project is, what changed lately, where to
// start, what is risky, recent work, and what agents get.
function Overview({ project, hostKey, navigation, writing, memorise, change, onShow, onRead, styles }: { project: Project; hostKey: string; navigation: Navigation; writing: boolean; memorise: ReactNode; change(work: Promise<unknown>): void; onShow(view: ScreenView): void; onRead(target: ReadTarget): void; styles: Styles }) {
  const { repoKey } = project;
  const running = project.generation?.state === "running";
  const read = useRpc(readKnowledgeRpc);
  // The description is read like any entry; a project without one answers with an error, shown as nothing.
  const brief = useQuery({ queryKey: knowledgeKey("brief", repoKey), queryFn: () => read({ repoKey, id: BRIEF_ID }), retry: false });
  // Without a written description, the README's first section with prose stands in.
  const getIntro = useRpc(knowledgeIntroRpc);
  const intro = useQuery({ queryKey: knowledgeKey("intro", repoKey), queryFn: () => getIntro({ repoKey }) });
  const introId = intro.data?.intro?.id ?? null;
  const readme = useQuery({ queryKey: knowledgeKey("readme", repoKey).concat(introId ?? ""), queryFn: () => read({ repoKey, id: introId ?? "" }), enabled: brief.isError && introId !== null, retry: false });
  const listTasks = useRpc(listTasksRpc);
  const tasks = useQuery({ queryKey: knowledgeKey("tasks", repoKey), queryFn: () => listTasks({ repoKey, limit: OVERVIEW_ROWS }) });
  const getUsage = useRpc(knowledgeUsageRpc);
  // Advisory: a count that cannot be read shows nothing.
  const usage = useQuery({ queryKey: knowledgeKey("usage", repoKey), queryFn: () => getUsage({ repoKey }) });
  const getOverview = useRpc(knowledgeOverviewRpc);
  const overview = useQuery({ queryKey: knowledgeKey("overview", repoKey), queryFn: () => getOverview({ repoKey }) });
  const describe = useRpc(describeProjectRpc);
  const generate = useRpc(generateKnowledgeRpc);
  const pulse = usePulse(repoKey, hostKey);
  const [previewing, setPreviewing] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const used = usage.data ? usageLine(usage.data) : null;
  const total = tasks.data?.total ?? 0;
  // The README row opens its first prose, or its first section when it has none or that is unknown.
  const readIntro = () => onRead({ id: intro.data?.intro?.id ?? "doc:README.md:1", title: "README.md" });
  return (
    <>
      <NeedsYou data={pulse} navigation={navigation} onReadTask={(id, title) => onRead({ id, title })} styles={styles} />

      <SectionHeader label="About" action={writing && !running ? { label: brief.data ? "Rewrite" : "Write description", onPress: () => change(describe({ repoKey })) } : undefined} styles={styles} />
      {brief.data ? (
        <Prose>
          {/* Written by a model that read repository text, so shown as plain text: no links or images. */}
          <Text style={[styles.prose, pad]} selectable>
            {brief.data.body}
          </Text>
          <Text style={[styles.note, pad, { marginTop: 4 }]}>Written by an agent from the project's facts; may contain mistakes.</Text>
        </Prose>
      ) : readme.data ? (
        <Prose>
          <View style={pad}>
            <EntryBody entry={readme.data} styles={styles} />
          </View>
          <Text style={[styles.note, pad, { marginTop: 4 }]}>{writing ? "From the README." : "From the README. Turn on Write summaries of finished conversations in Settings > Contextualise for a written description."}</Text>
        </Prose>
      ) : brief.isError && (intro.isPending || readme.isLoading) ? (
        <StateView state="loading" styles={styles} />
      ) : intro.error ? (
        <StateView state="error" text={`Could not read the README: ${errorText(intro.error)}`} styles={styles} />
      ) : (
        <Text style={[styles.muted, pad]}>No description yet{writing ? "." : ". Turn on Write summaries of finished conversations in Settings > Contextualise to get one."}</Text>
      )}

      <Period data={pulse} styles={styles} />
      <StartHere data={pulse} onReadIntro={readIntro} onOpenFile={setFile} styles={styles} />
      <RiskyFiles data={pulse} onOpenFile={setFile} styles={styles} />
      {file ? <FileReader repoKey={repoKey} path={file} onClose={() => setFile(null)} styles={styles} /> : null}

      <SectionHeader label="Recent work" count={total} action={total > OVERVIEW_ROWS ? { label: "Show all", onPress: () => onShow("tasks") } : undefined} styles={styles} />
      {tasks.isPending ? <StateView state="loading" styles={styles} /> : null}
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

      <SectionHeader
        label="What agents get"
        action={overview.data?.text ? { label: "Preview", onPress: () => {
          void overview.refetch();
          setPreviewing(true);
        } } : undefined}
        styles={styles}
      />
      {overview.error ? <StateView state="error" text={errorText(overview.error)} styles={styles} /> : null}
      {overview.data ? <Text style={[overview.data.state === "given" ? styles.body : styles.muted, pad]}>{overviewLine(overview.data)}</Text> : null}
      {used ? <Text style={[styles.note, pad]}>{used}</Text> : null}
      {memorise}
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
export function KnowledgeView(props: ({ fixedRepoKey: string } | { hostId: string; initialRepoKey?: string }) & { styles: Styles; navigation: Navigation; wide?: boolean }) {
  const { styles, navigation, wide = false } = props;
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
    for (const part of ["brief", "intro", "readme", "facts", "area", "overview", "tasks"]) void refresh(part);
  }, [finishedAt]);
  const toast = useToast();
  // A project change, then fresh project, task, description, and overview data; failures as toasts.
  const change = (work: Promise<unknown>) =>
    void work
      .then(() => Promise.all([queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY }), ...["tasks", "brief", "intro", "readme", "overview"].map(refresh)]))
      .catch((error: unknown) => toast.error(errorText(error)));
  const pins: Pins = {
    isPinned: (id) => project?.pins.includes(id) ?? false,
    setPinned: (id, pinned) => project && change(pin({ repoKey: project.repoKey, id, pinned })),
  };
  const note = projects.data ? memoriseNote(projects.data.memorise) : null;
  const running = project?.generation?.state === "running";
  const canPick = !fixedRepoKey && all.length > 1;
  const menu = useActionSheet(project?.name ?? "this project", [
    // Choosing a project is the title's job, and re-indexing has its own button in the header.
    { label: "Add past conversations", disabled: running, onPress: () => project && change(generate({ repoKey: project.repoKey, generate: false })) },
    { label: writing ? "Summarise past conversations" : "Summarise past conversations (summaries are off in Settings)", disabled: running || !writing, onPress: () => project && change(generate({ repoKey: project.repoKey, generate: true })) },
  ], styles);

  // A wide screen gives this view no page of its own, so a state alone is framed like one.
  const framed = (node: ReactNode) => (wide && !fixedRepoKey ? <Page styles={styles}>{node}</Page> : node);
  if (projects.isPending) return framed(<StateView state="loading" styles={styles} />);
  if (projects.error) return framed(<StateView state="error" text={errorText(projects.error)} styles={styles} />);
  if (!project) {
    return framed(<StateView state="empty" text={fixedRepoKey ? "No knowledge for this project yet. It is read when an agent starts here." : "No project knowledge yet. It is read when an agent starts in a project folder, in git or not."} styles={styles} />);
  }
  const readLine = !project.enabled ? "Off: new agents here start without it" : project.indexing ? "Reading the project…" : project.indexedAt ? `Read ${ago(project.indexedAt)}` : "";
  const views = VIEWS.filter(([value, , count]) => value === "overview" || value === "areas" || count(project) > 0).map(([value, label, count]) => ({ value, label, count: count(project) }));
  const named = (candidate: Project) => (all.filter((other) => other.name === candidate.name).length > 1 ? `${candidate.name} (${candidate.repoKey})` : candidate.name);
  const generation = project.generation;
  // On a wide screen of its own, the projects and views sit in a rail beside the page, like a
  // Notion sidebar; a phone or a workspace tab keeps them above it.
  const railed = wide && !fixedRepoKey;
  const choosable = canPick && !railed;
  const memorise = note ? <Text style={[styles.note, pad]}>{`${note.text}${note.command ? ` Run: ${note.command}` : ""}`}</Text> : null;

  // The page's own header: the project's name, its properties in one line, and what it does for agents.
  const header = (
    <View style={{ gap: 4, paddingHorizontal: 12 }}>
      <View style={styles.row}>
        <Pressable style={[styles.inline, { flexShrink: 1 }]} disabled={!choosable} onPress={() => setChoosing(true)} accessibilityRole={choosable ? "button" : "header"} accessibilityLabel={choosable ? `Project ${project.name}; choose another of ${all.length}` : project.name}>
          <Text style={[styles.page, { flexShrink: 1 }]} numberOfLines={1}>
            {project.name}
          </Text>
          {choosable ? <Icon name={ICONS.expanded} size={18} color={styles.colors.foregroundMuted} /> : null}
        </Pressable>
        <View style={styles.grow} />
        <IconButton icon={ICONS.refresh} label={project.indexing ? "Reading the project" : "Read the project again"} disabled={project.indexing} onPress={() => change(reindex({ repoKey: project.repoKey }))} styles={styles} />
        {menu.button}
      </View>
      <Text style={styles.note}>{[readLine, ...(facts.data ? [glanceLine(facts.data.facts)] : [])].filter(Boolean).join(" · ")}</Text>
      <View style={[styles.row, { marginTop: 4 }]}>
        <Toggle value={project.enabled} onValueChange={(enabled) => change(setProjectEnabled({ repoKey: project.repoKey, enabled }))} label={`New agents get knowledge of ${project.name}`} styles={styles} />
        <Text style={styles.body}>New agents get this project's knowledge</Text>
      </View>
      {generation?.state === "running" ? <Text style={styles.note}>{generation.message}…</Text> : null}
      {generation?.state === "done" ? <Text style={styles.note}>Done {ago(generation.at)}: {generation.message}</Text> : null}
    </View>
  );
  const problems = (
    <>
      {generation?.state === "failed" ? <StateView state="error" text={`Failed ${ago(generation.at)}: ${generation.message}`} styles={styles} /> : null}
      {project.problem ? <StateView state="error" text={project.problem} styles={styles} /> : null}
    </>
  );
  const searchField = (
    <View style={[pad, styles.compact ? null : { maxWidth: 444 }]}>
      <SearchField value={query} onChange={setQuery} placeholder="Search documents, code, and past work" label="Search project knowledge" styles={styles} />
    </View>
  );
  const body =
    query.trim() !== "" ? (
      <>
        <SectionHeader label={kind ? `Results in ${KIND_LABELS[kind]}` : "Results"} count={hits.data?.hits.length} action={{ label: "Clear search", onPress: () => setQuery("") }} styles={styles} />
        {hits.isLoading ? <StateView state="loading" styles={styles} /> : null}
        {hits.error ? <StateView state="error" text={errorText(hits.error)} styles={styles} /> : null}
        {hits.data?.hits.length === 0 ? <Text style={[styles.muted, pad]}>Nothing matches. Try other words, or fewer.</Text> : null}
        {hits.data?.hits.map((hit) => <HitRow key={hit.id} hit={hit} pins={pins} onRead={setReading} styles={styles} />)}
      </>
    ) : area !== null ? (
      <AreaPage repoKey={project.repoKey} path={area} onOpenArea={setArea} onBack={() => setArea(null)} onRead={setReading} styles={styles} onExplain={writing && !running ? () => change(explain({ repoKey: project.repoKey, path: area })) : null} />
    ) : view === "tasks" ? (
      <TaskList repoKey={project.repoKey} onRead={setReading} styles={styles} />
    ) : view === "code" ? (
      <KindFiles repoKey={project.repoKey} kind="code" pins={pins} onRead={setReading} styles={styles} />
    ) : view === "areas" ? (
      <AreasView repoKey={project.repoKey} onOpenArea={setArea} styles={styles} />
    ) : view === "documents" ? (
      DOCUMENT_KINDS.filter((entry) => project.counts[entry] > 0).map((entry) => <KindFiles key={entry} repoKey={project.repoKey} kind={entry} pins={pins} onRead={setReading} styles={styles} />)
    ) : (
      <Overview project={project} hostKey={hostId ?? "workspace"} navigation={navigation} writing={writing} memorise={memorise} change={change} onShow={show} onRead={setReading} styles={styles} />
    );
  const sheets = (
    <>
      {menu.sheet}
      <ActionSheet title="Choose project" open={choosing} onOpenChange={setChoosing} actions={all.map((candidate) => ({ label: candidate.repoKey === repoKey ? `${named(candidate)} · shown` : named(candidate), onPress: () => setRepoKey(candidate.repoKey) }))} styles={styles} />
      {reading ? <EntryReader repoKey={project.repoKey} target={reading} pins={pins} onClose={() => setReading(null)} styles={styles} /> : null}
    </>
  );
  const viewRow = (entry: (typeof views)[number], nested: boolean) => (
    <View key={entry.value} style={nested ? { paddingLeft: 16 } : null}>
      <ListRow title={entry.label} meta={entry.count > 0 ? entry.count.toLocaleString("en-US") : undefined} selected={view === entry.value && area === null && query.trim() === ""} onPress={() => {
        setQuery("");
        show(entry.value);
      }} styles={styles} />
    </View>
  );

  if (railed) {
    return (
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: styles.colors.surface0 }}>
        <ScrollView style={{ width: RAIL_WIDTH, flexGrow: 0, flexShrink: 0, backgroundColor: styles.colors.surface1, borderRightWidth: 1, borderRightColor: styles.colors.border }} contentContainerStyle={{ padding: 8, gap: 2 }}>
          {all.length > 1
            ? all.map((candidate) => (
                <View key={candidate.repoKey} style={{ gap: 2 }}>
                  <ListRow title={named(candidate)} icon={ICONS.folder} selected={candidate.repoKey === repoKey && views.every((entry) => entry.value !== view)} onPress={() => setRepoKey(candidate.repoKey)} styles={styles} />
                  {candidate.repoKey === repoKey ? views.map((entry) => viewRow(entry, true)) : null}
                </View>
              ))
            : views.map((entry) => viewRow(entry, false))}
          <Text style={[styles.note, { paddingHorizontal: 12, marginTop: 12 }]}>{plural(all.length, "project")} on this computer</Text>
        </ScrollView>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {header}
          {problems}
          {searchField}
          {body}
        </ScrollView>
        {sheets}
      </View>
    );
  }
  return (
    <>
      {header}
      {problems}
      {searchField}
      <View style={pad}>
        <Segmented options={views.map((entry) => ({ value: entry.value, label: entry.count > 0 ? `${entry.label} ${entry.count}` : entry.label }))} value={view} onChange={show} label="Project knowledge views" styles={styles} />
      </View>
      {body}
      {sheets}
    </>
  );
}

// While "Project knowledge" is off nothing is read: the screens say so and offer to turn it on.
// `framed`: these states stand alone on a wide screen, so they get a page of their own there.
function KnowledgeOn({ styles, framed = false, children }: { styles: Styles; framed?: boolean; children: ReactNode }) {
  const settings = useSettings(snapshotSettings);
  const frame = (node: ReactNode) => (framed ? <Page styles={styles}>{node}</Page> : node);
  if (settings.status === "loading") return frame(<StateView state="loading" styles={styles} />);
  if (settings.status !== "ready") return frame(<StateView state="error" text={`Contextualise settings could not be read (${settings.error}); fix or reset them in Settings > Contextualise.`} styles={styles} />);
  if (!settings.values.knowledgeEnabled) {
    const turnOn = () => void settings.save({ ...settings.values, knowledgeEnabled: true }, settings.revision);
    return frame(<StateView state="empty" text="Project knowledge is off: agents get no project overview or search, and no project is read." actions={[{ label: "Turn on", icon: ICONS.knowledge, onPress: turnOn }]} styles={styles} />);
  }
  return <>{children}</>;
}

export function KnowledgeScreen({ theme, layout, host, params, navigation }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const view = <KnowledgeView styles={styles} navigation={navigation} hostId={host.id} initialRepoKey={params.repoKey} wide={!layout.compact} />;
  // Wide: the view lays out its own rail and scrolling page; a phone scrolls the whole screen.
  return layout.compact ? (
    <Page styles={styles}>
      <KnowledgeOn styles={styles}>{view}</KnowledgeOn>
    </Page>
  ) : (
    <View style={styles.screen}>
      <KnowledgeOn styles={styles} framed>
        {view}
      </KnowledgeOn>
    </View>
  );
}

// A workspace's own Project knowledge tab: the server says which project the workspace's folder
// belongs to (worktrees and subfolders included), and the view shows that one, with no chooser.
// The tab can be narrow when split, and panels are told only whether the window is compact, so it
// always uses the phone layout.
export function WorkspaceKnowledgePanel({ theme, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme, true);
  return (
    <Page styles={styles}>
      {/* Attached projects are folder access, not only knowledge, so they show while knowledge is off. */}
      <SectionHeader label="Attached projects" styles={styles} />
      <LinkedProjects workspaceId={workspaceId} styles={styles} openAgent={(agentId) => navigation?.openAgent({ agentId })} />
      <KnowledgeOn styles={styles}>
        <WorkspaceProject workspaceId={workspaceId} navigation={navigation} styles={styles} />
      </KnowledgeOn>
    </Page>
  );
}

function WorkspaceProject({ workspaceId, navigation, styles }: { workspaceId: string; navigation: Navigation; styles: Styles }) {
  const projectFor = useRpc(projectForWorkspaceRpc);
  const owner = useQuery({ queryKey: ["contextualise", "knowledge", "project-for", workspaceId], queryFn: () => projectFor({ workspaceId }) });
  return (
    <>
      {owner.error ? <StateView state="error" text={errorText(owner.error)} styles={styles} /> : null}
      {owner.isPending ? <StateView state="loading" styles={styles} /> : null}
      {owner.data && owner.data.repoKey === null ? <StateView state="empty" text="This folder gets no project knowledge (it is your home folder, a drive root, or plugin data)." styles={styles} /> : null}
      {owner.data?.repoKey ? <KnowledgeView styles={styles} navigation={navigation} fixedRepoKey={owner.data.repoKey} /> : null}
    </>
  );
}
