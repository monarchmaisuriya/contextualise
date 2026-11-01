import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { type QueryKey, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { TagSummary } from "../shared/contracts";
import { errorText } from "./errors";
import { pageInset, TYPE } from "./parts/rules";
import { plural } from "./plural";
import { tagsChanged } from "./tag-events";

export const TAGS_QUERY = ["contextualise", "tags"];
export type Theme = PluginScreenProps["theme"];

// Three type sizes only: lg once per view for the subject (a tag or project name), base for
// everything else, sm for hints and errors.
export function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      compact,
      lg: { color: theme.colors.foreground, fontSize: TYPE.lg, fontWeight: "600" as const },
      base: { color: theme.colors.foreground, fontSize: TYPE.base },
      sm: { color: theme.colors.foregroundMuted, fontSize: TYPE.sm },
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: pageInset(compact), gap: 8, width: "100%" as const },
      text: { color: theme.colors.foreground, fontSize: TYPE.base },
      section: { color: theme.colors.foregroundMuted, fontSize: TYPE.base, fontWeight: "500" as const, marginTop: 8 },
      muted: { color: theme.colors.foregroundMuted, fontSize: TYPE.base },
      danger: { color: theme.colors.statusDanger, fontSize: TYPE.sm },
      // Something to look at again, not an error: a stale source, an unfinished task.
      link: { color: theme.colors.accent, fontSize: TYPE.base },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      wrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      grow: { flex: 1, minWidth: 0 },
      input: { flex: 1, minWidth: 120, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6, fontSize: TYPE.base, color: theme.colors.foreground, backgroundColor: theme.colors.surface1 },
      button: { height: 32, paddingHorizontal: 12, borderRadius: 12, justifyContent: "center" as const, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, fontSize: TYPE.base },
      ghost: { height: 32, paddingHorizontal: 12, borderRadius: 12, justifyContent: "center" as const },
      ghostText: { color: theme.colors.foreground, fontSize: TYPE.base },
      // Chips show state without accent: outlined when off, a quiet fill when on.
      chip: { height: 28, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border },
      chipOn: { height: 28, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 },
      chipText: { color: theme.colors.foregroundMuted, fontSize: TYPE.base },
      chipOnText: { color: theme.colors.foreground, fontSize: TYPE.base },
      iconButton: { width: 32, height: 32, borderRadius: 8, alignItems: "center" as const, justifyContent: "center" as const },
      inline: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      // Icon colors: icons take a color value, not a text style.
      colors: theme.colors,
    }),
    [theme, compact],
  );
}
export type Styles = ReturnType<typeof useStyles>;

export { plural };
export { Button, Chip, CopyButton, IconButton, SearchField, Segmented } from "./parts/controls";
export { ListRow, type ListRowProps, Page, Prose, SectionHeader } from "./parts/list";
export { ActionSheet, ReaderSheet, type ReaderSheetProps, type SheetAction, StateView, useActionSheet, type ViewState } from "./parts/sheets";

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
