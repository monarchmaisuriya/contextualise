import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Markdown } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { areaLabel, mermaidBlock, neighbourDiagram, overviewDiagram } from "../shared/diagram";
import { type Area, areaRpc, browseKnowledgeRpc, type BusyFile, type KnowledgeEntry, knowledgeUsageRpc, projectFactsRpc, readKnowledgeRpc, type SearchHit } from "../shared/knowledge";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { ago, Button, Chip, plural, SectionTitle, type Styles } from "./kit";
import { usageLine } from "./usage-line";
import { barsCarryInformation } from "./bars";
import type { TaskSummary } from "../shared/knowledge";

const OVERVIEW_CARDS = 8;
const OVERVIEW_BUSY = 8;
const OUTLINE_SECTIONS = 200;
const FENCE_LANGUAGE: Record<string, string> = { py: "python", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", go: "go" };

export function factsQueryKey(repoKey: string) {
  return ["contextualise", "knowledge", "facts", repoKey];
}

// An entry as people read it: the project's documents as Markdown, code as a highlighted block, and
// text an agent wrote (descriptions, explanations) as plain text, since it may echo injected links.
export function EntryBody({ entry, styles }: { entry: Pick<KnowledgeEntry, "kind" | "path" | "body">; styles: Styles }) {
  if (entry.kind === "brief" || entry.kind === "task") {
    return (
      <Text style={styles.text} selectable>
        {entry.body}
      </Text>
    );
  }
  const language = FENCE_LANGUAGE[entry.path.split(".").pop() ?? ""] ?? "";
  return <Markdown>{entry.kind === "code" ? `\`\`\`${language}\n${entry.body}\n\`\`\`` : entry.body}</Markdown>;
}

// A share of the largest value, drawn as a filled track.
function Bar({ share, styles, tone = "accent" }: { share: number; styles: Styles; tone?: "accent" | "muted" }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: styles.colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(2, Math.round(share * 100))}%`, height: 6, borderRadius: 3, backgroundColor: tone === "accent" ? styles.colors.accent : styles.colors.foregroundMuted }} />
    </View>
  );
}

function languageColors(styles: Styles): string[] {
  return [styles.colors.accent, styles.colors.statusSuccess, styles.colors.statusWarning, styles.colors.statusDanger, styles.colors.foregroundMuted];
}

// Code files by language, as one segmented bar with a legend.
function LanguageBar({ languages, styles }: { languages: Record<string, number>; styles: Styles }) {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const colors = languageColors(styles);
  if (total === 0) return null;
  return (
    <View style={{ gap: 6 }}>
{entries.length > 1 ? (
      <View style={{ flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden", gap: 2 }}>
          {entries.map(([language, count], index) => (
            <View key={language} style={{ flex: count, backgroundColor: colors[index % colors.length] }} />
          ))}
        </View>
      ) : null}
      <View style={styles.wrap}>
        {entries.map(([language, count], index) => (
          <View key={language} style={styles.inline}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors[index % colors.length] }} />
            <Text style={styles.muted}>
              {language} {Math.round((count / total) * 100)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function AreaCard({ area, line, largest, showBar, changes, onOpen, styles }: { area: Area; line: string | undefined; largest: number; showBar: boolean; changes: number; onOpen(): void; styles: Styles }) {
  const size = area.files + area.tests;
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open ${areaLabel(area.path)}`} style={[styles.card, { gap: 6 }]}>
      <View style={styles.row}>
        <Text style={[styles.text, styles.grow, { fontWeight: "600" }]} numberOfLines={1}>
          {areaLabel(area.path)}
        </Text>
        <Text style={styles.faint}>
          {plural(size, "file")}
          {changes > 0 ? ` · ${plural(changes, "change")} lately` : ""}
        </Text>
      </View>
      {line ? (
        <Text style={styles.muted} numberOfLines={2}>
          {line}
        </Text>
      ) : area.keyNames.length > 0 ? (
        <Text style={styles.faint} numberOfLines={1}>
          {area.keyNames
            .slice(0, 4)
            .map((key) => key.name)
            .join(" · ")}
        </Text>
      ) : null}
      {showBar ? <Bar share={size / largest} styles={styles} /> : null}
    </Pressable>
  );
}

