# Changelog

All notable changes follow [semantic versioning](https://semver.org).

## 0.16.1 - 2026-10-29

### Fixed

- The Project knowledge screen named repositories after whichever Paseo worktree an agent last ran in, a random folder name such as "terrific-eel". Repositories are now named from the repository itself ("orders-api" for github.com/acme/orders-api), and a repository without a remote by its main checkout's folder. Folders outside git keep their own folder name.

## 0.16.0 - 2026-10-29

### Changed

- Attach > Agent conversation lists every matching conversation instead of the newest 20, and the tag and terminal lists list every match too. Each conversation is read once and again only after it changes (up to 2,000 kept), at most 6 at a time, so the list stays quick. The "Results per picker" setting is gone; a stored value is ignored.
- Archived conversations are hidden by default. "Show archived conversations" turns them on; pinned ones always show.
- Background helper agents (Contextualise's and Memorise's, and Paseo's own) are never listed.
- Settings text rewritten in plain words: sections are now Project knowledge, Conversation summaries, Attachments, Tags button, Attach lists, Saving items, and Advanced. The Project knowledge screen's buttons are "Add past conversations" and "Summarise past conversations", and entry kinds read Design, Team rules, Decisions, Documents, Code, Past work, and About the project.

## 0.15.0 - 2026-10-29

### Added

- Project knowledge for folders outside git, keyed the way Memorise keys them: by the folder's name and real path, kept through renames and moves, and shared by the subfolders of a Paseo project. Files are found by a bounded walk and read again when their modified time or size changes. The home folder, the filesystem root, and plugin data folders are never projects.
- Import past sessions: every existing agent of a project gets its task entry from its timeline, with no model.
- Generated knowledge, off by default, with Memorise's safeguards:
  - A session summary (title and 2 to 4 sentences) is written after the agent has been quiet for a set time.
  - A project brief is written after every 5 summaries.
  - "Generate summaries and brief" covers past sessions on request.
  - Background agents are locked down, have no tools, and are archived.
  - Sessions are redacted first and read by their own provider by default.
  - Runs are capped per day.
  - Decisions and pitfalls are never generated (Memorise's job).
- Generated titles name agents in plain folders in Attach > Agent conversation.
- Agent tools: `knowledge_outline` (a file's sections or symbols with lines) and `knowledge_history` (the tasks that changed a file or folder); `knowledge_search` takes `paths`.
- Settings:
  - which parts the map lists and how many recent tasks;
  - symbol languages;
  - extra doc globs and excluded globs;
  - largest file and most documents;
  - automatic tool approval;
  - the generation switch, provider, quiet minutes, and daily runs.
- Per project, on the Project knowledge screen: a switch to turn knowledge off, pins that always appear in the map, the brief, and summaries in the task list.

### Changed

- The map and tools say "project" instead of "repository". Fetch and summary agents share one locked-down background agent runner.

## 0.14.0 - 2026-10-29

### Changed

- Attach > Agent conversation titles an agent with its worktree's title (the title Paseo's sidebar shows) instead of its first request; agents sharing a worktree get "worktree title · their request". Agents in plain folders keep their first request, the only title Paseo has for them.
- Agent rows' muted text now starts with how long ago the agent was active, then git details from Paseo: branch, uncommitted changes (`+12 −3`), and pull request (`PR #42`, with draft or merged). The workspace follows only when the title does not already name it.
- Search in the agent picker also matches the workspace title, branch, and pull request number or title. Terminal rows show the branch.
- Picker titles are cut at 44 characters (Settings > Contextualise > Pickers > Longest title in pickers, 20 to 120), because Paseo never shortens a title and a long one hid the details beside it.

### Added

- Settings > Contextualise > Pickers: "Show git details" and "Longest title in pickers".

### Fixed

- Workspaces renamed in Paseo showed their old name in tags, pickers, and the Tags pill. Contextualise now names a workspace the way Paseo does (its title, else its name).

## 0.13.0 - 2026-10-29

### Added

- Project knowledge. Every new agent in a git repository gets a short project map in its system prompt (architecture docs, conventions files, ADRs with their status, top-level folders, and the last 3 finished tasks; 40 lines by default) and two read-only tools, `knowledge_search` and `knowledge_read`. They cover the repository's docs, conventions, ADRs, code symbols (TypeScript, JavaScript, Python, and Go through tree-sitter), and finished tasks. Calls to them are approved automatically.
- The index follows git's file hashes: only changed files are read again, uncommitted edits included. Task entries whose changed files have changed since, and superseded ADRs, are marked "needs check". Large repositories finish indexing in the background.
- A task log: each finished turn updates that agent's entry (first request, files changed, commands with exit codes, outcome), built from its timeline without a model. Secret-shaped text is removed first.
- A Project knowledge screen (sidebar footer and Command Center) to search each repository's knowledge by kind, see recent tasks, and re-index; and Attach > Project knowledge.
- With Memorise 0.10 or later running: search results show the Memorise memories about the same file, the map points agents to Memorise for decisions and pitfalls, and renamed or removed definitions and superseded ADRs lead to suggestions in Memorise that wait for your approval. Without it, Settings > Contextualise says what installing, turning on, or updating Memorise would add. Contextualise never stores decisions or pitfalls itself.
- Settings > Contextualise > Project knowledge: on or off, code symbols, suggestions to Memorise, map length, and the tools' port (6791).

### Changed

- The plugin now has runtime dependencies (`@modelcontextprotocol/sdk`, `web-tree-sitter`) and a build step for Git installs, and ships prebuilt tree-sitter grammars in `grammars/` (MIT).

### Fixed

- A test of the fetch concurrency limit depended on timing and could fail under load; it now holds its workers until released.

## 0.12.0 - 2026-10-28

### Changed

- A quieter, more minimal interface with every feature kept:
  - Tags screen: filter, sort, and expand or collapse share one row; the totals moved into the filter box.
  - Sort is one control that cycles recent, name, and size; one button expands or collapses every tag.
  - Each fetched item has one ⋮ button for Read, Refresh or Retry, and Remove (tap the item still reads it); each tag's ⋮ holds Fetch item and Add link.
  - Agents and links show one quiet × instead of a red trash can; links show a short address.
  - Headings are sentence case; cards and chips have no borders; hints are one line.
  - Tags pill: the agent's tags and the other tags form one cloud (filled to remove, + to add); pinning is an icon; the fetch form opens from "Fetch an item".
  - Agent picker rows say "8 min ago" instead of "active 8 min ago".
- Listing screenshots retaken with the new interface.

## 0.11.3 - 2026-10-28

### Added

- Interface images for the plugin listing (`paseo-plugin.json` `media`): the Tags screen, the Tags pill, and Attach > Agent conversation, taken with made-up sample data.

## 0.11.2 - 2026-10-28

### Fixed

- The Tags screen failed with "Plugin state hooks must run inside a workspace panel" as soon as it had an agent to show (a tagged or pinned agent, or the screen opened for one agent). Paseo's agent and workspace hooks work only in panels and popovers, not plugin screens, so the server now sends each agent's title and workspace name (`tags.list`, new `agents.describe`), and a test keeps those hooks out of the plugin.
- Agent picker rows name a plain-folder workspace once ("checkout-web", not "checkout-web / checkout-web").
- Adding a tag before the agent has loaded, or to an agent Paseo has no workspace for, now says which of the two happened.

## 0.11.1 - 2026-10-28

### Added

- The Contextualise logo: the plugin's icon in Paseo's plugin list (`paseo-plugin.json` `icon`), and the mark on the Tags sidebar row and the Settings > Contextualise entry, drawn in the theme's color.

### Changed

- Test fixtures use made-up names and links only; history was rewritten to remove real ones.

## 0.11.0 - 2026-10-28

### Added

- Pinned agents: pin from the Tags pill or the Command Center ("Pin this agent", "Unpin this agent"). Pinned agents come first in Attach > Agent conversation with "pinned" in the subtitle (even when archived agents are hidden) and are listed at the top of the Tags screen.
- Token estimates (`~1.2k tokens`) at the end of every agent, tag, and terminal picker row and in the tag Preview header. Settings > Pickers > Show token estimates.
- Fetch results in the asking agent: a fetch started with `/tag-fetch` or the Tags pill's Fetch box adds one row to that agent's conversation when it ends (title and size, or the reason it failed), with Read (opens the item on the Tags screen) and Open tags. A refresh of the item replaces the row. Settings > Fetching > Show fetch results in the agent.
- Automatic refresh of fetched items (Settings > Advanced, off by default): ready items older than 1 to 168 hours (default 24) are fetched again, checked every 15 minutes. Automatic refreshes never add rows to agents.
- Empty states: Fetch an item on the empty Tags screen; a hint in the Tags pill when the agent has no tags.

### Changed

- `tags.json` is now version 4 (adds pinned agents). Older files are upgraded on the next change; plugin versions before 0.11.0 then refuse the file.

## 0.10.0 - 2026-10-28

### Changed

- Attach picker rows start with the title: no "Claude", "Tag", or "Terminal" word before it (Settings > Pickers can bring the words back). Paseo draws plugin picker rows from text only, so they cannot carry icons; the source's icon still shows in the Attach menu and on the attached pill.
- Long links in agent titles are shortened to the host and the last two path parts (github.com/…/1234/files).

### Added

- Settings > Pickers: row prefix (none or words), results per picker (moved from Attachments), shorten links in agent titles, which parts agent subtitles show (workspace, running or archived, last active), whether archived agents appear, and sort agents by most recent activity or title.
- Settings > Tags pill: longest tag name shown on the pill (10 to 60, default 24).

## 0.9.0 - 2026-10-28

### Changed

- Icons throughout the Tags screen, the Tags pill's popover, the fetch form, and the item reader: tag headers, section headers with counts (agents, workspaces, links, fetched items), vendor icons on fetched items (Jira, Sentry, Slack, Notion), colored status icons (fetching, ready, failed), and icon buttons for read, refresh, remove, copy, and open. Collapse uses chevrons; sorting, expand all, and collapse all are chips; the filter has a search icon and a clear button.
- Links on the Tags screen open when tapped.
- Attach > Agent conversation: titles drop Markdown marks (`**`, backticks, headings) and extra spaces, and the subtitle shows the workspace, whether the agent is running or archived, and how long ago it was active.

### Notes

- Paseo's Attach picker draws each row from text only, so plugins cannot put an icon on a row; the source's icon shows in the Attach menu and on the attached pill.

## 0.8.0 - 2026-10-27

### Fixed

- The Attach pickers could not scroll: each search returned at most 6 results, so there was nothing below the visible rows. Searches now return 20 by default, and the pickers scroll through them.
- Agent rows in the picker started with the word "Agent", which crowded out titles, and the attached pill read "Agent conversation Agent". Rows and pills now show the agent's provider (Claude, Codex), and the subtitle shows the workspace.

### Added

- Setting: results in the Attach pickers (Attachments; default 20, from 5 to 50).

## 0.7.0 - 2026-10-27

### Added

- Codex can fetch too. Built-in routes: Claude for Jira, Sentry, Slack, and Notion; Codex for Notion. "Fetch with" chooses automatic (Claude, then Codex), Claude only, or Codex only; each fetch can override it.
- Custom routes (Settings, Advanced): another agent and MCP server for a vendor, with the exact read tools it may use. Routes are used only when that agent has the server configured.
- Codex workers run in Codex's "auto" mode with a read-only sandbox and no web search; the plugin allows only the route's tools when Codex asks, and every decision is logged.
- Settings, grouped into Attachments, Tags pill, Fetching, and Advanced: which parts a tag attachment includes, pill on or off and its label style, models per agent, fetch time limit, fetches at once, stored item size, comments per item, extra instructions for workers, custom routes. Each field shows its own error.
- Fetch form shows which agent and connector will read an item, or why none can, before it starts; the pill's popover has a Fetch box for the agent's tags.
- Tags screen: summary line, sort by recent, name, or size, collapsible tags with Expand all and Collapse all, filter that also matches fetched items, and a reader for fetched items with Copy and Open.

### Changed

- Fetched items record the agent that fetched them. Items from 0.6.0 show none.
- OpenCode is never used for fetching: in testing it ran shell commands without asking.

## 0.6.0 - 2026-10-27

### Added

- Fetch Jira, Sentry, Slack, and Notion items into a tag: `/tag-fetch <ref> <tag>` or **Fetch item** on the Tags screen. A hidden background Claude agent reads the item through the connectors Claude agents already have; the plugin holds no vendor credentials.
- The worker may use only the named read tools of that vendor's connector; every other tool request is denied, and every decision is written to the plugin log.
- **Fetched items** on each tag (status, Refresh, Remove); ready items are included in Attach > Tag, redacted like other attachment text.

### Changed

- `tags.json` is now version 3 (adds fetched items). Versions 1 and 2 are read and upgraded on the first change; older plugin versions refuse a version 3 file instead of dropping items.

## 0.5.0 - 2026-10-27

### Added

- `/untag` is back: `/untag auth-rewrite`, or several with `/untag auth, billing`. The pill's label confirms it; an `/untag` that changes nothing says "Not tagged".

## 0.4.0 - 2026-10-27

### Added

- `/tag` is back alongside the Tags pill: `/tag auth-rewrite`, or several with `/tag auth, billing`. The pill's label confirms it; a `/tag` that changes nothing says "Already tagged". Removing tags stays in the pill.

## 0.3.0 - 2026-10-27

### Added

- A **Tags** pill on every active agent's composer. Its label shows the agent's tags; pressing it opens a popover to remove tags, add new ones, add existing ones with one tap, or open the Tags screen.

### Removed

- `/tag`, `/untag`, and `/tags`. The Tags pill replaces them. `/tag-link` stays.
- Tagging no longer adds a confirmation row to the agent's timeline; the pill label shows the result. Rows added by 0.2.1 still display.

## 0.2.1 - 2026-10-27

### Fixed

- The plugin failed to load in the Paseo app ("Invalid timeline renderer kind: contextualise.receipt"): Paseo accepts only lower-case letters, digits, and hyphens in registered names. The confirmation row's kind is now `receipt`. A new test runs the real app-side registration against Paseo's naming rule, so a bad name fails the tests instead of the app.

## 0.2.0 - 2026-10-27

### Added

- **Agent conversation** attach source: any agent on the host, matched on title, provider, workspace, and folder. Clicking the attachment opens that agent.
- **Terminal output** attach source: the newest lines of any terminal on the host.
- Link tags: `/tag-link <url> <tag>` and **Add link** on the Tags screen. Links are listed in the tag attachment.
- `/tag` and `/untag` take several tags separated by commas.
- `/tags` and "Tag this agent..." open the Tags screen for one agent, with its tags as chips to remove and other tags as chips to add.
- One confirmation row in the agent's timeline after `/tag` and `/untag`, replaced on each use, with an "Open tags" link.
- **Preview** on each tag: exactly what Attach > Tag sends, with Copy.
- Filter box on the Tags screen.
- Setting: terminal lines to attach (default 200).

### Fixed

- One agent whose history cannot be read no longer breaks the whole Attach > Tag picker; that agent is shown with the reason and the rest attaches.
- Secret-shaped text in conversations and terminal output is replaced with `[removed: <kind>]` before it is attached.
- The attached tag pill no longer shows the tag name twice, and clicking it opens documentation instead of an unusable `paseo://` link.
- Error toasts show the plugin's message without transport details.
- Settings show the stored value after saving (`0` becomes the default).
- The picker reuses the agent and workspace list for 5 seconds instead of reading it on every keystroke.

### Changed

- `tags.json` is now version 2 (adds links). A version 1 file is read and upgraded on the first change; 0.1.0 refuses a version 2 file instead of dropping links.
- `/tag` on an already-tagged agent reports it in the confirmation row instead of as an error.

## 0.1.0 - 2026-10-27

- First release: `/tag`, `/untag`, Tags screen, Attach > Tag, merging tags with Paseo workspace labels.
