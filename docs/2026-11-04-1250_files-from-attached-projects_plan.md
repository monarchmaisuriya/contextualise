# Attach > Project file: pick a file or folder from attached projects

- Date: 2026-11-04 12:50
- Status: done (released as v0.26.0, 2026-11-04)
- Repos: contextualise   Folders: server/knowledge/, shared/   Files: server/knowledge/attached-files.ts (new), server/knowledge/attached-files.test.ts (new), server/knowledge/plugin.ts, server/knowledge/plugin.test.ts, shared/linked-projects.ts, index.client.tsx, README.md, OVERVIEW.md, CHANGELOG.md, package.json
- Subagents: none

## Context and problem

In a chat whose workspace has attached projects, typing `@` lists only the chat's own folder (recording of 2026-11-04 12:43, a backend project with "Attached (1)"). M wants to pick files and folders from the attached projects as well. The options are in `2026-11-04-1250_files-from-attached-projects_research.md`.

## Goals / Non-goals

- **Goal:** from the composer, M searches files and folders across attached projects, picks one, and it joins the message being written. The chat is told its absolute path, as `@` tells it a relative one.
- **Goal:** each keystroke answers in under about 150 ms once a folder is listed, with a small payload.
- **Non-goal:** changing Paseo's `@` list. The plugin cannot do that; it can be proposed to Paseo separately.
- **Non-goal:** the chat's own folder, which `@` already covers.
- **Non-goal:** a new setting.

## What is true today

- **`@` searches one folder:** Paseo's `@` calls `getDirectorySuggestions` with the chat's `cwd` [verified: paseo `use-agent-autocomplete.ts:414-470`]. No plugin API reaches it or the composer text [verified: `@getpaseo/plugin/dist/client/contracts.d.ts:142-165`].
- **What an Attach search is given:** only `{ query }` [verified: paseo `plugin/src/client/host.ts:13-19`]. The picker searches again on every keystroke, caching each exact query for 30 s [verified: `plugins/attachments/picker.tsx:18, 89-110`].
- **The picker filters rows itself:** it keeps a row only when the typed words match its label (`identifier title`) or `id`, or its subtitle as a fallback, and re-sorts them [verified: `picker.tsx:69-75`, `components/ui/combobox-options.ts:20-29, 59-75`].
- **An item's text** goes into the prompt verbatim [verified by reviewer: paseo `plugins/attachments/model.ts:57-74`].
- **Attached folders:**
  - `knowledge/links.json` maps a workspace to at most 5 real paths [verified: `server/knowledge/links.ts:7-18`].
  - The path is checked when it is added [verified: `links.ts:32-50`].
  - A link made from an attached workspace lapses once Paseo no longer has that workspace [verified: `plugin.ts:197-208`].
  - Attaching works while project knowledge is off [verified: `plugin.ts:592-602` uses `server.handle`].
- **Helpers:**
  - `git(cwd, args, timeoutMs)`; the default timeout of 1.5 s is too short for a listing, and the indexer uses 20 s [verified: `git.ts:10, 28`; `indexer.ts:12`].
  - `folderSignatures` walks a folder outside git, skipping hidden and build folders but not hidden files, and returns nested repositories separately [verified: `walk.ts:17-45`].
  - `pickerPrefix` and `pickerTitleMaxChars` shape every picker row [verified: `shared/contracts.ts:398, 405`].

```
Attach menu -> "Attach Project file" -> picker (asks again on each keystroke)
   -> RPC linked.files.search { query }                              <-- new
        live links of every workspace, read once per search
        each folder: realpath still equal to the stored one, else skipped
        file list per folder (git ls-files, or a walk), cached 10 s
        rank names and paths; top 30 checked with lstat
   <- items: id = absolute path, title = path in project, text = short reference
-> M picks one -> pill in the draft -> sent with the message
```

## Options considered

