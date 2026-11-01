import type { PluginTheme } from "@getpaseo/plugin";

// The layout rules the kit's parts follow, kept free of React Native so they can be tested. Values
// are Paseo's own scale (measured from its 0.14 bundle): three type sizes, rows 44 tall on phones
// (a full touch target) and 36 on desktop, flat rows on desktop and rounded ones on phones.
type Colors = PluginTheme["colors"];

export const TYPE = { lg: 16, base: 14, sm: 12 } as const;
// Paseo's compact control height: search fields and buttons are never shorter.
export const CONTROL_HEIGHT = 32;
export const PROSE_MAX_WIDTH = 820;
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
