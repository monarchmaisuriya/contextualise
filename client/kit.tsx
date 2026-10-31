import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { copyText, Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { type QueryKey, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { TagSummary } from "../shared/contracts";
import { errorText } from "./errors";
import { ICONS } from "./icons";
import { plural } from "./plural";
import { tagsChanged } from "./tag-events";

export const TAGS_QUERY = ["contextualise", "tags"];
export type Theme = PluginScreenProps["theme"];

export function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: 14, maxWidth: 860, width: "100%" as const, alignSelf: "center" as const },
      // Quiet surfaces: grouping comes from the background, not borders.
      card: { borderRadius: 12, padding: compact ? 12 : 16, gap: 8, backgroundColor: theme.colors.surface1 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      section: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "500" as const, marginTop: 6 },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      // Secondary detail: the muted token at a smaller size, never lighter than the token itself.
      faint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      // Something to look at again, not an error: a stale source, an unfinished task.
      warning: { color: theme.colors.statusWarning, fontSize: 13 },
      link: { color: theme.colors.accent, fontSize: 13 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      wrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      grow: { flex: 1, minWidth: 0 },
      input: { flex: 1, minWidth: 120, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 },
      button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground },
      ghost: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
      ghostText: { color: theme.colors.foreground, fontSize: 13 },
      chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: theme.colors.surface2 },
      chipOn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 13 },
      chipOnText: { color: theme.colors.accentForeground, fontSize: 13 },
      iconButton: { padding: 8, borderRadius: 8 },
      inline: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      // Icon colors: icons take a color value, not a text style.
      colors: theme.colors,
    }),
    [theme, compact],
  );
}
export type Styles = ReturnType<typeof useStyles>;

export { plural };

export function summary(tag: TagSummary): string {
  const parts = [[tag.agents.length, "agent"], [tag.workspaces.length, "workspace"], [tag.links.length, "link"], [tag.notes.length, "item"]] as const;
  return parts.filter(([n]) => n > 0).map(([n, word]) => plural(n, word)).join(" · ");
}

export { timeAgo as ago } from "../shared/time";

// Mutations that change tags refresh every tag list (screens, popovers, pill labels) and report
// failures as readable toasts.
export function useTagChange<Input, Output>(run: (input: Input) => Promise<Output>, onDone?: (output: Output, input: Input) => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: run,
    onSuccess: (output, input) => {
      void queryClient.invalidateQueries({ queryKey: TAGS_QUERY });
      tagsChanged();
      onDone?.(output, input);
    },
    onError: (error) => toast.error(errorText(error)),
  });
}

export function Button({ label, icon, onPress, styles, disabled, kind = "ghost" }: { label: string; icon?: string; onPress(): void; styles: Styles; disabled?: boolean; kind?: "ghost" | "primary" }) {
  const color = kind === "primary" ? styles.colors.accentForeground : styles.colors.foreground;
  return (
    <Pressable style={[kind === "primary" ? styles.button : styles.ghost, styles.inline, disabled ? { opacity: 0.5 } : null]} onPress={onPress} disabled={disabled} hitSlop={6} accessibilityRole="button" accessibilityLabel={label}>
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={kind === "primary" ? styles.buttonText : styles.ghostText}>{label}</Text>
    </Pressable>
  );
}

// An icon with no text; the label is what screen readers say and what the action does.
export function IconButton({ icon, label, onPress, styles, disabled, tone = "muted" }: { icon: string; label: string; onPress(): void; styles: Styles; disabled?: boolean; tone?: "muted" | "danger" | "accent" }) {
  const color = tone === "danger" ? styles.colors.statusDanger : tone === "accent" ? styles.colors.accent : styles.colors.foregroundMuted;
  return (
    <Pressable style={[styles.iconButton, disabled ? { opacity: 0.4 } : null]} onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}>
      <Icon name={icon} size={16} color={color} />
    </Pressable>
  );
}

export function Chip({ label, icon, on, onPress, styles, accessibilityLabel }: { label: string; icon?: string; on?: boolean; onPress(): void; styles: Styles; accessibilityLabel?: string }) {
  return (
    <Pressable style={[on ? styles.chipOn : styles.chip, styles.inline, { gap: 4 }]} onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityState={{ selected: Boolean(on) }} accessibilityLabel={accessibilityLabel ?? label}>
      {icon ? <Icon name={icon} size={13} color={on ? styles.colors.accentForeground : styles.colors.foregroundMuted} /> : null}
      <Text style={on ? styles.chipOnText : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

// A quiet sentence-case heading; the count reads fainter than the label.
export function SectionTitle({ label, count, hint, styles }: { label: string; count?: number; hint?: string; styles: Styles }) {
  return (
    <Text style={styles.section}>
      {label}
      {count !== undefined ? <Text style={styles.faint}> {count}</Text> : null}
      {hint ? <Text style={styles.faint}> · {hint}</Text> : null}
    </Text>
  );
}

// The search or filter box every screen uses: an icon, the text, and a clear button once typed in.
export function SearchField({ value, onChange, placeholder, label, styles }: { value: string; onChange(text: string): void; placeholder: string; label: string; styles: Styles }) {
  return (
    <View style={[styles.inline, styles.input, { borderWidth: 0 }]}>
      <Icon name={ICONS.search} size={15} color={styles.colors.foregroundMuted} />
      <TextInput style={[styles.grow, { color: styles.colors.foreground }]} value={value} onChangeText={onChange} placeholder={placeholder} accessibilityLabel={label} />
      {value !== "" ? <IconButton icon={ICONS.close} label={`Clear ${label.toLowerCase()}`} onPress={() => onChange("")} styles={styles} /> : null}
    </View>
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

// A list read a page at a time from an RPC that answers `{ total }` and the page's items.
export function usePagedList<Item, Page extends { total: number }>(queryKey: QueryKey, fetchPage: (offset: number) => Promise<Page>, itemsOf: (page: Page) => readonly Item[]) {
  const pages = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const shown = all.reduce((sum, page) => sum + itemsOf(page).length, 0);
      return shown < last.total ? shown : undefined;
    },
  });
  return { pages, items: pages.data?.pages.flatMap(itemsOf) ?? [], total: pages.data?.pages[0]?.total ?? 0 };
}
