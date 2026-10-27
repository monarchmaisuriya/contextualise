import { expect, test } from "vitest";
import { ICONS, VENDOR_ICONS } from "./icons";

// Checked against Paseo 0.13.0's bundle on 2026-10-27: these are exports of its lucide-react-native
// 1.50.0, which is what Paseo's Icon looks names up in.
const VERIFIED_LUCIDE = new Set([
  "Tags", "Tag", "Bot", "FolderGit2", "Link", "Ticket", "Bug", "MessageSquare", "FileText", "SquareTerminal", "Download", "RefreshCw",
  "Trash2", "Copy", "ExternalLink", "Eye", "Plus", "X", "CircleCheck", "CircleAlert", "LoaderCircle", "ChevronDown", "ChevronRight",
  "ArrowUpDown", "Clock", "Archive", "Inbox", "ChevronsUpDown", "ChevronsDownUp", "ListFilter", "MessagesSquare", "Layers", "Search",
]);

test("every icon the plugin draws is a Lucide name Paseo can draw", () => {
  for (const [meaning, name] of Object.entries({ ...ICONS, ...VENDOR_ICONS })) expect(VERIFIED_LUCIDE.has(name), `${meaning}: ${name}`).toBe(true);
});
