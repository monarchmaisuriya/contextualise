import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { areaLabel } from "../../shared/diagram";
import { knowledgeAgentsNowRpc, knowledgeChangesRpc, knowledgePulseRpc, PULSE_DAYS } from "../../shared/knowledge";
import { errorText } from "../errors";
import { ICONS } from "../icons";
import { DayBars, ListRow, SectionHeader, Segmented, StateView, type Styles, Tile } from "../kit";
import { agentsTile, attentionRow, attentionRows, changesTile, hotspotMeta, riskTile, workTile } from "./pulse-text";

export type Navigation = PluginScreenProps["navigation"];
type Days = (typeof PULSE_DAYS)[number];
type PulseTarget = "tasks" | "areas";

// The window last chosen, per host (or for workspace tabs), so the screen opens where it was left.
const lastDays = new Map<string, Days>();
// Agents change state while the screen is open, and reading them is cheap; the rest is read on open.
const AGENTS_REFRESH_MS = 15_000;
const pad = { paddingHorizontal: 12 };

// The top of the overview: what needs M now, four numbers, activity by day, the files most risky to
// change, and where to start reading. Each part paints as soon as its own answer arrives: the git
// part can take longer than the rest.
export function Pulse({ repoKey, hostKey, navigation, onReadTask, onReadReadme, onOpenFile, onShow, styles }: { repoKey: string; hostKey: string; navigation: Navigation; onReadTask(id: string, title: string): void; onReadReadme(): void; onOpenFile(path: string): void; onShow(view: PulseTarget): void; styles: Styles }) {
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

  const attention = attentionRows(agents.data?.waiting ?? [], pulse.data?.failures ?? []);
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : null;
  return (
    <>
      {attention.length > 0 ? (
        <>
          <SectionHeader label="Needs you" count={attention.length} styles={styles} />
          {attention.map((item) => {
            const row = attentionRow(item);
            const onPress = item.kind === "agent" ? (openAgent ? () => openAgent(item.agentId) : undefined) : () => onReadTask(item.taskId, item.title);
            return <ListRow key={item.kind === "agent" ? item.agentId : item.taskId} title={row.title} meta={row.meta} icon={row.danger ? ICONS.failed : ICONS.agent} danger={row.danger} onPress={onPress} styles={styles} />;
          })}
        </>
      ) : null}

      <View style={[styles.row, pad, { marginTop: 8 }]}>
        <Text style={[styles.section, styles.grow, { marginTop: 0 }]} accessibilityRole="header">
          Pulse
        </Text>
        <Segmented options={PULSE_DAYS.map((value) => ({ label: `${value} days`, value: String(value) }))} value={String(days)} onChange={(value) => setDays(Number(value) as Days)} label="Days shown" styles={styles} />
      </View>
      {pulse.error ? <StateView state="error" text={errorText(pulse.error)} styles={styles} /> : null}
      {agents.error ? <StateView state="error" text={errorText(agents.error)} styles={styles} /> : null}
      <View style={[styles.wrap, pad, { gap: 8 }]}>
        {agents.data ? <Tile label="Agents now" text={agentsTile(agents.data)} styles={styles} /> : null}
        {pulse.data ? <Tile label="Agent work" text={workTile(pulse.data.agentWork)} onPress={() => onShow("tasks")} styles={styles} /> : null}
        {changes.data ? (
          <>
            <Tile label="Changes" text={changesTile(changes.data)} onPress={changes.data.available ? () => onShow("areas") : undefined} styles={styles} />
            <Tile label="Risk" text={riskTile({ untested: changes.data.untested, hotspots: changes.data.hotspots.length, analysed: changes.data.analysed })} styles={styles} />
          </>
        ) : null}
      </View>
      {pulse.isPending || changes.isPending ? <StateView state="loading" styles={styles} /> : null}

      {pulse.data || changes.data?.available ? (
        <View style={[pad, { gap: 10, marginTop: 4 }]}>
          {pulse.data ? <DayBars label="Agent tasks" counts={pulse.data.agentWork.perDay.counts} total={`${pulse.data.agentWork.done + pulse.data.agentWork.failed + pulse.data.agentWork.canceled}`} color={styles.colors.foreground} styles={styles} /> : null}
          {changes.data?.available ? <DayBars label="Commits" counts={changes.data.perDay.counts} total={`${changes.data.commits}${changes.data.commitsTruncated ? "+" : ""}`} color={styles.colors.foregroundMuted} styles={styles} /> : null}
          <View style={styles.row}>
            <Text style={[styles.sm, styles.grow]}>{days - 1} days ago</Text>
            <Text style={styles.sm}>today</Text>
          </View>
        </View>
      ) : null}

      {changes.error ? <StateView state="error" text={errorText(changes.error)} styles={styles} /> : null}
      {changes.data && changes.data.hotspots.length > 0 ? (
        <>
          <SectionHeader label="Risky to change" styles={styles} />
          <Text style={[styles.sm, pad]}>Code changed in these {days} days, ranked by changes times the files that use it.</Text>
          {changes.data.hotspots.map((hotspot) => (
            <ListRow key={hotspot.path} title={hotspot.path} meta={hotspotMeta(hotspot)} onPress={() => onOpenFile(hotspot.path)} styles={styles} />
          ))}
        </>
      ) : null}

      {pulse.data && (pulse.data.readme || pulse.data.startHere.length > 0) ? (
        <>
          <SectionHeader label="Start here" styles={styles} />
          {pulse.data.readme ? <ListRow title={pulse.data.readme} meta="What the project says about itself" onPress={onReadReadme} styles={styles} /> : null}
          {pulse.data.startHere.map((file) => (
            <ListRow key={file.path} title={file.path} meta={[...(file.area !== null ? [areaLabel(file.area)] : []), `used by ${file.usedBy}`].join(" · ")} onPress={() => onOpenFile(file.path)} styles={styles} />
          ))}
        </>
      ) : null}
    </>
  );
}
