import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { contextActivityRpc, contextRecordingRpc, prepareContextRpc, type ContextMode } from "../shared/context";
import { searchKnowledgeRpc } from "../shared/knowledge";
import { activityTotals, sizeLine, SOURCE_LABELS, unexpiredEvents } from "./context-text";
import { errorText } from "./errors";
import { Button, Chip, ListRow, ReaderSheet, SearchField, SectionHeader, Segmented, StateView, type Styles } from "./kit";

const pad = { paddingHorizontal: 12 };
const MODES = [{ value: "overview", label: "Overview" }, { value: "selected", label: "Selected entries" }, { value: "full", label: "Full project" }] as const;

export function ContextView({ repoKey, styles }: { repoKey: string; styles: Styles }) {
  const [mode, setMode] = useState<ContextMode>("overview");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ id: string; title: string }[]>([]);
  const [preview, setPreview] = useState(false);
  const prepare = useRpc(prepareContextRpc);
  const search = useRpc(searchKnowledgeRpc);
  const toast = useToast();
  const prepared = useQuery({ queryKey: ["contextualise", "prepare", repoKey, mode, selected.map((entry) => entry.id)], queryFn: () => prepare({ repoKey, mode, ids: selected.map((entry) => entry.id) }), enabled: mode !== "selected" || selected.length > 0, retry: false, staleTime: 30_000 });
  const hits = useQuery({ queryKey: ["contextualise", "context-select", repoKey, query], queryFn: () => search({ repoKey, query, kinds: [], limit: 20 }), enabled: mode === "selected" && query.trim() !== "" });
  const r = prepared.data?.receipt;
  return <>
    <View style={[pad, { gap: 8, marginTop: 16 }]}>
      <Text style={styles.title}>Prepare context</Text>
      <Text style={styles.muted}>Prepare only what the next conversation needs. Sizes describe Contextualise's text, not the provider's full prompt or bill.</Text>
    </View>
    <View style={[pad, { gap: 12 }]}>
      <Segmented<ContextMode> options={MODES} value={mode} onChange={setMode} label="Context to prepare" styles={styles} />
      <Text style={styles.note}>{mode === "overview" ? "A short project map. Search tools can retrieve the details later." : mode === "full" ? "The project description, areas, rules, architecture, active decisions and recent work. Whole documents that do not fit are named." : "Choose up to 20 specific entries. Nothing else is silently substituted."}</Text>
      {mode === "selected" ? <>
        <SearchField value={query} onChange={setQuery} placeholder="Find documents, code or past work" label="Find context entries" styles={styles} />
        <View style={styles.wrap}>{selected.map((entry) => <Chip key={entry.id} label={entry.title} on onPress={() => setSelected(selected.filter((item) => item.id !== entry.id))} accessibilityLabel={`Remove ${entry.title}`} styles={styles} />)}</View>
        {hits.isFetching ? <StateView state="loading" styles={styles} /> : null}
        {hits.error ? <StateView state="error" text={errorText(hits.error)} styles={styles} /> : null}
        {hits.data?.hits.filter((hit) => !selected.some((entry) => entry.id === hit.id)).map((hit) => <ListRow key={hit.id} title={hit.title} meta={hit.path} onPress={() => setSelected([...selected, { id: hit.id, title: hit.title }])} disabled={selected.length >= 20} accessibilityLabel={`Add ${hit.title}`} styles={styles} />)}
        {query.trim() && hits.data?.hits.length === 0 ? <Text style={styles.note}>No entries match. Try fewer words.</Text> : null}
      </> : null}
      {mode === "selected" && selected.length === 0 ? <Text style={styles.muted}>Add an entry to prepare selected context.</Text> : prepared.isPending ? <StateView state="loading" styles={styles} /> : null}
      {prepared.error ? <><StateView state="error" text={errorText(prepared.error)} styles={styles} /><Button label="Retry preparation" onPress={() => void prepared.refetch()} styles={styles} /></> : null}
      {r && (mode !== "selected" || selected.length > 0) ? <View style={{ gap: 8, padding: 16, borderWidth: 1, borderColor: styles.colors.border, borderRadius: 10, backgroundColor: styles.colors.surface1 }}>
        <Text style={styles.heading}>Prepared attachment</Text>
        <Text style={styles.body}>{sizeLine(r)}</Text>
        <Text style={styles.note}>{r.included} included · {r.omitted} omitted · {r.freshness}. This is a preview, not proof that a model received it.</Text>
        {prepared.data?.omissions.length ? <Text style={styles.note}>Not included: {prepared.data.omissions.join(", ")}</Text> : null}
        <View style={styles.wrap}>
          <Button label="Copy prepared context" kind="primary" onPress={() => { if (prepared.data) void copyText(prepared.data.text).then(() => toast.show("Prepared context copied", { variant: "success" }), (error) => toast.error(errorText(error))); }} styles={styles} />
          <Button label="Read preview" onPress={() => setPreview(true)} styles={styles} />
          <Button label={prepared.isFetching ? "Refreshing…" : "Refresh"} disabled={prepared.isFetching} onPress={() => void prepared.refetch()} styles={styles} />
        </View>
      </View> : null}
      <Text style={styles.note}>You can also choose Full project or Overview from Attach &gt; Project. Copying here does not attach a workspace until its grant is used in a supported chat flow.</Text>
    </View>
    {preview && prepared.data ? <ReaderSheet title="Prepared context" text={prepared.data.text} meta={sizeLine(prepared.data.receipt)} plain onClose={() => setPreview(false)} styles={styles} /> : null}
  </>;
}

