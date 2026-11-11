import { Text, View } from "react-native";
import { barHeights } from "../knowledge/pulse-text";
import type { Styles } from "../kit";
import { BAR_HEIGHT } from "./rules";

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
