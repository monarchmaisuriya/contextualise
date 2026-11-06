# Files and folders from attached projects in the composer

- Date: 2026-11-04 12:50
- Status: presented
- Mode: explore options
- Repos: contextualise (read: paseo origin/main de4590265)   Folders: server/knowledge/, shared/, client/
- Question / problem: when a workspace has attached projects, how can M pick a file or folder from them in the composer, the way `@` picks one from the chat's own folder?

## Options: let M pick files and folders from attached projects in the composer

- **Bottom line:** a plugin cannot add entries to Paseo's `@` list. Contextualise can add an Attach entry, "Project file", that searches files and folders across attached projects and attaches the chosen one. Recommended: build that now. Optionally, propose an `@` extension to Paseo separately.
- **Where we are:** framing done; Paseo app, plugin SDK and Contextualise code read; the plan is in `2026-11-04-1250_files-from-attached-projects_plan.md`.
- **Need from M:** pick an option.

### The problem, framed

- **What:** the recording (`Screen Recording 2026-11-04 at 12.43.54 PM.mov`, 16 s) shows a chat in a backend project with "Attached (1)". Typing `@` lists only that project's own folders. Nothing from the attached project appears.
- **Why:** M wants to point a chat at a specific file or folder in an attached project as easily as in its own folder.
- **Who:** M, in any workspace with attached projects.
- **Where:** the composer.
- **How much:** one new search over a few folders (at most 5 attached per workspace).

### What must be true

| Fact | Tag |
| --- | --- |
| Paseo's `@` list searches only the chat's own folder: it calls `getDirectorySuggestions({ cwd })` with the agent's `cwd` and inserts a quoted relative path | [verified: paseo `packages/app/src/hooks/use-agent-autocomplete.ts:414-470`, `utils/file-mention-autocomplete.ts:48-57`] |
| No plugin contribution reaches the `@` list or the composer text. The client registrations are screens, panels, sidebar items, Command Center items, slash commands, header buttons, composer pills, attachment sources, themes, and file panels | [verified: `node_modules/@getpaseo/plugin/dist/client/contracts.d.ts:142-165`; plugin reference has no mention API] |
| An attachment source's search gets only the typed text, not the chat or workspace | [verified: paseo `packages/plugin/src/client/host.ts:13-19` passes `{ query }`] |
| An attachment's `text` is fixed when the search returns. No server hook runs when a message is sent, so it cannot be filled in later | [verified: plugin server hooks are before workspace.create, before agent.create and agent.session_open, and on agent created/turn_started/turn_ended/permission_*/archived/closed and workspace.created/archived; no send hook] |
| Paseo's Attach picker searches again on every keystroke, with no debounce, and caches each exact query for 30 s | [verified: paseo `components/ui/combobox.tsx` `applySetSearchQuery`; `plugins/attachments/picker.tsx:18, 89-110`] |
| The picker then filters and re-sorts the rows itself: a row stays only if the typed words match its label (identifier and title) or id, or its subtitle as a fallback | [verified: paseo `picker.tsx:69-75`, `components/ui/combobox-options.ts:20-29, 59-75`] |
| A composer pill knows its workspace and chat, and can send that chat a message with text attachments; it cannot add to the draft | [verified: `@getpaseo/plugin/dist/client/buttons.d.ts:5-12`; `@getpaseo/client/dist/index.d.ts:290` `send(text, options)`] |
| Attached folders are stored per workspace in `knowledge/links.json`, at most 5 per workspace; across workspaces there is no cap | [verified: `server/knowledge/links.ts:7, 56-125`] |
| The plugin server can list a git folder's files fast with `git ls-files`, and read a file safely (no symlinks, size cap) | [verified: `server/knowledge/git.ts:28`, `server/knowledge/files.ts:7-13`] |

### Options

| | A. Attach > Project file | B. Paseo change: `@` also searches attached folders | D. "Files" in the Attached popover |
| --- | --- | --- | --- |
| How it works | A new Attach entry searches files and folders in every attached project. Picking one adds a pill to the message being written; its text names the absolute path | Paseo's `@` list would also search folders a plugin names for the chat, and insert their absolute paths | The Attached popover, which knows this workspace, gets a file search. Picking a file sends the chat a message at once, with the file attached |
| Fit with our code | Same shape as Attach > Project and Chat; reuses links and git listing | Needs a new plugin API in Paseo | Reuses the popover and links |
| Scope | Every workspace's attached projects (the search is not told the workspace) | This chat's folders | This workspace's attached projects only |
| Fits writing a message | Yes: it joins the draft like any attachment | Yes, inline | No: it sends immediately and cannot add to the draft |
| Cost and blast radius | Contextualise only: one RPC, one source, tests | Paseo app plus plugin SDK; Paseo maintainers decide; timing not ours | Contextualise only |
| Completeness | 8/10 | 9/10 when merged; 0 until then | 5/10 |

RECOMMENDATION: A now, because it is the only one that joins the message M is writing and works today. B can be proposed to Paseo separately if M wants `@` itself to change.

### Rejected

- **Inserting `@path` into the message from a pill or slash command:** no plugin API writes composer text [verified: `contracts.d.ts:142-165`; slash commands get `onSubmit({ args, ... })` only, `contracts.d.ts:276-288`].
- **Narrowing the Attach search to the current workspace:** the search is not told the workspace [verified: `host.ts:13-19`]. Guessing it, for example from the last popover opened, would be wrong with two windows open.

## Standardized review

One independent reviewer read this brief and the plan against Paseo `origin/main` and the Contextualise code; the findings and what changed are in the plan's review. For this brief: the debounce claim was false and is removed; option D (the popover, which does know the workspace) was missing and is added; the hook list and the "5 per workspace" wording are corrected.
