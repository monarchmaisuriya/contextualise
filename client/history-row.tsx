import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { HistoryNote } from "../shared/history";
import { TEXT } from "./parts/rules";

// A note Contextualise adds to a chat after a compaction or for /history: a title and a few lines.
export function HistoryNoteRow({ theme, item }: PluginTimelineItemProps<HistoryNote>) {
  return (
    <View style={{ gap: 2, paddingVertical: 4 }}>
      <Text style={{ ...TEXT.body, color: theme.colors.foreground }}>{item.data.title}</Text>
      {item.data.lines.map((line, index) => (
        <Text key={index} style={{ ...TEXT.body, color: theme.colors.foregroundMuted }}>
          {line}
        </Text>
      ))}
    </View>
  );
}
