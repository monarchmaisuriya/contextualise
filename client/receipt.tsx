import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import type { Receipt } from "../shared/contracts";

function counts(entry: Receipt["entries"][number]): string {
  const parts = [
    [entry.agents, "agent"],
    [entry.workspaces, "workspace"],
    [entry.links, "link"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`)
    .join(", ");
}

function describe(action: Receipt["action"], entry: Receipt["entries"][number]): string {
  if (action === "tag") return entry.changed ? `Tagged "${entry.name}"` : `Already tagged "${entry.name}"`;
  return entry.changed ? `Removed from "${entry.name}"` : `Was not tagged "${entry.name}"`;
}

// The one confirmation row /tag and /untag leave in an agent's timeline; each new one replaces it.
export function ReceiptRow({ theme, item, agentId, openTags }: PluginTimelineItemProps<Receipt> & { openTags(agentId: string): void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      {item.data.entries.map((entry) => (
        <Text key={entry.name} style={{ color: entry.changed ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13 }}>
          {describe(item.data.action, entry)}
          {counts(entry) ? <Text style={{ color: theme.colors.foregroundMuted }}> · {counts(entry)}</Text> : null}
        </Text>
      ))}
      <Pressable onPress={() => openTags(agentId)} accessibilityRole="link" accessibilityLabel="Open tags">
        <Text style={{ color: theme.colors.accent, fontSize: 13 }}>Open tags</Text>
      </Pressable>
    </View>
  );
}
