// The Attached button's tabs. Project files lists the attached projects' files, so it is offered only
// once something is attached; while the links load, the chosen tab is kept, so the popover does not
// jump between tabs as it opens.
export type AttachTab = "projects" | "workspaces" | "chats" | "files";

const ATTACH_TABS = [
  { label: "Projects", value: "projects" },
  { label: "Workspaces", value: "workspaces" },
] as const;
const WITH_FILES = [...ATTACH_TABS, { label: "Project files", value: "files" }] as const;

// `attached` is null while the workspace's links load.
export function attachTabs(attached: number | null, chats = false): readonly { label: string; value: AttachTab }[] {
  const tabs = attached === 0 ? ATTACH_TABS : WITH_FILES;
  return chats ? [...ATTACH_TABS, { label: "Chats", value: "chats" }, ...tabs.filter((tab) => tab.value === "files")] : tabs;
}

export function shownTab(chosen: AttachTab, attached: number | null, chats = false): AttachTab {
  return chosen === "chats" && !chats || chosen === "files" && attached === 0 ? "projects" : chosen;
}
