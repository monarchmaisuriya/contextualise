import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Styles } from "../kit";
import { actionColor, metaPlacement, PROSE_MAX_WIDTH, rowBackground, rowFrame } from "./rules";

// A plugin screen's scrolling body: full width like Paseo's own list screens, not a centered column.
export function Page({ styles, children }: { styles: Styles; children: ReactNode }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

// Long text (descriptions, readers) stays readable on wide windows; lists use the full width.
export function Prose({ children }: { children: ReactNode }) {
  return <View style={{ width: "100%", maxWidth: PROSE_MAX_WIDTH }}>{children}</View>;
}

export interface ListRowProps {
  title: string;
  meta?: string;
  icon?: string;
  // One control beside the row, outside its pressable area so it presses on its own.
  trailing?: ReactNode;
  onPress?(): void;
  selected?: boolean;
  disabled?: boolean;
  danger?: boolean;
  accessibilityLabel?: string;
  styles: Styles;
}

export function ListRow({ title, meta, icon, trailing, onPress, selected = false, disabled = false, danger = false, accessibilityLabel, styles }: ListRowProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const below = metaPlacement(styles.compact) === "below";
  const titleColor = actionColor(styles.colors, { danger });
  const titleText = (
    <Text style={[styles.base, { color: titleColor }, below ? null : styles.grow]} numberOfLines={1}>
      {title}
    </Text>
  );
  const metaText = meta ? (
    <Text style={[styles.sm, below ? null : { flexShrink: 1, maxWidth: "40%", textAlign: "right" }]} numberOfLines={1}>
      {meta}
    </Text>
  ) : null;
  const body = (
    <>
      {icon ? <Icon name={icon} size={16} color={danger ? titleColor : styles.colors.foregroundMuted} /> : null}
      {below ? (
        <View style={styles.grow}>
          {titleText}
          {metaText}
        </View>
      ) : (
        <>
          {titleText}
          {metaText}
        </>
      )}
    </>
  );
  return (
    <View style={[rowFrame(styles.compact), styles.row, { paddingVertical: 0, backgroundColor: rowBackground(styles.colors, { hovered, pressed, selected }) }, disabled ? { opacity: 0.4 } : null]}>
      {onPress ? (
        <Pressable
          style={[styles.row, styles.grow, { alignSelf: "stretch", paddingVertical: 8 }]}
          onPress={onPress}
          disabled={disabled}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? title}
          accessibilityState={{ selected, disabled }}
        >
          {body}
        </Pressable>
      ) : (
        <View style={[styles.row, styles.grow, { paddingVertical: 8 }]} accessibilityLabel={accessibilityLabel}>
          {body}
        </View>
      )}
      {trailing}
    </View>
  );
}

// A group's heading, aligned with row text; the count reads in the same quiet style.
export function SectionHeader({ label, count, action, styles }: { label: string; count?: number; action?: { label: string; onPress(): void }; styles: Styles }) {
  return (
    <View style={[styles.row, { paddingHorizontal: 12, marginVertical: 8 }]}>
      <Text style={[styles.section, styles.grow, { marginTop: 0 }]} accessibilityRole="header" numberOfLines={1}>
        {label}
        {count !== undefined ? ` ${count}` : ""}
      </Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={`${action.label}: ${label}`}>
          <Text style={styles.link}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
