# Attached popover: attach a workspace as well as a project

- Date: 2026-11-02 23:30
- Status: done on branch feature/opencode-attached-folders; installed for M's test; not released
- Repos: contextualise   Files: `server/knowledge/links.ts`, `server/knowledge/plugin.ts`, `shared/linked-projects.ts`, `client/linked-projects.tsx`, tests, `README.md`, `CHANGELOG.md`
- Subagents: one reviewer
- Follows: branch feature/opencode-attached-folders (unreleased 0.25.0 work)

## Context and problem

M wants the Attached popover to offer two kinds of things, with a Projects | Workspaces switch (M, 2026-11-02 23:26, "Yes, two tabs"):

- **Projects:** a project's main folder, as today.
- **Workspaces:** one workspace's own folder, for example another project's worktree on branch `fix/pr-948`, so new chats here can edit that exact checkout (like Conductor's linked workspaces).

## What is true today

- The popover lists projects only, one per Paseo project, by its root folder [verified: `plugin.ts:527-542`, `suggestionsFor`].
- A link is just a folder path stored per workspace; nothing in storage or in giving folders to chats depends on it being a project root [verified: `links.ts` `WorkspaceLinks`, `linkedProviderOptions`].
- Attaching refuses any folder inside Paseo's home (`~/.paseo`), to protect Paseo's settings and the knowledge tools' token secret (`plugin-data/contextualise/knowledge`) [verified: `links.ts:24-41`; `plugin.ts` `paseoHome()`].
- Paseo's worktree workspaces live in `<Paseo home>/worktrees/<id>/<slug>` [verified: `paseo workspace ls --json`, e.g. `~/.paseo/worktrees/22x8cau0/plant-turkey`; Paseo `utils/worktree.js` `getPaseoWorktreesRoot`]. So today none of them can be attached.
- Workspace entries give the plugin a name and title, project name, folder, kind (worktree or local), and branch [verified: `server/tags.ts:11-24`, `DirectoryWorkspace`; `rows.ts` `workspaceLabel`].

## Options considered

| Aspect | A: allow folders inside `<home>/worktrees/<id>/<slug>` only (recommended) | B: allow any folder of a listed Paseo workspace | C: keep refusing Paseo home; offer only local workspaces |
| --- | --- | --- | --- |
| Worktrees attachable | Yes | Yes | No (most of M's workspaces are worktrees) |
| Paseo data, plugin data, tokens | Still refused | Refused unless a workspace sits there (background workers do: `plugin-data/…`) | Refused |
| Typed paths | Same rule as the list | List-only rule, typed path differs | Same |
| Completeness | 9/10 | 7/10 | 4/10 |

RECOMMENDATION: A, because it opens exactly the folders Paseo makes for worktrees and nothing else in its home.

## Decision and design

1. **Folder rule (`linkableFolder`).** Paseo home stays protected, except a folder at least two levels inside `<home>/worktrees` (`<home>/worktrees/<id>/<slug>` or deeper), measured on the real path from `realpath(<home>/worktrees)`, so a symlink there into `plugin-data` stays refused. Only the "inside home" check is relaxed; a folder that holds the home stays refused. `<home>/worktrees` is fixed, never read from Paseo's config (a configured root like `.` would open `plugin-data`). `<home>/worktrees` itself and `<home>/worktrees/<id>` stay refused. Every other rule is unchanged.
2. **Payload.** `links.list` gains `workspaces: { workspaceId, name, path, project, branch, kind }[]`: every non-background Paseo workspace except this one (Paseo already leaves archived ones out), whose folder passes the rule, is not attached, and is not inside or around an attached folder; local workspaces whose folder is a project root offered under Projects are left out; sorted by project then name. Projects stay as `suggestions`.
3. **Popover.** A `Segmented` switch "Projects | Workspaces" above the search box, remembered for the session. Workspaces rows: title = workspace label (project / title), meta = branch · project, icon = a git-branch folder. Search matches name, project, branch, and folder. Attached rows stay one list, above the switch, for both kinds (a workspace shows its label, not just the folder name).
4. **Stored link.** Gains an optional `workspaceId` for workspace links (old links stay valid). When listing and when preparing a chat, a workspace link whose workspace Paseo no longer has is left out, so a deleted worktree's path reused by a later one is never handed over. Its label comes from that workspace.
6. **Codex note.** The prompt says a commit in an attached worktree needs M's approval in Codex (its git data is in the main repo's `.git`).
5. **Search and editing** work as for projects: the folder goes to new Claude, Codex, and OpenCode chats; `knowledge_search` covers it when Contextualise reads it as a project.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| Rule opens more of Paseo home than worktrees | low | a chat edits Paseo data | depth rule, tests for home, `worktrees`, `worktrees/<id>`, `plugin-data` | tests |
| A custom worktrees root outside home | low | those worktrees are offered like any folder (allowed already) | none needed | n/a |
| 65+ workspaces on M's machine | certain | long list | search plus the 30-row cap already in the popover | M |
| Attached worktree later archived; same path reused by a new worktree | low | a chat edits a different checkout | workspace links carry `workspaceId`; gone workspace drops the link | test |
| Write access to a worktree's `.git` pointer or `paseo.json` | low | Paseo later runs git there | same trust the workspace's own chats already have; no new kind of risk | n/a |

## Acceptance criteria

- Given a worktree workspace folder `<home>/worktrees/<id>/<slug>`, when attached, then it is stored and given to new chats.
- Given `<home>`, `<home>/worktrees`, `<home>/worktrees/<id>`, or `<home>/plugin-data/...`, then attaching is refused.
- Given the popover, then Projects and Workspaces tabs exist; Workspaces lists other non-background workspaces with branch, excluding this one and attached ones.
- Unit tests fail on the current branch head.

## Rollout and rollback

Same branch, installed for M's test; released with the rest as 0.25.0 on M's word. Rollback: reinstall v0.24.0.

## Parts

### Part 1: folder rule and payload
- [ ] `linkableFolder` worktree exception; `workspaces` in the payload; labels for attached workspaces. Done: tests red before, green after.

### Part 2: popover
- [ ] Segmented switch, workspace rows, search. Done: typecheck, registration test.

### Part 3: ship
- [ ] Suite, typecheck, commit and push the branch, reinstall on M's OK.

## Standardized review

Independent review, 2026-11-02: 0 blocking, 2 must-verify, 5 notes; all taken. Layout confirmed: all 50 of M's worktrees are exactly `~/.paseo/worktrees/<hash>/<slug>`, no symlinks or files at depth 1-2, worktree `.git` is a pointer file into the main repo.

- Must-verify: depth must be measured on the real path, and "holds home" kept: done in design 1; tests for the symlink case and `worktrees/<id>`.
- Must-verify: no archived field: checked, Paseo's list omits archived workspaces [verified: archived scratch workspaces absent from `paseo workspace ls --json`]; clause dropped.
- Notes taken: fixed worktrees root; `workspaceId` on workspace links; nested/duplicate folders left out of the tab; git side effects in risks; Codex commit line.

## Changes made

- Parts 1-2: worktree exception in `linkableFolder` (real path, depth >= 2 under `<home>/worktrees`); optional `workspaceId` on links, checked on attach and dropped when Paseo no longer has the workspace (list and chat prep); `workspaces` in the payload; Projects | Workspaces switch with branch rows. 455 tests and both typechecks pass; the 2 new tests fail on e243ac7.

## Open questions

None.
