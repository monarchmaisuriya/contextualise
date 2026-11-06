# Attached projects: attach from Attach > Project, Detach, search every attached project

- Date: 2026-11-02 20:00
- Status: done on branch feature/attached-projects (88b26b3), installed for M's test; not released
- Repos: contextualise   Files: `server/knowledge/{plugin,mcp,auth,links}.ts` and tests, `client/{linked-projects,link-pills,knowledge-screen}.tsx`, `client/registrations.test.ts`, `README.md`, `CHANGELOG.md`
- Follows: 0.23.0 to 0.23.2 (linked projects)

## Context and problem

M attached a dashboard project to a chat in a backend project through Attach > Project and expected it to be attached to the workspace. Three things went wrong (M, 2026-11-02, with screenshots):

1. The Linked popover showed no project to detach: nothing was stored, because Attach > Project only sends text [verified: no `knowledge/links.json` on M's machine].
2. M wants the words attached / detached, not linked / unlinked.
3. The agent's knowledge search covered only its own project, not the attached one.

M's answers: attaching from Attach > Project should also attach the project to the workspace, through the agent ("Yes, via the agent"); "unlink doesn't work" meant no detach option was shown.

## What is true today

- Paseo does not tell a plugin what was attached: the picker's search gets only `{query}` [verified earlier], no hook fires on send, and the timeline keeps only the typed text (`submittedPromptText` keeps text blocks without a MIME type; the agent's log shows only M's line) [verified: Paseo `agent-manager.js:40-47`; `paseo agent logs 1a0f0f19…`].
- Knowledge tokens carry `workspace` only when the workspace had links at creation [verified: `plugin.ts`, `prepareKnowledge(…, linkedWorkspace)`], and the hook looks up the workspace only when some workspace has links [verified: `linkedFor`, `links.workspaceIds()` fast path].
- `knowledge_search` without `project` searches only the agent's own project [verified: `mcp.ts`, `repoOf(undefined)` returns `own`].
- `session_open` knows the exact workspace but can only add tool servers per open, not change the stored token [verified: Paseo `agent-manager.js:3943-3968`]; not used here (see Options).

## Options considered

| Aspect | A: grant in the attachment, agent calls `project_attach` (picked by M) | B: Attached button only | C: move the knowledge server to `session_open` |
| --- | --- | --- | --- |
| How | The whole-project attachment carries a signed grant; the agent calls the tool; the server adds the project to its token's workspace | Attach > Project stays text | Exact workspace on every open |
| Fails when | The chat's workspace cannot be told (local workspace sharing a folder, or a chat created before this release): the tool says so | Attaching does not attach | Large rewrite of the create hook; stored server entries of old agents |
| Completeness | 8/10 | 5/10 | 9/10, cost too high now |

## Design

1. **Words.** Pill "Attached" ("Attached 2"), popover sections "Attached to this workspace" (chips detach: label "Detach <name>") and "Attach a project", buttons "New chat with attached projects" and "Continue this chat with them"; workspace panel section "Attached projects"; prompt section "## Attached projects (Contextualise)"; README and CHANGELOG. Internal names stay (`links.json`, `links.*` RPCs, `CONTEXTUALISE_LINK_WORKSPACE`): stored data and contracts.
2. **Workspace in every token.** The create hook resolves the workspace for every new chat (not only when some workspace has links) and mints the token with it when it is known (marker or a single folder match, background workspaces included).
3. **Project grant.** `TokenAuthority` signs a second grant kind, `{kind: "project", repoKey, top}`, with the grant prefix, so it cannot pass as a token or a conversation grant.
4. **`project_attach` tool** on the knowledge server: verifies the grant, requires the token's workspace, checks the folder with `linkableFolder` (same rules as the button), adds it to `links.json` (already attached: says so), and answers what changed: search covers it now; new chats here can edit it; this chat can read it, and edits outside its folder may ask M. Approved automatically like the knowledge tools (setting "Let agents search without asking"), since the grant only comes from M's pick.
5. **Whole-project attachment text** ends with "M attached this project. Call project_attach (MCP server paseo-contextualise) with grant: …". Single-entry rows do not attach.
6. **Search covers attached projects.** Without `project`, `knowledge_search` searches the agent's project and every project attached to its workspace now, each hit labelled with its project; `knowledge_read`, `knowledge_outline`, `knowledge_history`, `knowledge_impact` take `project` for an attached project's ids and paths (hits say which). The MCP dependency becomes `attachedProjects(workspace) => ProjectRoot[]`.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| Chats created before this release have no workspace in their token | certain | `project_attach` refuses | the tool says to start a new chat | tool answer |
| Local workspace sharing a folder | certain on M's machine (3 folders) | cannot attach from that chat | tool says to use the Attached button | tool answer |
| A grant pasted into another workspace's chat attaches there | low | an extra attached project | M sees it under Attached and detaches; grants come only from M's picks | Attached pill count |
| Search across projects is slower | low | slower search | each attached project searched at once; limit split | test |
| Auto-approved tool writes a setting | medium | a project attached without a prompt | only with a valid grant; same switch as the knowledge tools | Attached pill |

## Acceptance criteria

- Given a whole-project attachment, then its text carries a valid project grant.
- Given a chat in workspace W, when it calls `project_attach` with that grant, then W lists the project as attached; a token without a workspace, a forged grant, or a conversation grant are refused.
- Given a project attached to W, when a chat in W calls `knowledge_search` without `project`, then hits from both projects come back, labelled.
- Given a new chat in a worktree workspace with no links anywhere, then its token carries the workspace.
- Given the pill and panel, then they read Attached / Detach.
- Each test fails on 0.23.2.

## Rollout

Branch install for M's test (M: "will release after my test"); release later on M's word.

## Parts

- [ ] Part 1: workspace in every token; project grant; `project_attach`; attachment text. Tests.
- [ ] Part 2: search across attached projects. Tests.
- [ ] Part 3: words in UI, prompt, docs. Registration test.
- [ ] Part 4: full suite, typecheck; push branch; `paseo plugin update --ref <branch>`.

## Standardized review

Independent review, 2026-11-02: 2 blocking, 2 must-verify, 2 notes; all taken.

- Blocking: a project grant could be replayed from a transcript (conversation_read shows tool calls). Fixed: grants are signed per kind, lapse after an hour, and are used once (ids kept in links.json); `project_attach` is not approved automatically.
- Blocking: the workspace minted at create time fails where workspaces share a folder and for older chats. Fixed for attaching: `project_attach` is a Paseo agent tool given at `session_open`, and Paseo names the caller's workspace at call time [verified: Paseo `describeHookAgent`, `plugin-tools.js`]. Search still relies on the token's workspace; a same-name server from `session_open` collides with the stored one [verified: `resolveProviderLaunchConfig`], so shared-folder chats from Paseo's "+" search their own project only (stated in README).
- Must-verify: cost of listing workspaces on every create; accepted (one paged list and a realpath per workspace).
- Must-verify: id collisions across projects. Fixed: attached hits' ids start with the project key; test reads the same path from both projects.
- Notes: refusal tests now sit with a passing attach and check links.json; the "grant only from M's pick" claim corrected (every listed row carries one).

## Changes made

- Parts 1-3 in one commit, 88b26b3: grants, `project_attach` agent tool, token workspace, cross-project search with qualified ids, Attached / Detach words, pill recount on agent updates, README and CHANGELOG (Unreleased). 446 tests and typecheck pass; the three new tests fail on 0.23.2.
- Part 4: branch pushed and installed (`paseo plugin update --ref feature/attached-projects`); running.

## Open questions

None.