export function AreaCards({ areas, lines, changes, limit, onOpen, styles }: { areas: Area[]; lines: Record<string, string>; changes: Map<string, number>; limit?: number; onOpen(path: string): void; styles: Styles }) {
  const largest = Math.max(1, ...areas.map((area) => area.files + area.tests));
  const showBars = barsCarryInformation(areas.slice(0, limit).map((area) => area.files + area.tests));
  return (
    <View style={{ gap: 8 }}>
      {areas.slice(0, limit).map((area) => (
        <AreaCard key={area.path} area={area} line={lines[area.path]} largest={largest} showBar={showBars} changes={changes.get(area.path) ?? 0} onOpen={() => onOpen(area.path)} styles={styles} />
      ))}
    </View>
  );
}

function BusyList({ files, showArea, onOpenArea, styles }: { files: BusyFile[]; showArea: boolean; onOpenArea(path: string): void; styles: Styles }) {
  const most = Math.max(1, ...files.map((file) => file.changes));
  const showBars = barsCarryInformation(files.map((file) => file.changes));
  return (
    <View style={[styles.card, { gap: 10 }]}>
      {files.map((file) => {
        const area = showArea ? file.area : null;
        const row = (
          <>
            {/* The path gets the whole line; on a phone it would otherwise be cut to a few letters. */}
            <Text style={styles.text} numberOfLines={1}>
              {file.path}
            </Text>
            <Text style={styles.faint} numberOfLines={1}>
              {area !== null ? <Text style={styles.link}>{areaLabel(area)} · </Text> : null}
              {plural(file.changes, "change")} · {ago(file.lastAt)}
            </Text>
            {showBars ? <Bar share={file.changes / most} styles={styles} tone="muted" /> : null}
          </>
        );
        return area !== null ? (
          <Pressable key={file.path} style={{ gap: 4 }} onPress={() => onOpenArea(area)} accessibilityRole="button" accessibilityLabel={`${file.path}; open ${areaLabel(area)}`}>
            {row}
          </Pressable>
        ) : (
          <View key={file.path} style={{ gap: 4 }}>
            {row}
          </View>
        );
      })}
    </View>
  );
}

