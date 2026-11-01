import { copyText, Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { errorText } from "../errors";
import { ICONS } from "../icons";
import type { Styles } from "../kit";
import { CONTROL_HEIGHT, searchWidth, segmentedScrolls } from "./rules";

// Ghost by default; primary (accent fill) is for the one main action of a view.
export function Button({ label, icon, onPress, styles, disabled, kind = "ghost" }: { label: string; icon?: string; onPress(): void; styles: Styles; disabled?: boolean; kind?: "ghost" | "primary" }) {
  const color = kind === "primary" ? styles.colors.accentForeground : styles.colors.foreground;
  return (
    <Pressable style={[kind === "primary" ? styles.button : styles.ghost, styles.inline, disabled ? { opacity: 0.5 } : null]} onPress={onPress} disabled={disabled} hitSlop={6} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }}>
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={kind === "primary" ? styles.buttonText : styles.ghostText}>{label}</Text>
    </Pressable>
  );
}

// An icon with no text; the label is what screen readers say and what the action does. The 32 box
// plus hitSlop 6 makes a 44 point touch target.
export function IconButton({ icon, label, onPress, styles, disabled }: { icon: string; label: string; onPress(): void; styles: Styles; disabled?: boolean }) {
  const color = styles.colors.foregroundMuted;
  return (
    <Pressable style={[styles.iconButton, disabled ? { opacity: 0.4 } : null]} onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }} hitSlop={6}>
      <Icon name={icon} size={16} color={color} />
    </Pressable>
  );
}

// Paseo's own switch, drawn the same way: React Native's Switch takes the platform's thumb colour
// (teal on the web and Android), which no Paseo theme uses. Off is a white thumb as in Paseo, on
// `border`: Paseo's off track is surface3, which plugins are not given, and Paseo itself fills
// surface3 with border for themes that plugins contribute.
export function Toggle({ value, onValueChange, label, styles }: { value: boolean; onValueChange(value: boolean): void; label: string; styles: Styles }) {
  return (
    <Pressable
      style={{ width: 34, height: 20, borderRadius: 10, padding: 2, justifyContent: "center", backgroundColor: value ? styles.colors.accent : styles.colors.border }}
      onPress={() => onValueChange(!value)}
      hitSlop={12}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      aria-checked={value}
      accessibilityLabel={label}
    >
      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: value ? styles.colors.accentForeground : "#ffffff", transform: [{ translateX: value ? 14 : 0 }] }} />
    </Pressable>
  );
}

export function Chip({ label, icon, on, onPress, styles, accessibilityLabel }: { label: string; icon?: string; on?: boolean; onPress(): void; styles: Styles; accessibilityLabel?: string }) {
  return (
    <Pressable style={[on ? styles.chipOn : styles.chip, styles.inline, { gap: 4 }]} onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityState={{ selected: Boolean(on) }} accessibilityLabel={accessibilityLabel ?? label}>
      {icon ? <Icon name={icon} size={14} color={on ? styles.colors.foreground : styles.colors.foregroundMuted} /> : null}
      <Text style={on ? styles.chipOnText : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

// The search or filter box every screen uses: an icon, the text, and a clear button once typed in.
export function SearchField({ value, onChange, placeholder, label, styles }: { value: string; onChange(text: string): void; placeholder: string; label: string; styles: Styles }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.inline, styles.input, searchWidth(styles.compact), { flex: 0, minWidth: 0, minHeight: CONTROL_HEIGHT, gap: 8 }, focused ? { backgroundColor: styles.colors.surface2 } : null]}>
      <Icon name={ICONS.search} size={14} color={styles.colors.foregroundMuted} />
      <TextInput
        style={[styles.grow, styles.text, { padding: 0 }]}
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={styles.colors.foregroundMuted}
        accessibilityLabel={label}
      />
      {value !== "" ? (
        <Pressable onPress={() => onChange("")} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Clear ${label.toLowerCase()}`}>
          <Icon name={ICONS.close} size={14} color={styles.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// One choice out of a few views or orders. Selection is a quiet fill, never accent.
export function Segmented<Value extends string>({ options, value, onChange, label, styles }: { options: readonly { label: string; value: Value }[]; value: Value; onChange(value: Value): void; label: string; styles: Styles }) {
  const items = (
    <View style={{ flexDirection: "row", flexWrap: "nowrap", height: 28, borderWidth: 1, borderColor: styles.colors.border, borderRadius: 6, overflow: "hidden", alignSelf: "flex-start" }} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            style={{ paddingHorizontal: 10, justifyContent: "center", backgroundColor: selected ? styles.colors.surface2 : "transparent" }}
            onPress={() => onChange(option.value)}
            hitSlop={{ top: 8, bottom: 8 }}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
          >
            <Text style={[styles.base, { color: selected ? styles.colors.foreground : styles.colors.foregroundMuted }]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  return segmentedScrolls(styles.compact) ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
      {items}
    </ScrollView>
  ) : (
    items
  );
}

// Copies text and says whether it worked; a failed copy is an error toast, never a silent no-op.
export function CopyButton({ text, styles }: { text: string; styles: Styles }) {
  const toast = useToast();
  return (
    <Button
      label="Copy"
      icon={ICONS.copy}
      styles={styles}
      onPress={() =>
        void copyText(text).then(
          () => toast.show("Copied", { variant: "success" }),
          (error: unknown) => toast.error(errorText(error)),
        )
      }
    />
  );
}
