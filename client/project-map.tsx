import { useRpc } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { areaLabel, mermaidBlock, neighbourDiagram, overviewDiagram } from "../shared/diagram";
import { type Area, areaRpc, type Busy, type BusyFile, type FileConnections, type KnowledgeEntry, type ProjectFacts, projectFactsRpc, type TaskSummary } from "../shared/knowledge";
import { barsCarryInformation } from "./bars";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { ago, Button, ListRow, plural, Prose, SectionHeader, StateView, type Styles } from "./kit";
import { CONNECTIONS_NOTE, CONNECTIONS_UPDATING, connectionGroups, languageShares, readerBody } from "./knowledge/text";

// An entry to open in the reader, by id, with the title to show while it loads. `lead`: a task's
// written summary, which its stored record does not hold.
export type ReadTarget = { id: string; title: string; lead?: string };

export function factsQueryKey(repoKey: string) {
  return ["contextualise", "knowledge", "facts", repoKey];
}

// Null while no project is chosen yet: nothing is read.
export function useFacts(repoKey: string | null) {
  const facts = useRpc(projectFactsRpc);
  return useQuery({ queryKey: factsQueryKey(repoKey ?? ""), queryFn: () => facts({ repoKey: repoKey ?? "" }), enabled: repoKey !== null });
}

// An entry shown in place (the README standing in for a description); other entries open in the reader.
export function EntryBody({ entry, styles }: { entry: Pick<KnowledgeEntry, "kind" | "path" | "body">; styles: Styles }) {
  const body = readerBody(entry);
  return body.plain ? (
    <Text style={styles.text} selectable>
      {body.text}
    </Text>
  ) : (
    <Markdown>{body.text}</Markdown>
  );
}

// Under a code entry in the reader: what the file imports, what imports it, and its tests.
export function Connections({ connections, styles }: { connections: FileConnections; styles: Styles }) {
  return (
    <View style={{ gap: 12 }}>
      {connectionGroups(connections).map((group) => (
        <View key={group.label} style={{ gap: 4 }}>
          <Text style={styles.muted}>{group.label}</Text>
          <Text style={styles.text} selectable>
            {group.lines.join("\n")}
          </Text>
        </View>
      ))}
      <Text style={styles.sm}>{connections.fresh ? CONNECTIONS_NOTE : `${CONNECTIONS_UPDATING} ${CONNECTIONS_NOTE}`}</Text>
    </View>
  );
}

function languageColors(styles: Styles): string[] {
  return [styles.colors.foregroundMuted, styles.colors.statusSuccess, styles.colors.statusWarning, styles.colors.statusDanger, styles.colors.border];
}

