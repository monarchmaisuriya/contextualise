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
} as const;

export const VENDOR_ICONS: Record<Vendor, string> = { jira: "Ticket", sentry: "Bug", slack: "MessageSquare", notion: "FileText" };