| Option | How | Tradeoffs | Completeness |
| --- | --- | --- | --- |
| A. Attach > Project file | a new attachment source over attached folders | it is in Attach, not under `@`; it covers every workspace's attached projects | 8/10 |
| B. Paseo `@` change | an upstream API so `@` searches plugin-named folders | needs Paseo maintainers | 0 now, 9 later |
| D. Files in the Attached popover | a search scoped to this workspace; picking sends a message at once | cannot join the draft | 5/10 |

RECOMMENDATION: A, because it is the only option that joins the message M is writing and works today.

## Decision

Build A. Listing and ranking live in a new module, `attached-files.ts`. `plugin.ts` only feeds it the live attached folders. The structural reason: `WorkspaceLinks` owns which folders are attached, and Attach is the only composer surface Paseo lets a plugin fill.

**What a row attaches.** Two choices; recommended first, and the open question for M:

1. **A reference (recommended):** the absolute path, the project, and whether it is a file or folder, like `@`. The chat reads the file itself. Each keystroke stays small. New chats in a workspace with links can read and edit the folders already.
2. **The content too:** each row would carry up to `snapshotMaxChars` (40,000 by default). Because the picker asks again on every keystroke, 30 rows could send about 1.2 MB per keystroke. It would need file reads, redaction and capped reads on every search.

## Design (with the reference)

- **Source** (`shared/linked-projects.ts`):
  - `searchAttachedFilesRpc` is `linked.files.search`, with input `{ query }` and output `PluginAttachmentSearchPayloadSchema`.
  - `attachedFileAttachmentSource` has id `attached-file`, title "Project file" (the menu reads "Attach Project file"), icon `FileSearch`, picker title "Attach a file or folder from an attached project", and placeholder "Search files and folders in attached projects".
  - It is registered in `index.client.tsx` next to the other sources.
- **Which folders** (`plugin.ts`):
  - Paseo's workspaces are read once per search to drop lapsed links (not once per linked workspace).
  - The remaining links of every workspace are deduplicated by path.
  - A folder whose real path no longer equals the stored one, or that is gone, is skipped.
  - A folder inside another attached folder is searched once, under the outer one.
- **File list** (`attached-files.ts`, `listFolder(path)`):
  - **In git:** `git ls-files -co --exclude-standard -z` in the folder, with a 20 s timeout. This leaves gitignored files out, includes untracked ones, and gives paths relative to the folder.
  - **Outside git:** `folderSignatures` keys, without hidden files (names starting with "."), like Paseo's `@`. Nested repositories found by the walk are listed with their own `git ls-files` and prefixed.
  - **Folders** are the parents of the listed files.
  - **Limits:** at most 50,000 files a folder, cached 10 s, one listing at a time per folder.
  - **On failure:** a failed listing is logged and that folder offers nothing. The search still answers for the others.
- **Ranking** (`rankEntries(entries, query, limit)`), lower tier first, then shorter path, then alphabetical:
  1. name equals the typed words;
  2. name starts with them;
  3. name contains them;
  4. path contains them;
  5. every word appears in the path.

  With no words, it offers each attached folder itself, then its top-level entries. It returns 30 rows at most, after an `lstat` of each row: a deleted file is dropped, and a submodule or symlinked folder counts as a folder.
- **Rows**, built to pass Paseo's own filter:
  - `id`: the absolute path, so any part of the path matches;
  - `title`: the path inside the project, cut from the start when it passes `pickerTitleMaxChars`, so the name stays visible;
  - `identifier`: "File" or "Folder" when `pickerPrefix` is "word", else empty;
  - `subtitle`: `<project name> · <full path in the project>`;
  - `url`: a `file://` URL (accepted by the schema; Paseo does not open it);
  - `resourceType`: `attached-file`.
- **Text:**
  - `SNAPSHOT_HEADER`;
  - "File `<absolute path>` (`<path in project>` in the attached project `<name>`). Read it from that path; its content is not included."
  - For a folder: "Folder `<absolute path>` (...). List or read it from that path."
  - The path line goes through the same one-line cleaning that `linksSection` uses, so a file name cannot break the text.