// One document section: its heading; pressed, its text.
function SectionRow({ repoKey, hit, styles }: { repoKey: string; hit: SearchHit; styles: Styles }) {
  const [open, setOpen] = useState(false);
  const read = useRpc(readKnowledgeRpc);
  const entry = useQuery({ queryKey: ["contextualise", "knowledge", "read", repoKey, hit.id], queryFn: () => read({ repoKey, id: hit.id }), enabled: open });
  // Titles carry the headings above a section; the first is the document's own title.
  const trail = hit.title.split(" > ");
  const heading = trail.length > 1 ? trail.slice(1).join(" > ") : trail[0];
  return (
    <View style={{ gap: 4 }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityLabel={`${open ? "Close" : "Open"} ${heading}`} style={styles.inline}>
        <Icon name={open ? ICONS.expanded : ICONS.collapsed} size={14} color={styles.colors.foregroundMuted} />
        <Text style={[styles.text, styles.grow]} numberOfLines={open ? undefined : 1}>
          {heading}
        </Text>
      </Pressable>
      {open ? entry.error ? <Text style={styles.danger}>{errorText(entry.error)}</Text> : entry.data ? <EntryBody entry={entry.data} styles={styles} /> : <Text style={styles.muted}>Loading</Text> : null}
    </View>
  );
}

// Each file of one kind with its section headings; a heading opens its text.
function DocumentOutline({ repoKey, kind, label, styles }: { repoKey: string; kind: "convention" | "architecture" | "adr"; label: string; styles: Styles }) {
  const browse = useRpc(browseKnowledgeRpc);
  const rules = useQuery({ queryKey: ["contextualise", "knowledge", "browse", repoKey, kind, "outline"], queryFn: () => browse({ repoKey, kind, limit: OUTLINE_SECTIONS, offset: 0 }) });
  const files = new Map<string, SearchHit[]>();
  for (const hit of rules.data?.hits ?? []) files.set(hit.path, [...(files.get(hit.path) ?? []), hit]);
  if (files.size === 0) return null;
  return (
    <>
      <SectionTitle label={label} count={rules.data?.total} styles={styles} />
      {[...files.entries()].map(([path, hits]) => (
        <View key={path} style={styles.card}>
          <Text style={[styles.text, { fontWeight: "600" }]}>{path}</Text>
          {hits.map((hit) => (
            <SectionRow key={hit.id} repoKey={repoKey} hit={hit} styles={styles} />
          ))}
        </View>
      ))}
    </>
  );
}

function useFacts(repoKey: string) {
  const facts = useRpc(projectFactsRpc);
  return useQuery({ queryKey: factsQueryKey(repoKey), queryFn: () => facts({ repoKey }) });
}

function changesByArea(files: BusyFile[]): Map<string, number> {
  const changes = new Map<string, number>();
  for (const file of files) if (file.area !== null) changes.set(file.area, (changes.get(file.area) ?? 0) + file.changes);
  return changes;
}

// The overview: numbers and languages, the areas and how they connect, where work happened lately,
// and the design documents, decisions, and team rules by heading.
// How agents used this project's knowledge lately; nothing until an agent has been given it, and
// nothing if the count cannot be read (it is advisory).
function UsageNote({ repoKey, styles }: { repoKey: string; styles: Styles }) {
  const usage = useRpc(knowledgeUsageRpc);
  const query = useQuery({ queryKey: ["contextualise", "knowledge", "usage", repoKey], queryFn: () => usage({ repoKey }) });
  const line = query.data ? usageLine(query.data) : null;
  return line ? <Text style={styles.muted}>{line}</Text> : null;
}

export function ProjectOverview({ repoKey, onOpenArea, onShowAreas, styles }: { repoKey: string; onOpenArea(path: string): void; onShowAreas(): void; styles: Styles }) {
  const query = useFacts(repoKey);
  if (query.error) return <Text style={styles.danger}>{errorText(query.error)}</Text>;
  if (!query.data) return <Text style={styles.muted}>Reading the project</Text>;
  const { facts, busy, areaLines } = query.data;
  const diagram = overviewDiagram(facts);
  const changes = changesByArea(busy.files);
  return (
    <>
      <UsageNote repoKey={repoKey} styles={styles} />
      <SectionTitle label="At a glance" styles={styles} />
      <View style={styles.card}>
        <Text style={styles.text}>
          {plural(facts.codeFiles, "code file")} in {plural(facts.areas.length, "area")}
          {facts.testFiles > 0 ? `, and ${plural(facts.testFiles, "test file")}` : ""}
        </Text>
        <LanguageBar languages={facts.languages} styles={styles} />
        {facts.libraries.length > 0 ? (
          <>
            <Text style={styles.faint}>Most used libraries, by files that use them</Text>
            {/* Plain text, not chips: these are facts, not buttons. */}
            <Text style={styles.text}>{facts.libraries.map((library) => `${library.name} ${library.files}`).join(" · ")}</Text>
          </>
        ) : null}
      </View>
      {facts.areas.length > 0 ? (
        <>
          <View style={styles.row}>
            <SectionTitle label="How the parts connect" count={facts.areas.length} styles={styles} />
            <View style={styles.grow} />
            {facts.areas.length > OVERVIEW_CARDS ? <Button label={`All ${facts.areas.length} areas`} styles={styles} onPress={onShowAreas} /> : null}
          </View>
          {diagram ? (
            <View style={{ gap: 4 }}>
              <Markdown>{mermaidBlock(diagram)}</Markdown>
              <Text style={styles.faint}>Each box is a folder of code; an arrow means its files import the other's. Thicker arrows mean more files.</Text>
            </View>
          ) : null}
          <AreaCards areas={facts.areas} lines={areaLines} changes={changes} limit={OVERVIEW_CARDS} onOpen={onOpenArea} styles={styles} />
        </>
      ) : null}
      <SectionTitle label="Busy lately" hint={busy.available ? `last ${busy.days} days` : undefined} styles={styles} />
      {busy.problem ? <Text style={styles.danger}>{busy.problem}</Text> : null}
      {!busy.available && !busy.problem ? <Text style={styles.muted}>Change history needs git; this folder is not in a git repository.</Text> : null}
      {busy.available && busy.files.length === 0 ? <Text style={styles.muted}>Nothing changed in the last {busy.days} days.</Text> : null}
      {busy.files.length > 0 ? <BusyList files={busy.files.slice(0, OVERVIEW_BUSY)} showArea onOpenArea={onOpenArea} styles={styles} /> : null}
      <DocumentOutline repoKey={repoKey} kind="architecture" label="Design" styles={styles} />
      <DocumentOutline repoKey={repoKey} kind="adr" label="Decisions" styles={styles} />
      <DocumentOutline repoKey={repoKey} kind="convention" label="Team rules at a glance" styles={styles} />
    </>
  );
}

// Every area, biggest first.
export function AreaList({ repoKey, onOpenArea, styles }: { repoKey: string; onOpenArea(path: string): void; styles: Styles }) {
  const query = useFacts(repoKey);
  if (query.error) return <Text style={styles.danger}>{errorText(query.error)}</Text>;
  if (!query.data) return <Text style={styles.muted}>Reading the project</Text>;
  const { facts, busy, areaLines } = query.data;
  return (
    <>
      <SectionTitle label="Areas" count={facts.areas.length} hint="folders of code, biggest first" styles={styles} />
      <AreaCards areas={facts.areas} lines={areaLines} changes={changesByArea(busy.files)} onOpen={onOpenArea} styles={styles} />
    </>
  );
}

function AreaChips({ label, links, pick, onOpenArea, styles }: { label: string; links: { from: string; to: string; count: number }[]; pick: "from" | "to"; onOpenArea(path: string): void; styles: Styles }) {
  if (links.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.faint}>{label}</Text>
      <View style={styles.wrap}>
        {links.map((link) => (
          <Chip key={link[pick]} label={`${areaLabel(link[pick])} ${link.count}`} onPress={() => onOpenArea(link[pick])} accessibilityLabel={`Open ${areaLabel(link[pick])}, ${plural(link.count, "file")} link them`} styles={styles} />
        ))}
      </View>
    </View>
  );
}

