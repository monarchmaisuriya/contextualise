import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { areaLabel } from "../../shared/diagram";
import { knowledgeAgentsNowRpc, knowledgeChangesRpc, knowledgePulseRpc, PULSE_DAYS } from "../../shared/knowledge";
import { errorText } from "../errors";
import { ICONS } from "../icons";
import { DayBars, ListRow, SectionHeader, Segmented, StateView, type Styles } from "../kit";
import { HEADING_SPACE } from "../parts/rules";
import { attentionRow, attentionRows, hotspotMeta, periodSummary } from "./pulse-text";

export type Navigation = PluginScreenProps["navigation"];
type Days = (typeof PULSE_DAYS)[number];

// The window last chosen, per host (or for workspace tabs), so the screen opens where it was left.
const lastDays = new Map<string, Days>();
// Agents change state while the screen is open, and reading them is cheap; the rest is read on open.
const AGENTS_REFRESH_MS = 15_000;
const pad = { paddingHorizontal: 12 };

// The project's recent life, read once for the overview's sections: agents now, agent work, and git
// changes over the chosen days. Each answer arrives on its own; the git one can take longer.
export function usePulse(repoKey: string, hostKey: string) {
  const [days, setDays] = useState<Days>(lastDays.get(hostKey) ?? 7);
  useEffect(() => {
    lastDays.set(hostKey, days);
  }, [hostKey, days]);
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  const getAgents = useRpc(knowledgeAgentsNowRpc);
  const getPulse = useRpc(knowledgePulseRpc);
  const getChanges = useRpc(knowledgeChangesRpc);
  const agents = useQuery({ queryKey: ["contextualise", "knowledge", "agents-now", repoKey], queryFn: () => getAgents({ repoKey }), refetchInterval: AGENTS_REFRESH_MS });
  const pulse = useQuery({ queryKey: ["contextualise", "knowledge", "pulse", repoKey, days, utcOffsetMinutes], queryFn: () => getPulse({ repoKey, days, utcOffsetMinutes }) });
  const changes = useQuery({ queryKey: ["contextualise", "knowledge", "changes", repoKey, days, utcOffsetMinutes], queryFn: () => getChanges({ repoKey, days, utcOffsetMinutes }) });
  return { days, setDays, agents, pulse, changes };
}
export type PulseData = ReturnType<typeof usePulse>;

// Agents waiting for M and recent failures; nothing at all when nothing needs M.
export function NeedsYou({ data, navigation, onReadTask, styles }: { data: PulseData; navigation: Navigation; onReadTask(id: string, title: string): void; styles: Styles }) {
  const attention = attentionRows(data.agents.data?.waiting ?? [], data.pulse.data?.failures ?? []);
  if (attention.length === 0) return null;
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : null;
  return (
    <>
      <SectionHeader label="Needs you" count={attention.length} styles={styles} />
      {attention.map((item) => {
        const row = attentionRow(item);
        const onPress = item.kind === "agent" ? (openAgent ? () => openAgent(item.agentId) : undefined) : () => onReadTask(item.taskId, item.title);
        return <ListRow key={item.kind === "agent" ? item.agentId : item.taskId} title={row.title} meta={row.meta} icon={row.danger ? ICONS.failed : ICONS.agent} danger={row.danger} onPress={onPress} styles={styles} />;
      })}
    </>
  );
}

// The chosen days in a few sentences, with a strip per day for the series that has something in it.
export function Period({ data, styles }: { data: PulseData; styles: Styles }) {
  const { days, setDays, agents, pulse, changes } = data;
  const summary = periodSummary({
    days,
    agents: agents.data,
    work: pulse.data?.agentWork,
    changes: changes.data ? { ...changes.data, hotspots: changes.data.hotspots.length } : undefined,
  });
  const work = pulse.data?.agentWork;
  const tasks = work ? work.done + work.failed + work.canceled : 0;
  const commits = changes.data?.available ? changes.data.commits : 0;
  return (
    <>
      <View style={[styles.row, pad, { marginTop: HEADING_SPACE.above, marginBottom: HEADING_SPACE.below }]}>
        <Text style={[styles.heading, styles.grow]} accessibilityRole="header">
          {days === 7 ? "This week" : `Last ${days} days`}
        </Text>
        <Segmented options={PULSE_DAYS.map((value) => ({ label: `${value} days`, value: String(value) }))} value={String(days)} onChange={(value) => setDays(Number(value) as Days)} label="Days shown" styles={styles} />
      </View>
      {summary ? <Text style={[styles.body, pad]}>{summary}</Text> : null}
      {pulse.isPending || changes.isPending ? <StateView state="loading" styles={styles} /> : null}
      {pulse.error ? <StateView state="error" text={errorText(pulse.error)} styles={styles} /> : null}
      {changes.error ? <StateView state="error" text={errorText(changes.error)} styles={styles} /> : null}
      {agents.error ? <StateView state="error" text={errorText(agents.error)} styles={styles} /> : null}
      {tasks > 0 || commits > 0 ? (
        <View style={[pad, { gap: 10, marginTop: 8 }]}>
          {work && tasks > 0 ? <DayBars label="Agent tasks" counts={work.perDay.counts} total={`${tasks}`} color={styles.colors.foreground} styles={styles} /> : null}
          {changes.data?.available && commits > 0 ? <DayBars label="Commits" counts={changes.data.perDay.counts} total={`${commits}${changes.data.commitsTruncated ? "+" : ""}`} color={styles.colors.foregroundMuted} styles={styles} /> : null}
          <View style={styles.row}>
            <Text style={[styles.note, styles.grow]}>{days - 1} days ago</Text>
            <Text style={styles.note}>today</Text>
          </View>
        </View>
      ) : null}
    </>
  );
}

// Where to start reading: the README's opening, then the files the most code uses.
export function StartHere({ data, onReadIntro, onOpenFile, styles }: { data: PulseData; onReadIntro(): void; onOpenFile(path: string): void; styles: Styles }) {
  const pulse = data.pulse.data;
  if (!pulse || (!pulse.readme && pulse.startHere.length === 0)) return null;
  return (
    <>
      <SectionHeader label="Start here" styles={styles} />
      {pulse.readme ? <ListRow title={pulse.readme} meta="What the project says about itself" onPress={onReadIntro} styles={styles} /> : null}
      {pulse.startHere.map((file) => (
        <ListRow key={file.path} title={file.path} meta={[...(file.area !== null ? [areaLabel(file.area)] : []), `used by ${file.usedBy}`].join(" · ")} onPress={() => onOpenFile(file.path)} styles={styles} />
      ))}
    </>
  );
}

// Code changed in the chosen days, ranked by changes times the files that use it.
export function RiskyFiles({ data, onOpenFile, styles }: { data: PulseData; onOpenFile(path: string): void; styles: Styles }) {
  const changes = data.changes.data;
  if (!changes || changes.hotspots.length === 0) return null;
  return (
    <>
      <SectionHeader label="Risky to change" styles={styles} />
      <Text style={[styles.note, pad]}>Changed in these {data.days} days, ranked by changes times the files that use them.</Text>
      {changes.hotspots.map((hotspot) => (
        <ListRow key={hotspot.path} title={hotspot.path} meta={hotspotMeta(hotspot)} onPress={() => onOpenFile(hotspot.path)} styles={styles} />
      ))}
    </>
  );
}
