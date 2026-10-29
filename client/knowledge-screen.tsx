import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BRIEF_ID, generateKnowledgeRpc, KIND_LABELS, KNOWLEDGE_KINDS, type KnowledgeKind, listProjectsRpc, listTasksRpc, pinEntryRpc, type Project, readKnowledgeRpc, reindexRpc, type SearchHit, searchKnowledgeRpc, setProjectEnabledRpc, type TaskSummary } from "../shared/knowledge";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { ago, Button, Chip, IconButton, plural, SectionTitle, type Styles, useStyles } from "./kit";
import { memoriseNote } from "./memorise-note";

const PROJECTS_QUERY = ["contextualise", "knowledge", "projects"];

function where(hit: Pick<SearchHit, "path" | "line">): string {
  return `${hit.path}${hit.line > 0 ? `:${hit.line}` : ""}`;
}

// What each kind's count counts: documents are counted by section, code by definition.
const COUNT_NOUNS: Record<KnowledgeKind, string> = { brief: "brief", architecture: "architecture section", convention: "convention section", adr: "ADR section", doc: "doc section", code: "code symbol", task: "task" };

function countsLine(project: Project): string {
  const parts = KNOWLEDGE_KINDS.filter((kind) => project.counts[kind] > 0).map((kind) => plural(project.counts[kind], COUNT_NOUNS[kind]));
  return parts.length > 0 ? parts.join(" · ") : "Nothing indexed yet";
}

