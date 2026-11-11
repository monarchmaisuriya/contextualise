import type { PluginTheme } from "@getpaseo/plugin";

// The layout rules the kit's parts follow, kept free of React Native so they can be tested. Values
// are Paseo's own scale (measured from its 0.14 bundle): its type sizes, rows 44 tall on phones
// (a full touch target) and 36 on desktop, flat rows on desktop and rounded ones on phones.
type Colors = PluginTheme["colors"];

// Each kind of text has one size, line height, and weight; screens name the kind, never a size.
// A section heading is larger and bolder than the rows it leads, so a screen scans by its groups;
// prose is the size Paseo's Markdown renders at, so agent-written text reads like a README beside it.
export const TEXT = {
  // A screen's own subject, like a page title: a project's name.
  page: { fontSize: 20, lineHeight: 26, fontWeight: "600" },
  // The subject of a view inside a screen: a tag or area name.
  title: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
  heading: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  // Rows, controls, tabs, and short lines.
  body: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  prose: { fontSize: 15, lineHeight: 21, fontWeight: "400" },
  // Row meta, hints, and lines that explain a section.
  note: { fontSize: 12, lineHeight: 18, fontWeight: "400" },
  // A tile's number, read at a glance.
  figure: { fontSize: 22, lineHeight: 28, fontWeight: "600" },
} as const;
// Paseo's compact control height: search fields and buttons are never shorter.
export const CONTROL_HEIGHT = 32;
export const BAR_HEIGHT = 28;
export const PROSE_MAX_WIDTH = 820;
// A section heading has more space above it than below, so it sits with the rows it leads.
export const HEADING_SPACE = { above: 20, below: 6 } as const;
export const SEARCH_MAX_WIDTH = 420;

export function pageInset(compact: boolean): number {
  return compact ? 12 : 24;
}

export function rowFrame(compact: boolean) {
  return { minHeight: compact ? 44 : 36, borderRadius: compact ? 8 : 0, paddingVertical: 8, paddingHorizontal: 12 };
}

// Pressed and selected share the strongest fill, so a pressed row never looks less chosen than a selected one.
export function rowBackground(colors: Colors, state: { hovered?: boolean; pressed?: boolean; selected?: boolean }): string {
  if (state.pressed || state.selected) return colors.surface2;
  return state.hovered ? colors.surface1 : "transparent";
}

// Phones stack the meta under the title; desktop gives it a right-aligned column.
export function metaPlacement(compact: boolean): "below" | "right" {
  return compact ? "below" : "right";
}

// A segmented control never wraps to a second line: on phones it scrolls sideways instead.
export function segmentedScrolls(compact: boolean): boolean {
  return compact;
}

export function searchWidth(compact: boolean) {
  return compact ? { width: "100%" as const } : { width: "100%" as const, maxWidth: SEARCH_MAX_WIDTH };
}

export function actionColor(colors: Colors, action: { danger?: boolean }): string {
  return action.danger ? colors.statusDanger : colors.foreground;
}

// An empty state offers at most two ways forward; more would turn it into a menu.
export function emptyActions<Action>(actions: readonly Action[] | undefined): readonly Action[] {
  return (actions ?? []).slice(0, 2);
}