- **Safety:**
  - The input is only the typed text, and every path comes from listing an attached folder. No path from the app reaches the filesystem.
  - Nothing is read except listings and `lstat`.
- **No new config value.**
- **Auth:** the plugin's own RPC, called from M's app over the daemon connection, like the other Attach searches.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| Offers projects attached to other workspaces | certain while more than one workspace has links | low | the subtitle names the project; a reference grants no access | M sees an unexpected project |
| The chat cannot read the path (it started before the link) | medium | low | the text says to read it from the path; the agent asks M, and New Chat from Attached gives access | the agent asks for permission |
| A big folder's first listing is slow | low | medium | 20 s timeout, then a 10 s cache; measured: M's attached project (2,798 files) lists in under 0.2 s | slow first search |
| A typed query hides rows Paseo's filter rejects | low | medium | id is the absolute path and subtitle the full path; a test checks every row contains every typed word | rows missing |
| A path with a newline or comment marker | low | low | one-line cleaning, as `linksSection` does | test |

## Acceptance criteria

- **File in a git project:** given an attached git project, when M types part of a file's name, then that file is a row, with the project's name and full path in its subtitle.
- **Gitignored file:** given a gitignored file, when M searches its name, then it is not offered.
- **Matches survive Paseo's filter:** given any typed words, then every returned row contains every word in its id, title or subtitle.
- **Deleted file:** given a deleted tracked file, then it is not offered.
- **Hidden file outside git:** given a hidden file outside git, then it is not offered.
- **What a row attaches:** given a file row or a folder row, when picked, then its text names the absolute path and the project and says the content is not included.
- **Lapsed link:** given a link from an attached workspace Paseo no longer has, then its folder is not searched.
- **Moved folder:** given an attached folder that is now a symlink or gone, then it is not searched.
- **No links:** given no attached projects, then the search returns no rows.
- **Cached listing:** given a repeated search within 10 s, then the folder is not listed again.
- **Knowledge off:** given project knowledge is off, then the search still works.

## Rollout and rollback

Ships as 0.26.0 (new feature). Rollback: reinstall 0.25.1. Nothing is stored, so nothing needs migrating.

## Parts

### Part 1: listing and ranking
- [x] `attached-files.ts`: `listFolder`, `rankEntries`, `attachedFileItem`. Done: unit tests for the criteria they cover, each seen failing first.

### Part 2: wire the source
- [x] The RPC, the source and its registration; the handler over live links. Done: plugin tests for live, lapsed, moved and absent links, and `registrations.test.ts`.
- [x] Timing on M's attached project (read only). Done: time and payload size for an empty and a typed query.

### Part 3: ship
- [x] README, OVERVIEW, CHANGELOG, 0.26.0; an independent review of the diff; fix its findings. Done: tests and typecheck pass.
- [x] Merge, tag, release, reinstall. Done: `paseo plugin ls` shows the new commit. Registry pin PR only if M asks.

## Standardized review

Reviewer: one fresh subagent, given only the two files and the code; it read Paseo `origin/main` de4590265. I checked the decisive findings myself.

Typed bottom line after changes: **ready, 0 blocking, 0 must-verify, 1 open question for M.**

| Finding | Severity | Checked | Change |
| --- | --- | --- | --- |
| "Paseo debounces the search" is false. Rows with content would send about 1.2 MB per keystroke | blocking | stands [verified: `combobox.tsx` `applySetSearchQuery`; `picker.tsx:89-110`] | Rows carry a reference by default; content is the open question |
| Paseo filters rows by label and id, with subtitle only as a fallback. A cut title would hide matches | blocking | stands [verified: `combobox-options.ts:20-29`; `picker.tsx:69-75`] | id = absolute path; full path in subtitle; test |
| A pill knows its workspace and can send with attachments, so a scoped option was missing | must-verify | stands [verified: `buttons.d.ts:5-12`; client `index.d.ts:290`] | Option D added; it cannot join the draft (5/10) |
| `readProjectFile` refuses big files and doesn't follow parent symlinks | must-verify | moot with references | No file reads |
| Link real path not re-checked; the walk offers hidden files | must-verify | stands [verified: `links.ts:32-50`; `walk.ts:38-43`] | realpath check per search; hidden files left out |
| `liveLinks` lists all workspaces per call | note | stands [verified: `plugin.ts:199-203`] | One workspace read per search |
| Deleted tracked files, submodules, nested repos, git timeout, nested links | note | stands | lstat on rows; nested repos listed; 20 s timeout; dedupe |
| Redaction rewrites code; non-UTF-8 decoding | note | moot with references | none |

