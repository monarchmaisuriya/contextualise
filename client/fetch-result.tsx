import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import { type FetchResult, VENDOR_LABELS } from "../shared/contracts";
import { tokenEstimate } from "../shared/tokens";
import { ICONS, VENDOR_ICONS } from "./icons";

// The row a fetch leaves in the agent that asked for it; a later fetch of the same item replaces it.
export function FetchResultRow({
  theme,
  item,
  agentId,
  openItem,
  openTags,
}: PluginTimelineItemProps<FetchResult> & { openItem(tag: string, noteId: string): void; openTags(agentId: string): void }) {
  const result = item.data;
  const ready = result.status === "ready";
  const link = { color: theme.colors.accent, fontSize: 13 };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      <Icon name={ready ? VENDOR_ICONS[result.vendor] : ICONS.failed} size={14} color={ready ? theme.colors.foregroundMuted : theme.colors.statusDanger} />
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={1}>
        {ready ? `Fetched "${result.title}" into "${result.tag}"` : `Could not fetch ${VENDOR_LABELS[result.vendor]} ${result.ref}`}
        <Text style={{ color: ready ? theme.colors.foregroundMuted : theme.colors.statusDanger }}> · {ready ? tokenEstimate(result.chars) : (result.error ?? "unknown reason")}</Text>
      </Text>
      {ready ? (
        <Pressable onPress={() => openItem(result.tag, result.noteId)} accessibilityRole="link" accessibilityLabel={`Read ${result.title}`}>
          <Text style={link}>Read</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={() => openTags(agentId)} accessibilityRole="link" accessibilityLabel="Open tags">
        <Text style={link}>Open tags</Text>
      </Pressable>
    </View>
  );
}
