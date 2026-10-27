import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text } from "react-native";
import type { TagSummary } from "../shared/contracts";
import { errorText } from "./errors";
import { tagsChanged } from "./tag-events";

export const TAGS_QUERY = ["contextualise", "tags"];
export type Theme = PluginScreenProps["theme"];

export function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: 14, maxWidth: 860, width: "100%" as const, alignSelf: "center" as const },
      card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: compact ? 12 : 16, gap: 10, backgroundColor: theme.colors.surface1 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      section: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const, marginTop: 4 },
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      link: { color: theme.colors.accent, fontSize: 13 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      wrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      grow: { flex: 1, minWidth: 0 },
      input: { flex: 1, minWidth: 120, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 },
      button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground },
      ghost: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
      ghostText: { color: theme.colors.foreground, fontSize: 13 },
      chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 },
      chipOn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 13 },
      chipOnText: { color: theme.colors.accentForeground, fontSize: 13 },
    }),
    [theme, compact],
  );
}
export type Styles = ReturnType<typeof useStyles>;

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function summary(tag: TagSummary): string {
  const parts = [[tag.agents.length, "agent"], [tag.workspaces.length, "workspace"], [tag.links.length, "link"]] as const;
  return parts.filter(([n]) => n > 0).map(([n, word]) => plural(n, word)).join(" · ");
}

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 60 / 24)} d ago`;
}

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

export function Button({ label, onPress, styles, disabled, kind = "ghost" }: { label: string; onPress(): void; styles: Styles; disabled?: boolean; kind?: "ghost" | "primary" }) {
  return (
    <Pressable style={kind === "primary" ? styles.button : styles.ghost} onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={kind === "primary" ? styles.buttonText : styles.ghostText}>{label}</Text>
    </Pressable>
  );
}
