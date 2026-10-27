import type { Vendor } from "../shared/contracts";

// Every icon the plugin's own UI draws, by meaning. Paseo draws Lucide icons by name and draws
// nothing for an unknown one, so names live here only, and a test checks each against the names
// Paseo 0.13's bundled lucide-react-native exports.
export const ICONS = {
  tag: "Tag",
  tags: "Tags",
  agent: "Bot",
  workspace: "FolderGit2",
  link: "Link",
  item: "FileText",
  fetch: "Download",
  preview: "Eye",
  refresh: "RefreshCw",
  remove: "Trash2",
  close: "X",
  add: "Plus",
  copy: "Copy",
  open: "ExternalLink",
  expanded: "ChevronDown",
  collapsed: "ChevronRight",
  expandAll: "ChevronsUpDown",
  collapseAll: "ChevronsDownUp",
  sort: "ArrowUpDown",
  search: "Search",
  time: "Clock",
  archived: "Archive",
  ready: "CircleCheck",
  failed: "CircleAlert",
  fetching: "LoaderCircle",
  empty: "Inbox",
  pin: "Pin",
  unpin: "PinOff",
} as const;

// The Contextualise mark (contextualise.png without its dark square), for places that stand for the
// plugin itself. Painted with currentColor, so it follows the theme like the Lucide icons.
export const LOGO = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="112 105 290 290" fill="none"><path d="M347.2 199.9 362.7 172.2A121 121 0 1 0 362.7 327.8L347.2 300.1" stroke="currentColor" stroke-width="20"/><circle cx="299" cy="250" r="33" fill="currentColor"/></svg>' };

export const VENDOR_ICONS: Record<Vendor, string> = { jira: "Ticket", sentry: "Bug", slack: "MessageSquare", notion: "FileText" };