### Criterion coverage

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Goal fidelity | pass | joins the draft like `@`; the `@` limit is shown to be Paseo's |
| Current-system accuracy | pass after fixes | debounce claim removed; filter behaviour cited |
| Scope and cohesion | pass | no setting; listing in its own module |
| Architecture | pass | links stay owned by `WorkspaceLinks`; the source is the only reachable surface |
| Sequencing | pass | module -> wiring -> ship |
| Completeness | pass | docs, version, release |
| Failure and recovery | pass | per-folder failure is logged; nothing stored |
| Verification | pass | a test per criterion; timing and payload measured |
| Feasibility | pass | every API named exists |
| Decision readiness | pass | content-or-reference is left to M |

## Changes made

- **Parts 1 and 2:** `attached-files.ts` lists, ranks, and turns entries into rows. `links.files-search` searches the live attached folders of every workspace Paseo still has, and the source is "Attach > Project file". 478 tests pass, including 24 new ones; each new check was broken on purpose and its test failed.
- **Timing on M's attached project** (a dashboard project, 2,798 files): 98 ms for the first search (listing included), then 1 to 3 ms a keystroke, with at most about 21 KB of rows.
- **Code review (independent):** no blocking finding, no safety escape. Fixed:
  - nested repositories and submodules inside a git folder are listed (git shows them as one entry);
  - a conflicted file is listed once;
  - an attached folder its repository ignores is walked;
  - ranking matches a word in the project name or the path, never across them, as Paseo's filter does, and the test now applies Paseo's rule;
  - links of a workspace Paseo no longer has are skipped;
  - an expired listing answers while the new one is read, and listings unused for a minute are dropped;
  - one nested repository that fails no longer fails its folder;
  - links.json is read once per search.
- **Deviations from the plan:**
  - the RPC is `links.files-search`, matching the other `links.*` names;
  - paths in the text are JSON strings instead of `linksSection`'s one-line cleaning, so they stay exact;
  - a folder inside another attached folder is no longer skipped (its outer listing may not cover it); duplicate rows are removed by path instead.
- **After M tried it (2026-11-04):**
  - look-alike titles are told apart by the folder where the paths differ (`2a1f163`);
  - the Attached button has a Project files tab, scoped to its workspace; picking a row copies the path the way `@` writes it (`7a5991a`);
  - Attach > Project file is listed only while some workspace has a live attached project (`7a5991a`).
- **Final review (independent, nine principles):** no blocking finding. Fixed (`1adcf4e`):
  - one rule for which attached folders count, used by every reader, with skipped folders logged;
  - the Project files tab is its own component, and its list refreshes when a project is detached;
  - choosing the tab is a tested function, and the tab stays put while links load;
  - the menu entry's check runs one at a time, so a stale answer can't list it again;
  - same-name attached folders are told apart;
  - an unknown workspace is refused.
- **Release:** v0.26.0 (`17f920b`). M's daemon runs it, and the log shows "Plugin ready".
- **Left as is:**
  - subsequence matches Paseo would accept (such as `uaa`) are not offered, because the server matches substrings;
  - the 50,000-file cap keeps tracked files before untracked ones.

## Open questions

1. Reference or content? Recommended: reference.
2. Raise the Paseo `@` proposal? Recommended: later, separately.
