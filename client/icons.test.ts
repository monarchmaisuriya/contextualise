import { findSvgIconProblem } from "@getpaseo/plugin";
import { expect, test } from "vitest";
import { ICONS, LOGO, VENDOR_ICONS } from "./icons";

// Checked against Paseo 0.13.0's bundle on 2026-10-27: these are exports of its lucide-react-native
// 1.50.0, which is what Paseo's Icon looks names up in.
const VERIFIED_LUCIDE = new Set([
  "Tags", "Tag", "Bot", "FolderGit2", "Link", "Ticket", "Bug", "MessageSquare", "FileText", "SquareTerminal", "Download", "RefreshCw",
  "Trash2", "Copy", "ExternalLink", "Eye", "Plus", "X", "CircleCheck", "CircleAlert", "LoaderCircle", "ChevronDown", "ChevronRight",
  "ArrowUpDown", "Clock", "Archive", "Inbox", "ChevronsUpDown", "ChevronsDownUp", "ListFilter", "MessagesSquare", "Layers", "Search",
  // Added 2026-10-28 from the same bundle export table as LoaderCircle and CircleAlert.
  "Pin", "PinOff",
  // Added 2026-10-28, same export table.
  "EllipsisVertical", "Info", "ArrowDownUp",
  // Added 2026-10-29, checked in Paseo 0.13.2's bundle the same way.
  "BookOpen",
]);

test("every icon the plugin draws is a Lucide name Paseo can draw", () => {
  for (const [meaning, name] of Object.entries({ ...ICONS, ...VENDOR_ICONS })) expect(VERIFIED_LUCIDE.has(name), `${meaning}: ${name}`).toBe(true);
});

test("the logo is an SVG Paseo accepts and follows the theme's color", () => {
  expect(findSvgIconProblem(LOGO.svg)).toBeNull();
  expect(LOGO.svg).toContain("currentColor");
  expect(LOGO.svg).not.toMatch(/#[0-9a-f]{3,6}\b/i);
});