// One result: its kind, place, and snippet; pressed, it opens the full entry below it.
function HitRow({ hit, repoKey, pinned, onPin, styles }: { hit: SearchHit; repoKey: string; pinned: boolean; onPin(pinned: boolean): void; styles: Styles }) {
  const [open, setOpen] = useState(false);
  const read = useRpc(readKnowledgeRpc);
  const entry = useQuery({ queryKey: ["contextualise", "knowledge", "read", repoKey, hit.id], queryFn: () => read({ repoKey, id: hit.id }), enabled: open });
  const toast = useToast();
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
          {hit.needsCheck ? <Text style={styles.danger}> · needs check</Text> : null}
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
            <Text style={[styles.text, { fontFamily: "monospace", fontSize: 12 }]} selectable>
              {entry.data.body}
            </Text>
            <View style={styles.row}>
              <Button label="Copy" icon={ICONS.copy} styles={styles} onPress={() => void copyText(entry.data.body).then(() => toast.show("Copied", { variant: "success" }))} />
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

function TaskRow({ task, styles }: { task: TaskSummary; styles: Styles }) {
  return (
    <View style={{ gap: 2, paddingVertical: 4 }}>
      <View style={styles.row}>
        <Text style={[styles.text, styles.grow]} numberOfLines={1}>
          {task.generatedTitle ?? task.title}
        </Text>
        <Text style={task.outcome === "completed" ? styles.faint : styles.danger}>{task.outcome}</Text>
      </View>
      {task.summary ? (
        <Text style={styles.muted} numberOfLines={3}>
          {task.summary}
        </Text>
      ) : null}
      <Text style={styles.faint} numberOfLines={1}>
        {ago(task.endedAt)} · {task.provider}
        {task.files.length > 0 ? ` · ${task.files.slice(0, 3).join(", ")}${task.files.length > 3 ? `, +${task.files.length - 3}` : ""}` : ""}
        {task.needsCheck ? <Text style={styles.danger}> · needs check</Text> : null}
      </Text>
    </View>
  );
}

// Project knowledge per project: search its docs, ADRs, code, and finished tasks, see what is
// indexed, and re-index it. Agents get the same through their knowledge tools.
export function KnowledgeScreen({ theme, layout }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const listProjects = useRpc(listProjectsRpc);
  const projects = useQuery({ queryKey: PROJECTS_QUERY, queryFn: () => listProjects({}), refetchInterval: (query) => (query.state.data?.projects.some((project) => project.indexing || project.generation?.state === "running") ? 3_000 : false) });
  const [repoKey, setRepoKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<KnowledgeKind[]>([]);
  const all = projects.data?.projects ?? [];
  useEffect(() => {
    if (all.length > 0 && !all.some((project) => project.repoKey === repoKey)) setRepoKey(all[0].repoKey);
  }, [all, repoKey]);
  const project = all.find((candidate) => candidate.repoKey === repoKey) ?? null;
  const search = useRpc(searchKnowledgeRpc);
  const hits = useQuery({
    queryKey: ["contextualise", "knowledge", "search", repoKey, query.trim(), kinds],
    queryFn: () => search({ repoKey: repoKey ?? "", query: query.trim(), kinds, limit: 30 }),
    enabled: repoKey !== null && query.trim() !== "",
  });
  const listTasks = useRpc(listTasksRpc);
  const tasks = useQuery({ queryKey: ["contextualise", "knowledge", "tasks", repoKey], queryFn: () => listTasks({ repoKey: repoKey ?? "", limit: 20 }), enabled: repoKey !== null && query.trim() === "" });
  const reindex = useRpc(reindexRpc);
  const setProjectEnabled = useRpc(setProjectEnabledRpc);
  const generate = useRpc(generateKnowledgeRpc);
  const pin = useRpc(pinEntryRpc);
  const read = useRpc(readKnowledgeRpc);
  // The brief is read like any entry; a project without one answers with an error, shown as nothing.
  const brief = useQuery({ queryKey: ["contextualise", "knowledge", "brief", repoKey], queryFn: () => read({ repoKey: repoKey ?? "", id: BRIEF_ID }), enabled: repoKey !== null, retry: false });
  const toast = useToast();
  // A project change, then fresh project, task, and brief data; failures as readable toasts.
  const change = (work: Promise<unknown>) =>
    void work
      .then(() => Promise.all([projects.refetch(), tasks.refetch(), brief.refetch()]))
      .catch((error: unknown) => toast.error(errorText(error)));
  const note = projects.data ? memoriseNote(projects.data.memorise) : null;
  const toggleKind = (kind: KnowledgeKind) => setKinds((current) => (current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]));

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {projects.error ? <Text style={styles.danger}>{errorText(projects.error)}</Text> : null}
      {projects.data && all.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>No project knowledge yet</Text>
          <Text style={styles.muted}>Start an agent in a project folder, in git or not. Its docs, conventions, ADRs, and code are indexed then, and each task an agent finishes there is logged.</Text>
        </View>
      ) : null}
      {all.length > 1 ? (
        <View style={styles.wrap}>
          {all.map((candidate) => (
            <Chip key={candidate.repoKey} label={candidate.name} on={candidate.repoKey === repoKey} onPress={() => setRepoKey(candidate.repoKey)} accessibilityLabel={`Show ${candidate.repoKey}`} styles={styles} />
          ))}
        </View>
      ) : null}
      {project ? (
        <>
          <View style={styles.row}>
            <View style={styles.grow}>
              <Text style={styles.title} numberOfLines={1}>
                {project.name}
              </Text>
              <Text style={styles.faint} numberOfLines={2}>
                {project.repoKey} · {countsLine(project)}
                {project.indexing ? " · indexing" : project.indexedAt ? ` · indexed ${ago(project.indexedAt)}` : ""}
              </Text>
              {project.problem ? <Text style={styles.danger}>{project.problem}</Text> : null}
              {project.generation ? (
                <Text style={project.generation.state === "failed" ? styles.danger : styles.faint} numberOfLines={2}>
                  {project.generation.state === "running" ? `${project.generation.message}…` : `${project.generation.state === "failed" ? "Failed" : "Done"} ${ago(project.generation.at)}: ${project.generation.message}`}
                </Text>
              ) : null}
            </View>
            <Chip
              label={project.enabled ? "On" : "Off"}
              on={project.enabled}
              onPress={() => change(setProjectEnabled({ repoKey: project.repoKey, enabled: !project.enabled }))}
              accessibilityLabel={`Project knowledge for ${project.name} is ${project.enabled ? "on; turn it off" : "off; turn it on"}`}
              styles={styles}
            />
            <IconButton
              icon={ICONS.refresh}
              label={`Re-index ${project.name}`}
              styles={styles}
              disabled={project.indexing}
              onPress={() =>
                void reindex({ repoKey: project.repoKey })
                  .then(() => projects.refetch())
                  .catch((error: unknown) => toast.error(errorText(error)))
              }
            />
          </View>
          <View style={styles.wrap}>
            <Button label="Add past conversations" icon={ICONS.fetch} styles={styles} disabled={project.generation?.state === "running"} onPress={() => change(generate({ repoKey: project.repoKey, generate: false }))} />
            <Button label="Summarise past conversations" icon={ICONS.knowledge} styles={styles} disabled={project.generation?.state === "running"} onPress={() => change(generate({ repoKey: project.repoKey, generate: true }))} />
          </View>
          {brief.data ? (
            <View style={styles.card}>
              <SectionTitle label="About this project" hint={brief.data.needsCheck ? "may be out of date" : "written automatically; may contain mistakes"} styles={styles} />
              <Text style={styles.text} selectable>
                {brief.data.body}
              </Text>
            </View>
          ) : null}
          <View style={[styles.inline, styles.input, { borderWidth: 0 }]}>
            <Icon name={ICONS.search} size={15} color={styles.colors.foregroundMuted} />
            <TextInput style={[styles.grow, { color: styles.colors.foreground }]} value={query} onChangeText={setQuery} placeholder="Search documents, code, and past work" accessibilityLabel="Search project knowledge" />
            {query !== "" ? <IconButton icon={ICONS.close} label="Clear search" onPress={() => setQuery("")} styles={styles} /> : null}
          </View>
          <View style={styles.wrap}>
            {KNOWLEDGE_KINDS.map((kind) => (
              <Chip key={kind} label={KIND_LABELS[kind]} on={kinds.includes(kind)} onPress={() => toggleKind(kind)} styles={styles} />
            ))}
          </View>
          {query.trim() !== "" ? (
            <>
              <SectionTitle label="Results" count={hits.data?.hits.length} styles={styles} />
              {hits.error ? <Text style={styles.danger}>{errorText(hits.error)}</Text> : null}
              {hits.data?.hits.length === 0 ? <Text style={styles.muted}>Nothing matches. Try other words, or fewer.</Text> : null}
              {hits.data?.hits.map((hit) => (
                <HitRow key={hit.id} hit={hit} repoKey={project.repoKey} pinned={project.pins.includes(hit.id)} onPin={(pinned) => change(pin({ repoKey: project.repoKey, id: hit.id, pinned }))} styles={styles} />
              ))}
            </>
          ) : (
            <>
              <SectionTitle label="Recent work" count={tasks.data?.tasks.length} styles={styles} />
              <View style={styles.card}>
                {tasks.data?.tasks.length === 0 ? <Text style={styles.muted}>No work recorded yet. Each conversation in this project is recorded as it goes, or use Add past conversations.</Text> : null}
                {tasks.data?.tasks.map((task) => <TaskRow key={task.id} task={task} styles={styles} />)}
              </View>
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
      {project ? <Text style={styles.faint}>{plural(all.length, "project")} indexed on this computer. Agents search the same knowledge with knowledge_search.</Text> : null}
    </ScrollView>
  );
}
