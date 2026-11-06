# Linked projects: suggest every Paseo project, not only indexed ones

- Date: 2026-11-02 20:15
- Status: done (released 0.23.1, 2026-11-02)
- Repos: contextualise   Files: `server/knowledge/plugin.ts`, `server/knowledge/plugin.test.ts`, `shared/linked-projects.ts` (comment only), `CHANGELOG.md`
- Subagents: none
- Follows: `docs/2026-11-02-1930_linked-projects_plan.md` (0.23.0)

## Context and problem

The Linked popover's "Add a project" chips list only projects Contextualise has indexed, and none at all while Project knowledge is off. M: "it should allow all projects that have workspaces, not just ones with memories or knowledge". On M's machine Paseo has 11 projects with workspaces; Contextualise has indexed 7, so 4 cannot be picked (they can only be typed as a path).

## Goals / Non-goals

Goals: the chips list every Paseo project (each has at least one workspace), whether or not it is indexed and whether knowledge is on or off.

Non-goals: listing each worktree of a project as its own chip (one project alone has 33 workspaces); changing how a link is applied.

## What is true today

- Suggestions come from `base.projects()` (the knowledge index) and are empty while knowledge is off [verified: `server/knowledge/plugin.ts`, `linksPayload`, `suggestions: (await knowledgeOn()) ? (await base.projects())… : []`].
- Paseo lists its projects with `paseo.projects.list()`, including projects whose workspaces were all archived (15 on M's machine against 11 with workspaces) [verified by review: daemon `handleProjectListRequest` filters only archived projects; `paseo project ls --json`]. It lists them: `projectId`, `projectDisplayName`, `projectCustomName`, `projectRootPath` (the project's own checkout or folder), `projectKind` [verified: `node_modules/@getpaseo/client/dist/index.d.ts:61-65,132-133`; `protocol/dist/messages.d.ts:10110-10124, 11244-11258`]. The installed daemon handles the request [verified: `project.list.request` found 6 times in `app.asar`].
- Each workspace names its project (`projectId`) [verified: `messages.d.ts`, workspace entry fields `id`, `projectId`].
- `paseo workspace ls --json` on M's machine: 65 workspaces in 11 projects [verified].
- Adding a link already checks the folder (`linkableFolder`: exists, is a folder, not home or `/`, not overlapping the workspace or Paseo's data folder) [verified: `server/knowledge/links.ts`].

## Options considered

| Aspect | A: Paseo's project list (recommended) | B: every workspace folder | C: index plus workspace roots merged |
| --- | --- | --- | --- |
| How | `paseo.projects.list()`, one chip per project, its root folder | one chip per workspace folder | `base.projects()` plus `projectRootPath` of each workspace, de-duplicated |
| Fits | one call; Paseo's own names and folders | 65 chips on M's machine, mostly worktrees | two sources to merge and name |
| Fails when | M wants a worktree, not the main checkout: types its path (as today) | too many chips to scan | names disagree between sources |
| Completeness | 9/10 | 6/10 | 7/10 |

RECOMMENDATION: A, because Paseo's project list is exactly "every project that has workspaces", with the names M sees in the sidebar.

## Design

- `linksPayload` builds suggestions from `paseo.projects.list()`: name `projectCustomName ?? projectDisplayName`, path `projectRootPath`; sorted by name.
- Left out: the workspace's own project (same `projectId`), folders already linked, and any folder `linkableFolder` would refuse for this workspace (checked with the same function, so the chips never offer what Add would reject). A folder that no longer exists is left out by that check.
- Independent of the knowledge switch and the index. `base.projects()` is no longer used here.
- If Paseo's project list fails, suggestions are empty and the error is logged; links themselves still list (the typed path still works).

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| A project's root is a broad folder (`~/Develop` holds other repos) | medium | linking it gives the whole folder | allowed today when typed; the chip shows the path in its label so M sees it | M |
| Two projects share a display name | low | ambiguous chips | add the folder name when names repeat | test |
| `projects.list` slow or failing | low | no chips | empty suggestions, logged; typed path still works | log line |

## Acceptance criteria

- Given a Paseo project with workspaces that Contextualise never indexed, when the popover opens, then it is offered.
- Given Project knowledge is off, then every Paseo project is still offered.
- Given the workspace's own project, an already linked folder, a folder that overlaps the workspace, or a project whose folder is gone, then it is not offered.
- Each test fails on 0.23.0's code.

## Rollout and rollback

Patch release 0.23.1 if M asks for a release. Rollback: 0.23.0 (suggestions from the index again).

## Parts

### Part 1: suggestions from Paseo's projects

- [ ] Change `linksPayload`; tests for the criteria above. Done: tests red on 0.23.0, green after; full suite and typecheck pass.

### Part 2: notes

- [ ] CHANGELOG entry (unreleased until M asks). Done: entry written.

## Standardized review

Independent review, 2026-11-02: 1 blocking, 1 must-verify, 3 notes, all fixed.

- Blocking: `projects.list` also returns projects with no workspace (js-client, two plugin worker folders, a scratch trial project). Fixed: only projects with a visible workspace are offered.
- Must-verify: "not offered" tests would pass on old code. Fixed: the test also asserts siblings are offered; it fails on 0.23.0 ("expected [] to deeply equal [Backend, web2]").
- Notes: own-project exclusion by `projectId` holds; `projectRootPath` is the main checkout; already-linked is compared on real paths (via `linkableFolder`); no paging needed; failures are logged.

## Changes made

- Part 1: `suggestionsFor` in `server/knowledge/plugin.ts`; test red on 0.23.0, green after; 442 tests and typecheck pass.
- Part 2: CHANGELOG "Unreleased" entry.

## Open questions

None.
