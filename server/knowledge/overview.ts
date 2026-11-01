import type { SnapshotSettings } from "../../shared/contracts";
import type { KnowledgeOverview } from "../../shared/knowledge";
import type { ProjectPrefs } from "./prefs";
import { buildSection, SECTION_END, SECTION_START, unavailableSection } from "./section";
import type { KnowledgeStore } from "./store";

export interface OverviewInputs {
  repoKey: string;
  settings: Pick<SnapshotSettings, "knowledgeEnabled" | "knowledgeMapLines" | "knowledgeMapParts" | "knowledgeRecentTasks">;
  prefs: Pick<ProjectPrefs, "enabled" | "pins">;
  // The knowledge tool server's start problem, or null when it listens.
  problem: () => Promise<string | null>;
  // The project's index; the agent hook refreshes it here first, the preview only opens it.
  open: () => Promise<{ store: KnowledgeStore; updating: boolean }>;
  memoriseAvailable: () => Promise<boolean>;
}

// The overview a new agent in this project gets, with the section markers. The agent hook and the
// screen's preview both use this, so the preview is what agents get. `lines` leaves out the markers.
export async function overviewFor(inputs: OverviewInputs): Promise<KnowledgeOverview> {
  const { settings, prefs } = inputs;
  if (!settings.knowledgeEnabled || !prefs.enabled) return { state: "off", text: null, lines: 0 };
  const problem = await inputs.problem();
  if (problem) return given("unavailable", unavailableSection(problem));
  const { store, updating } = await inputs.open();
  return given(
    "given",
    buildSection({
      repoKey: inputs.repoKey,
      store,
      maxLines: settings.knowledgeMapLines,
      memoriseAvailable: await inputs.memoriseAvailable(),
      updating,
      parts: settings.knowledgeMapParts,
      recentTasks: settings.knowledgeRecentTasks,
      pins: prefs.pins,
    }),
  );
}

function given(state: "unavailable" | "given", text: string | null): KnowledgeOverview {
  return { state, text, lines: text === null ? 0 : withoutMarkers(text).split("\n").length };
}

export function withoutMarkers(section: string): string {
  return section
    .split("\n")
    .filter((line) => line !== SECTION_START && line !== SECTION_END)
    .join("\n");
}