// One area: what it is, what it depends on and what uses it, its key names and files, where it
// changed, and the documents and work in it.
// `onExplain` is null while summaries are off or a background job runs.
export function AreaPage({ repoKey, path, onOpenArea, onBack, styles, onExplain }: { repoKey: string; path: string; onOpenArea(path: string): void; onBack(): void; styles: Styles; onExplain: (() => void) | null }) {
  const area = useRpc(areaRpc);
  const facts = useFacts(repoKey);
  const query = useQuery({ queryKey: ["contextualise", "knowledge", "area", repoKey, path], queryFn: () => area({ repoKey, path }) });
  const [open, setOpen] = useState<string | null>(null);
  const read = useRpc(readKnowledgeRpc);
  const document = useQuery({ queryKey: ["contextualise", "knowledge", "read", repoKey, open], queryFn: () => read({ repoKey, id: open ?? "" }), enabled: open !== null });
  const diagram = facts.data ? neighbourDiagram(facts.data.facts, path) : null;
  const data = query.data;
  return (
    <>
      <View style={styles.row}>
        <Button label="Back" icon={ICONS.back} styles={styles} onPress={onBack} />
        <Text style={[styles.title, styles.grow]} numberOfLines={1}>
          {areaLabel(path)}
        </Text>
      </View>
      {query.error ? <Text style={styles.danger}>{errorText(query.error)}</Text> : null}
      {data ? (
        <>
          <View style={styles.card}>
            {data.line ? <Text style={styles.text}>{data.line}</Text> : null}
            <Text style={styles.faint}>
              {plural(data.area.files, "code file")}
              {data.area.tests > 0 ? ` · ${plural(data.area.tests, "test file")}` : ""} · {data.area.symbols} {data.area.symbols === 1 ? "function or class" : "functions and classes"}
              {data.area.merged.length > 0 ? ` · folders: ${data.area.merged.map(areaLabel).join(", ")}` : ""}
            </Text>
          </View>
          {data.explanation ? (
            <View style={styles.card}>
              <View style={styles.row}>
                <View style={styles.grow}>
                  <SectionTitle label="How it works" hint={`written by an agent ${ago(data.explanation.at)}; may contain mistakes`} styles={styles} />
                </View>
                {onExplain ? <Button label="Rewrite" icon={ICONS.knowledge} styles={styles} onPress={onExplain} /> : null}
              </View>
              {/* Written by a model that read repository text, so shown as plain text: no links or images. */}
              <Text style={styles.text} selectable>
                {data.explanation.body}
              </Text>
            </View>
          ) : onExplain ? (
            <View style={styles.row}>
              <Button label="Explain this area" icon={ICONS.knowledge} kind="primary" styles={styles} onPress={onExplain} />
              <Text style={[styles.faint, styles.grow]}>An agent reads this area's facts and writes how it works. Uses one of today's summary runs.</Text>
            </View>
          ) : null}
          {diagram ? <Markdown>{mermaidBlock(diagram)}</Markdown> : null}
          <View style={[styles.card, { gap: 10 }]}>
            <AreaChips label="Uses" links={data.dependsOn} pick="to" onOpenArea={onOpenArea} styles={styles} />
            <AreaChips label="Used by" links={data.usedBy} pick="from" onOpenArea={onOpenArea} styles={styles} />
            {data.dependsOn.length === 0 && data.usedBy.length === 0 ? <Text style={styles.muted}>No imports link this area to the others.</Text> : null}
          </View>
          {data.area.keyNames.length > 0 ? (
            <>
              <SectionTitle label="Key names" hint={data.area.keyNames[0].uses > 0 ? "what other areas use most" : "main classes"} styles={styles} />
              <View style={styles.card}>
                {data.area.keyNames.map((key) => (
                  <View key={`${key.path}:${key.name}`} style={styles.row}>
                    <Text style={[styles.text, styles.grow]} numberOfLines={1}>
                      {key.name} <Text style={styles.faint}>{key.kind}</Text>
                    </Text>
                    <Text style={styles.faint} numberOfLines={1}>
                      {key.path}:{key.line}
                      {key.uses > 0 ? ` · used in ${plural(key.uses, "file")}` : ""}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {data.area.mainFiles.length > 0 ? (
            <>
              <SectionTitle label="Main files" hint="imported by the most files" styles={styles} />
              <View style={styles.card}>
                {data.area.mainFiles.map((file) => (
                  <View key={file.path} style={styles.row}>
                    <Text style={[styles.text, styles.grow]} numberOfLines={1}>
                      {file.path}
                    </Text>
                    <Text style={styles.faint}>used in {plural(file.usedBy, "file")}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {data.busy.length > 0 ? (
            <>
              <SectionTitle label="Busy lately" styles={styles} />
              <BusyList files={data.busy} showArea={false} onOpenArea={onOpenArea} styles={styles} />
            </>
          ) : null}
          {data.documents.length > 0 ? (
            <>
              <SectionTitle label="Documents here" count={data.documents.length} styles={styles} />
              <View style={styles.card}>
                {data.documents.map((entry) => (
                  <View key={entry.id} style={{ gap: 4 }}>
                    <Pressable onPress={() => setOpen(open === entry.id ? null : entry.id)} accessibilityRole="button" accessibilityLabel={`${open === entry.id ? "Close" : "Open"} ${entry.title}`}>
                      <Text style={styles.text} numberOfLines={1}>
                        {entry.title} <Text style={styles.faint}>{entry.path}</Text>
                      </Text>
                    </Pressable>
                    {open === entry.id && document.data ? <EntryBody entry={document.data} styles={styles} /> : null}
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {data.tasks.length > 0 ? (
            <>
              <SectionTitle label="Recent work here" styles={styles} />
              <View style={styles.card}>
                {data.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} styles={styles} />
                ))}
              </View>
            </>
          ) : null}
        </>
      ) : !query.error ? (
        <Text style={styles.muted}>Reading the area</Text>
      ) : null}
    </>
  );
}

// One finished task: what it was, how it ended, and the files it changed. Used wherever tasks are
// listed, so they read the same everywhere.
export function TaskRow({ task, styles }: { task: Pick<TaskSummary, "title" | "generatedTitle" | "outcome" | "endedAt" | "files"> & Partial<Pick<TaskSummary, "summary" | "provider" | "needsCheck">>; styles: Styles }) {
  return (
    <View style={{ gap: 2, paddingVertical: 4 }}>
      <View style={styles.row}>
        <Text style={[styles.text, styles.grow]} numberOfLines={1}>
          {task.generatedTitle ?? task.title}
        </Text>
        <Text style={task.outcome === "completed" ? styles.faint : styles.warning}>{task.outcome}</Text>
      </View>
      {task.summary ? (
        <Text style={styles.muted} numberOfLines={3}>
          {task.summary}
        </Text>
      ) : null}
      <Text style={styles.faint} numberOfLines={1}>
        {ago(task.endedAt)}
        {task.provider ? ` · ${task.provider}` : ""}
        {task.files.length > 0 ? ` · ${task.files.slice(0, 3).join(", ")}${task.files.length > 3 ? `, +${task.files.length - 3}` : ""}` : ""}
        {task.needsCheck ? <Text style={styles.warning}> · needs check</Text> : null}
      </Text>
    </View>
  );
}
