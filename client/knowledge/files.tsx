import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { codeSymbolKind, fileEntriesRpc, type FileSummary, KIND_LABELS, type KnowledgeKind, knowledgeFilesRpc, type SearchHit } from "../../shared/knowledge";
import { errorText } from "../errors";
import { ICONS } from "../icons";
import { Button, IconButton, ListRow, plural, SectionHeader, StateView, type Styles } from "../kit";
import type { ReadTarget } from "../project-map";
import { fileName, filesByFolder, titlesInFile } from "./text";

type FileKind = Exclude<KnowledgeKind, "task">;
export type Pins = { isPinned(id: string): boolean; setPinned(id: string, pinned: boolean): void };

// Files shown per group before "Show more": enough to scan, short enough to reach the next group.
const FILES_SHOWN = 50;
// An opened file's entries sit under it, indented past the file's own name (its chevron and gap are
// 24 wide), like a Notion toggle's children.
const NESTED = { paddingLeft: 36 };

const unit = (kind: FileKind, count: number) => plural(count, kind === "code" ? "symbol" : "section");

// One entry inside an opened file: its title and line; a code entry also says what it is. The pin
// beside it puts it in the overview agents get.
function EntryRow({ hit, label, pins, onRead, styles }: { hit: SearchHit; label: string; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const pinned = pins.isPinned(hit.id);
  const meta = [...(hit.kind === "code" ? [codeSymbolKind(hit.snippet)] : []), `line ${hit.line}`, ...(hit.needsCheck ? ["needs check"] : [])].join(" · ");
  return (
    <ListRow
      title={label}
      meta={meta}
      accessibilityLabel={`Read ${hit.title}`}
      onPress={() => onRead({ id: hit.id, title: hit.title })}
      trailing={<IconButton icon={pinned ? ICONS.unpin : ICONS.pin} label={`${pinned ? "Unpin" : "Pin"} ${hit.title} ${pinned ? "from" : "to"} the project map`} onPress={() => pins.setPinned(hit.id, !pinned)} styles={styles} />}
      styles={styles}
    />
  );
}

// Code entries keep their names; document sections drop the heading the whole file shares.
function Entries({ hits, kind, pins, onRead, styles }: { hits: SearchHit[]; kind: FileKind; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const labels = kind === "code" ? hits.map((hit) => hit.title) : titlesInFile(hits.map((hit) => hit.title));
  return (
    <>
      {hits.map((hit, index) => (
        <EntryRow key={hit.id} hit={hit} label={labels[index]} pins={pins} onRead={onRead} styles={styles} />
      ))}
    </>
  );
}

// A file's entries, read when it is opened.
function FileEntries({ repoKey, path, kind, pins, onRead, styles }: { repoKey: string; path: string; kind: FileKind; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const read = useRpc(fileEntriesRpc);
  const entries = useQuery({ queryKey: ["contextualise", "knowledge", "file-entries", repoKey, kind, path], queryFn: () => read({ repoKey, path, kind }) });
  return (
    <View style={NESTED}>
      {entries.isPending ? <StateView state="loading" styles={styles} /> : null}
      {entries.error ? <StateView state="error" text={errorText(entries.error)} styles={styles} /> : null}
      {entries.data ? <Entries hits={entries.data.hits} kind={kind} pins={pins} onRead={onRead} styles={styles} /> : null}
      {entries.data && entries.data.total > entries.data.hits.length ? <Text style={[styles.note, { paddingHorizontal: 12 }]}>{`The first ${entries.data.hits.length} of ${entries.data.total}; search finds the rest.`}</Text> : null}
    </View>
  );
}

// One file as a row that opens in place to list its entries.
function FileRow({ repoKey, file, title, kind, pins, onRead, styles }: { repoKey: string; file: FileSummary; title: string; kind: FileKind; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ListRow title={title} meta={unit(kind, file.count)} icon={open ? ICONS.expanded : ICONS.collapsed} accessibilityLabel={`${open ? "Close" : "Open"} ${file.path}, ${unit(kind, file.count)}`} onPress={() => setOpen(!open)} styles={styles} />
      {open ? <FileEntries repoKey={repoKey} path={file.path} kind={kind} pins={pins} onRead={onRead} styles={styles} /> : null}
    </>
  );
}

// A group's files, FILES_SHOWN at a time.
function FileGroup({ repoKey, label, files, kind, short, pins, onRead, styles }: { repoKey: string; label: string; files: readonly FileSummary[]; kind: FileKind; short: boolean; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const [shown, setShown] = useState(FILES_SHOWN);
  return (
    <>
      <SectionHeader label={label} count={files.length} styles={styles} />
      {files.slice(0, shown).map((file) => (
        <FileRow key={file.path} repoKey={repoKey} file={file} title={short ? fileName(file.path) : file.path} kind={kind} pins={pins} onRead={onRead} styles={styles} />
      ))}
      {files.length > shown ? <Button label={`Show ${Math.min(FILES_SHOWN, files.length - shown)} more`} styles={styles} onPress={() => setShown(shown + FILES_SHOWN)} /> : null}
    </>
  );
}

// One kind's files: documents as one group under the kind's name, code as a group per folder.
export function KindFiles({ repoKey, kind, pins, onRead, styles }: { repoKey: string; kind: FileKind; pins: Pins; onRead(target: ReadTarget): void; styles: Styles }) {
  const list = useRpc(knowledgeFilesRpc);
  const files = useQuery({ queryKey: ["contextualise", "knowledge", "files", repoKey, kind], queryFn: () => list({ repoKey, kind }) });
  if (files.isPending) return <StateView state="loading" styles={styles} />;
  if (files.error) return <StateView state="error" text={errorText(files.error)} styles={styles} />;
  const cut = files.data.total > files.data.files.length ? <Text style={[styles.note, { paddingHorizontal: 12 }]}>{`The first ${files.data.files.length} of ${files.data.total} files; search finds the rest.`}</Text> : null;
  if (kind !== "code") return (
    <>
      <FileGroup repoKey={repoKey} label={KIND_LABELS[kind]} files={files.data.files} kind={kind} short={false} pins={pins} onRead={onRead} styles={styles} />
      {cut}
    </>
  );
  return (
    <>
      {filesByFolder(files.data.files).map((group) => (
        <FileGroup key={group.folder} repoKey={repoKey} label={group.folder === "" ? "Top level" : group.folder} files={group.files} kind={kind} short pins={pins} onRead={onRead} styles={styles} />
      ))}
      {cut}
    </>
  );
}