export function DiagnosticsView({ repoKey, styles }: { repoKey: string; styles: Styles }) {
  const [allHost, setAllHost] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const getActivity = useRpc(contextActivityRpc);
  const recording = useRpc(contextRecordingRpc);
  const toast = useToast();
  const client = useQueryClient();
  const activity = useQuery({ queryKey: ["contextualise", "activity", allHost ? "host" : repoKey], queryFn: () => getActivity(allHost ? {} : { repoKey }), refetchInterval: (state) => state.state.data?.recording || state.state.data?.events.length ? 3_000 : false });
  const control = useMutation({ mutationFn: recording, onSuccess: () => { void client.invalidateQueries({ queryKey: ["contextualise", "activity"] }); }, onError: (error) => toast.error(errorText(error)) });
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const next = Math.min(...(activity.data?.events ?? []).map((event) => Date.parse(event.at) + 30 * 60_000).filter((at) => at > Date.now()));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(1, next - Date.now()));
    return () => clearTimeout(timer);
  }, [activity.data, clock]);
  const events = unexpiredEvents(activity.data?.events ?? [], Math.max(clock, Date.now()));
  const totals = activityTotals(events);
  return <>
    <SectionHeader label="Retrieval diagnostics" styles={styles} />
    <View style={[pad, { gap: 12 }]}>
      <View style={styles.wrap}>
        <Button label={activity.data?.recording ? "Stop recording" : "Start recording"} kind="primary" disabled={control.isPending} onPress={() => control.mutate({ action: activity.data?.recording ? "stop" : "start" })} styles={styles} />
        <Button label="Clear diagnostics" disabled={control.isPending} onPress={() => control.mutate({ action: "clear" })} styles={styles} />
        <Button label="Refresh activity" onPress={() => void activity.refetch()} styles={styles} />
      </View>
      <Text style={styles.note}>{activity.data?.recording ? "Recording on this host. Other connected clients share this switch." : "Recording is off. Start explicitly to inspect new activity."} No conversation text or search queries are stored. Up to 200 events expire after 30 minutes; restart clears them. Physical cleanup can wait while the host is suspended.</Text>
      <Segmented options={[{ value: "project", label: "This project" }, { value: "host", label: "All host activity" }]} value={allHost ? "host" : "project"} onChange={(value) => setAllHost(value === "host")} label="Activity scope" styles={styles} />
      {activity.error ? <StateView state="error" text={errorText(activity.error)} styles={styles} /> : null}
      <Text style={styles.body}>{totals.calls} retrieval calls · {totals.empty} empty · {totals.failed} failed · {totals.repeated} same results observed again</Text>
      <Text style={styles.note}>Retained events only · {totals.bytes.toLocaleString("en-US")} bytes · median handler time {totals.medianMs === null ? "unavailable" : `${Math.round(totals.medianMs)} ms`}{activity.data?.evicted ? ` · ${activity.data.evicted} older events evicted` : ""}. A repeated read may be necessary after compaction.</Text>
    </View>
    <SectionHeader label="Latest activity" count={events.length} styles={styles} />
    {events.length === 0 ? <Text style={[styles.muted, pad]}>No retained activity in this scope. Attachments without a project are visible under All host activity.</Text> : null}
    {events.map((event) => <View key={event.id}>
      <ListRow title={event.tool ?? SOURCE_LABELS[event.source]} meta={`${event.state} · ~${event.tokens} tokens · ${event.outcome}`} onPress={() => setExpanded(expanded === event.id ? null : event.id)} accessibilityLabel={`${event.tool ?? SOURCE_LABELS[event.source]}, ${event.state}, ${event.tokens} estimated tokens; show details`} styles={styles} />
      {expanded === event.id ? <Text style={[styles.note, pad, { paddingBottom: 12 }]}>{sizeLine(event)}{"\n"}{event.at} · {event.included} included · {event.omitted} omitted{event.repeated ? " · same result observed again" : ""}{event.durationMs === null ? "" : ` · ${Math.round(event.durationMs)} ms handler time`}</Text> : null}
    </View>)}
  </>;
}
