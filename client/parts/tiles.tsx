import { Pressable, Text, View } from "react-native";
import type { TileText } from "../knowledge/pulse-text";
import { barHeights } from "../knowledge/pulse-text";
import type { Styles } from "../kit";
import { BAR_HEIGHT, TEXT } from "./rules";

// A number to read at a glance, what it counts, and its label. Two to a row on a phone and four on
// a desktop; one to a row when the space is narrower than two can share.
export function Tile({ label, text, onPress, styles }: { label: string; text: TileText; onPress?(): void; styles: Styles }) {
  const color = text.tone === "warning" ? styles.colors.statusWarning : text.tone === "muted" ? styles.colors.foregroundMuted : styles.colors.foreground;
  const frame = { flexGrow: 1, flexBasis: styles.compact ? ("45%" as const) : 0, minWidth: 140, borderWidth: 1, borderColor: styles.colors.border, borderRadius: 8, padding: 12, gap: 2 };
  const said = `${label}: ${text.value} ${text.sentence}`;
  const body = (
    <>
      <Text style={styles.note}>{label}</Text>
      <Text style={{ ...TEXT.figure, color }}>{text.value}</Text>
      <Text style={styles.note} numberOfLines={2}>
        {text.sentence}
      </Text>
    </>
  );
  return onPress ? (
    <Pressable style={({ pressed }) => [frame, pressed ? { backgroundColor: styles.colors.surface2 } : null]} onPress={onPress} accessibilityRole="button" accessibilityLabel={said}>
      {body}
    </Pressable>
  ) : (
    <View style={frame} accessible accessibilityLabel={said}>
      {body}
    </View>
  );
}

// One column per day, oldest first; length shows the count (NN/g: length, not colour, for amounts).
// Days with nothing keep a hairline so the time axis stays visible.
export function DayBars({ label, counts, total, color, styles }: { label: string; counts: readonly number[]; total: string; color: string; styles: Styles }) {
  const heights = barHeights(counts, BAR_HEIGHT);
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.row}>
        <Text style={[styles.note, styles.grow]}>{label}</Text>
        <Text style={styles.note}>{total}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-end", height: BAR_HEIGHT, gap: counts.length > 30 ? 1 : 2 }} accessible accessibilityLabel={`${label}: ${total} over ${counts.length} days`}>
        {heights.map((height, index) => (
          <View key={index} style={{ flex: 1, height: Math.max(height, 1), borderRadius: 1, backgroundColor: height === 0 ? styles.colors.border : color }} />
        ))}
      </View>
    </View>
  );
}