// Code files by language: a legend, and one segmented bar when the shares differ.
function LanguageBar({ languages, styles }: { languages: Record<string, number>; styles: Styles }) {
  const shares = languageShares(languages);
  const colors = languageColors(styles);
  if (shares.length === 0) return null;
  return (
    <View style={{ gap: 6, paddingHorizontal: 12 }}>
      {barsCarryInformation(shares.map((share) => share.count)) ? (
        <View style={{ flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden", gap: 2 }}>
          {shares.map((share, index) => (
            <View key={share.language} style={{ flex: share.count, backgroundColor: colors[index % colors.length] }} />
          ))}
        </View>
      ) : null}
      <View style={styles.wrap}>
        {shares.map((share, index) => (
          <View key={share.language} style={styles.inline}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors[index % colors.length] }} />
            <Text style={styles.sm}>
              {share.language} {share.percent}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function changesByArea(files: BusyFile[]): Map<string, number> {
  const changes = new Map<string, number>();
  for (const file of files) if (file.area !== null) changes.set(file.area, (changes.get(file.area) ?? 0) + file.changes);
  return changes;
}

function AreaRows({ areas, lines, busy, onOpenArea, styles }: { areas: Area[]; lines: Record<string, string>; busy: BusyFile[]; onOpenArea(path: string): void; styles: Styles }) {
  const changes = changesByArea(busy);
  return areas.map((area) => {
    const lately = changes.get(area.path) ?? 0;
    const about = lines[area.path] ?? area.keyNames.slice(0, 4).map((key) => key.name).join(", ");
    const meta = [...(about ? [about] : []), plural(area.files + area.tests, "file"), ...(lately > 0 ? [`${plural(lately, "change")} lately`] : [])].join(" · ");
    return <ListRow key={area.path} title={areaLabel(area.path)} meta={meta} accessibilityLabel={`Open ${areaLabel(area.path)}`} onPress={() => onOpenArea(area.path)} styles={styles} />;
  });
}

// Files changed most lately; a file in an area opens that area. `busy`: the project's history, whose
// state the section explains; left out for one area's files.
export function BusySection({ busy, files, limit, showArea, onOpenArea, styles }: { busy?: Busy; files: BusyFile[]; limit?: number; showArea: boolean; onOpenArea(path: string): void; styles: Styles }) {
  return (
    <>
      <SectionHeader label={busy?.available ? `Busy lately · last ${busy.days} days` : "Busy lately"} styles={styles} />
      {busy?.problem ? <StateView state="error" text={busy.problem} styles={styles} /> : null}
      {busy && !busy.available && !busy.problem ? <Text style={[styles.muted, { paddingHorizontal: 12 }]}>Change history needs git; this folder is not in a git repository.</Text> : null}
      {busy?.available && files.length === 0 ? <Text style={[styles.muted, { paddingHorizontal: 12 }]}>Nothing changed in the last {busy.days} days.</Text> : null}
      {files.slice(0, limit).map((file) => {
        const area = showArea ? file.area : null;
        const meta = [...(area !== null ? [areaLabel(area)] : []), plural(file.changes, "change"), ago(file.lastAt)].join(" · ");
        return <ListRow key={file.path} title={file.path} meta={meta} accessibilityLabel={area !== null ? `${file.path}; open ${areaLabel(area)}` : file.path} onPress={area !== null ? () => onOpenArea(area) : undefined} styles={styles} />;
      })}
    </>
  );
}

// Every area, with how they connect, the languages, and the libraries the code uses most.
export function AreasView({ repoKey, onOpenArea, styles }: { repoKey: string; onOpenArea(path: string): void; styles: Styles }) {
  const query = useFacts(repoKey);
  if (query.error) return <StateView state="error" text={errorText(query.error)} styles={styles} />;
  if (!query.data) return <StateView state="loading" styles={styles} />;
  const { facts, busy, areaLines } = query.data;
  const diagram = overviewDiagram(facts);
  return (
    <>
      {diagram ? (
        <>
          <SectionHeader label="How the parts connect" styles={styles} />
          <Markdown>{mermaidBlock(diagram)}</Markdown>
          <Text style={[styles.sm, { paddingHorizontal: 12 }]}>Each box is a folder of code; an arrow means its files import the other's. Thicker arrows mean more files.</Text>
        </>
      ) : null}
      {Object.keys(facts.languages).length > 0 ? (
        <>
          <SectionHeader label="Languages" styles={styles} />
          <LanguageBar languages={facts.languages} styles={styles} />
        </>
      ) : null}
      {facts.libraries.length > 0 ? (
        <>
          <SectionHeader label="Most used libraries" styles={styles} />
          <Text style={[styles.text, { paddingHorizontal: 12 }]}>{facts.libraries.map((library) => `${library.name} ${library.files}`).join(" · ")}</Text>
        </>
      ) : null}
      <SectionHeader label="Areas" count={facts.areas.length} styles={styles} />
      {facts.areas.length === 0 ? <Text style={[styles.muted, { paddingHorizontal: 12 }]}>No folders of code found yet.</Text> : null}
      <AreaRows areas={facts.areas} lines={areaLines} busy={busy.files} onOpenArea={onOpenArea} styles={styles} />
    </>
  );
}

function LinkRows({ label, links, pick, onOpenArea, styles }: { label: string; links: { from: string; to: string; count: number }[]; pick: "from" | "to"; onOpenArea(path: string): void; styles: Styles }) {
  if (links.length === 0) return null;
  return (
    <>
      <SectionHeader label={label} count={links.length} styles={styles} />
      {links.map((link) => (
        <ListRow key={link[pick]} title={areaLabel(link[pick])} meta={`${plural(link.count, "file")} link them`} accessibilityLabel={`Open ${areaLabel(link[pick])}`} onPress={() => onOpenArea(link[pick])} styles={styles} />
      ))}
    </>
  );
}

// One area: what it is, what it depends on and what uses it, its key names and files, where it
// changed, and the documents and work in it.
// `onExplain` is null while summaries are off or a background job runs.
export function AreaPage({ repoKey, path, onOpenArea, onBack, onRead, styles, onExplain }: { repoKey: string; path: string; onOpenArea(path: string): void; onBack(): void; onRead(target: ReadTarget): void; styles: Styles; onExplain: (() => void) | null }) {
  const area = useRpc(areaRpc);
  const facts = useFacts(repoKey);
  const query = useQuery({ queryKey: ["contextualise", "knowledge", "area", repoKey, path], queryFn: () => area({ repoKey, path }) });
  const diagram = facts.data ? neighbourDiagram(facts.data.facts, path) : null;
  const data = query.data;
  const pad = { paddingHorizontal: 12 };
  return (
    <>
      <ListRow title="Back" icon={ICONS.back} onPress={onBack} styles={styles} />
      <Text style={[styles.lg, pad]} numberOfLines={1}>
        {areaLabel(path)}
      </Text>
      {query.error ? <StateView state="error" text={errorText(query.error)} styles={styles} /> : null}
      {!data && !query.error ? <StateView state="loading" styles={styles} /> : null}
      {data ? (
        <>
          <Text style={[styles.sm, pad]}>
            {plural(data.area.files, "code file")}
            {data.area.tests > 0 ? ` · ${plural(data.area.tests, "test file")}` : ""} · {data.area.symbols} {data.area.symbols === 1 ? "function or class" : "functions and classes"}
            {data.area.merged.length > 0 ? ` · folders: ${data.area.merged.map(areaLabel).join(", ")}` : ""}
          </Text>
          {data.line ? <Text style={[styles.text, pad]}>{data.line}</Text> : null}
          {data.explanation ? (
            <>
              <SectionHeader label="How it works" action={onExplain ? { label: "Rewrite", onPress: onExplain } : undefined} styles={styles} />
              <Text style={[styles.sm, pad]}>Written by an agent {ago(data.explanation.at)}; may contain mistakes.</Text>
              {/* Written by a model that read repository text, so shown as plain text: no links or images. */}
              <Prose>
                <Text style={[styles.text, pad]} selectable>
                  {data.explanation.body}
                </Text>
              </Prose>
            </>
          ) : onExplain ? (
            <View style={[styles.row, pad]}>
              <Button label="Explain this area" icon={ICONS.knowledge} kind="primary" styles={styles} onPress={onExplain} />
              <Text style={[styles.sm, styles.grow]}>An agent reads this area's facts and writes how it works. Uses one of today's summary runs.</Text>
            </View>
          ) : null}
          {diagram ? <Markdown>{mermaidBlock(diagram)}</Markdown> : null}
          <LinkRows label="Uses" links={data.dependsOn} pick="to" onOpenArea={onOpenArea} styles={styles} />
          <LinkRows label="Used by" links={data.usedBy} pick="from" onOpenArea={onOpenArea} styles={styles} />
          {data.dependsOn.length === 0 && data.usedBy.length === 0 ? <Text style={[styles.muted, pad]}>No imports link this area to the others.</Text> : null}
          {data.area.keyNames.length > 0 ? (
            <>
              <SectionHeader label={data.area.keyNames[0].uses > 0 ? "Key names · what other areas use most" : "Key names · main classes"} styles={styles} />
              {data.area.keyNames.map((key) => (
                <ListRow key={`${key.path}:${key.name}`} title={key.name} meta={[key.kind, `${key.path}:${key.line}`, ...(key.uses > 0 ? [`used in ${plural(key.uses, "file")}`] : [])].join(" · ")} styles={styles} />
              ))}
            </>
          ) : null}
          {data.area.mainFiles.length > 0 ? (
            <>
              <SectionHeader label="Main files · imported by the most files" styles={styles} />
              {data.area.mainFiles.map((file) => (
                <ListRow key={file.path} title={file.path} meta={`used in ${plural(file.usedBy, "file")}`} styles={styles} />
              ))}
            </>
          ) : null}
          {data.busy.length > 0 ? <BusySection files={data.busy} showArea={false} onOpenArea={onOpenArea} styles={styles} /> : null}
          {data.documents.length > 0 ? (
            <>
              <SectionHeader label="Documents here" count={data.documents.length} styles={styles} />
              {data.documents.map((entry) => (
                <ListRow key={entry.id} title={entry.title} meta={entry.path} accessibilityLabel={`Read ${entry.title}`} onPress={() => onRead({ id: entry.id, title: entry.title })} styles={styles} />
              ))}
            </>
          ) : null}
          {data.tasks.length > 0 ? (
            <>
              <SectionHeader label="Recent work here" styles={styles} />
              {data.tasks.map((task) => (
                <TaskRow key={task.id} task={task} onOpen={onRead} styles={styles} />
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

// One finished task: what it was, how it ended, when, and by which agent. Used wherever tasks are
// listed, so they read the same everywhere; pressed, its record opens in the reader.
export function TaskRow({ task, onOpen, styles }: { task: Pick<TaskSummary, "id" | "title" | "generatedTitle" | "outcome" | "endedAt"> & Partial<Pick<TaskSummary, "summary" | "provider" | "needsCheck">>; onOpen(target: ReadTarget): void; styles: Styles }) {
  const title = task.generatedTitle ?? task.title;
  const meta = [task.outcome, ago(task.endedAt), ...(task.provider ? [task.provider] : []), ...(task.needsCheck ? ["needs check"] : [])].join(" · ");
  return <ListRow title={title} meta={meta} accessibilityLabel={`Read ${title}`} onPress={() => onOpen({ id: task.id, title, lead: task.summary })} styles={styles} />;
}
