import type { MemoriseState } from "../shared/knowledge";

export const MEMORISE_INSTALL_COMMAND = "paseo plugin add monarchmaisuriya/memorise";
const ADDS = "decisions and pitfalls learned while working, related memories in search, and memory checks when code changes";

// The one line Contextualise shows when Memorise would add to it; nothing when Memorise is available.
export function memoriseNote(state: MemoriseState): { text: string; command: string | null } | null {
  switch (state) {
    case "available":
      return null;
    case "not-installed":
      return { text: `Install Memorise to add ${ADDS}.`, command: MEMORISE_INSTALL_COMMAND };
    case "disabled":
      return { text: `Turn on Memorise (Settings > Plugins) to add ${ADDS}.`, command: null };
    case "needs-update":
      return { text: `Update Memorise to 0.10 or later, or reload it, to add ${ADDS}.`, command: "paseo plugin update memorise" };
  }
}
