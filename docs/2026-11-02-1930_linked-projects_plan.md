# Linked projects per workspace, full conversation reading, and the Attach "Project" option

- Date: 2026-11-02 19:30
- Status: done (released 0.23.0, 2026-11-02)
- Repos: contextualise   Folders: `server/`, `server/knowledge/`, `client/`, `shared/`, `index.client.tsx`
- Files: `shared/knowledge.ts`, `shared/contracts.ts`, `server/knowledge/pack.ts`, `server/knowledge/plugin.ts`, `server/knowledge/auth.ts`, `server/knowledge/mcp.ts`, `server/knowledge/section.ts`, new `server/knowledge/links.ts`, `server/sources.ts`, `server/snapshot.ts`, `index.client.tsx`, new `client/link-pills.tsx`, `client/knowledge-screen.tsx`, `client/settings-screen.tsx`, `README.md`, `OVERVIEW.md`, `CHANGELOG.md`, `package.json`, tests beside each
- Subagents: none
- Research: `docs/2026-11-02-1847_linked-projects_research.md` (Option A picked by M, with every recommended answer)

## Context and problem

M works on features that span a frontend and a backend. Today an agent in the frontend workspace can only see the backend as pasted text (Attach > Project knowledge), so it cannot change backend files, and M has to run two agents and carry context between them by hand. M wants what Conductor calls linked workspaces: link the backend to one frontend workspace, and every new chat or tab in that workspace can read and edit both. Other workspaces of the same project must not get the link.

Two smaller asks ride along: an attached conversation should be fully readable (today only its last 6 turns, without tool calls), and the Attach option "Project knowledge" should be called "Project". Only that option is renamed; the screen, sidebar, panel, and settings keep their names (M, 2026-11-02).

## Goals / Non-goals

Goals:

- M links one or more folders (another project) to a workspace from a composer pill on any chat in it, and unlinks them the same way (M, 2026-11-02: "also give an option to unlink").
- Every new Claude or Codex chat in that workspace starts with the linked folders readable and editable, a prompt note naming them, and their project knowledge through the existing tools.
- A running chat can get the link through "Add linked projects to this chat".
- An attached conversation can be read in full, tool calls included, by the agent it was attached to, and only that conversation.
- Attach > "Project knowledge" is called "Project".
- The Project screen shows the workspace's links, and the UI problems found in research are fixed.

Non-goals:

- Linking for providers other than Claude and Codex (they get a prompt note only; Paseo validates provider options strictly).
- Removing folder access from a running chat when the resume trial in Part 1 fails (Paseo saves folders with the agent; the UI then says the chat keeps access until it ends).
- Agents messaging each other (`conversation_send`), creating worktrees of the linked project, auto-approving edits.
- Renaming the screen, sidebar, panel, settings, tool names, RPCs, or stored keys.

## What is true today

- The agent-create hook (`server/knowledge/plugin.ts:199-237`) adds the project map to `systemPrompt` and the knowledge MCP server to `mcpServers`; it never stops an agent: any failure becomes one line in the prompt [verified: `plugin.ts:197-237`].
- The hook receives `config` and `env` only; no workspace id, prompt, or attachments [verified: Paseo `lifecycle/index.js:20`, `agent-manager.js:756-762`; `AgentSessionConfig`, `node_modules/@getpaseo/protocol/dist/agent-types.d.ts:451-472`]. It cannot change `cwd` [verified: `lifecycle/index.js:125-126`].
- Claude folders: `providerOptions.additionalDirectories` [verified: Paseo `claude/options.js:45`]. Codex: `providerOptions.sandbox_workspace_write.writable_roots`, applied only in `workspace-write` mode [verified: `codex/options.js:40`; review of `codex-app-server-agent.js:1615-1631`]. Both schemas are strict, checked after the hook, outside its error handling; a bad key fails agent creation [verified by research review: `agent/provider-options.js`, `agent-manager.js:757-781`].
- A plugin can list workspaces with their folders [verified: `client/dist/index.d.ts:136-146`, `protocol/dist/messages.d.ts:9074`] and create an agent in a workspace with `config`, `env`, `prompt`, `parent`, `labels` [verified: `client/dist/index.d.ts:113,169-190`].
- Local workspaces can share a folder: on M's machine 12 local workspaces share 3 folders; worktree workspaces have their own [verified: `paseo workspace ls --json`].
- Paseo's resume request accepts config overrides including `providerOptions` [verified: `protocol/dist/messages.js:1515-1520`; `client/dist/daemon-client.d.ts:931`]; it is not on `PaseoApi` [verified: `client/dist/index.d.ts:265-309`], and the `paseo agent` CLI has no resume-with-options command [verified: `paseo agent --help`].
- Composer pills and slash commands know the agent and workspace [verified: `client/tag-pills.tsx:16-41`, `index.client.tsx:62-71`].
- Knowledge tokens are HMAC-signed and stateless, scoped to one `{repoKey, top}` [verified: `server/knowledge/auth.ts:11-15,25-45`]. The permission handler auto-approves knowledge tools by exact name [verified: `plugin.ts:241-249`].
- Agent attachments carry the last `turnsPerAgent` (6) turns of user and assistant text within 40,000 characters, redacted [verified: `server/sources.ts:40-57`, `server/snapshot.ts:35-47`, `shared/contracts.ts:361-362`]. The full timeline with tool calls is readable with projection `canonical` [verified by research: `protocol/dist/messages.d.ts:12545`].
- Per-project choices are stored in `knowledge/projects.json` with serialized atomic writes [verified: `server/knowledge/prefs.ts:16-60`]; links will copy this pattern.
- The Attach option is defined at `shared/knowledge.ts:358-365` (title "Project knowledge", picker title "Attach project knowledge"); text that points to it: `server/knowledge/pack.ts:12`, `README.md:147,152`, `OVERVIEW.md:5` [verified: grep].

```
today:  new chat in FE ──> create hook ──> FE map + FE knowledge tools
                                            (BE only as pasted text, read-only)
```

## Options considered

From the research (`docs/2026-11-02-1847_linked-projects_research.md`), reviewed:

| Aspect | A: per-workspace links applied at creation (picked) | B: A with a worktree per link | C: A plus auto-approved edits | D: text only |
| --- | --- | --- | --- | --- |
| How | Link stored per workspace; create hook adds folders, note, tools; pill for running chats | Same, linking makes a worktree | Same, plus approving edit requests | Today |
| Fails when | Shared local folder and Paseo's "+" (no link, says why) | Worktrees left behind | Rests on unverified behaviour | Goal unmet |
| Completeness | 8/10 | 6/10 for simplicity | 7/10, flagged | 3/10, flagged |

RECOMMENDATION (accepted by M): A, because it is the only verified way a plugin can give an agent a second editable folder.

## Decision

Option A with M's answers: (1) a chat started from Paseo's "+" in a local workspace that shares its folder gets no link and is told why; the "New linked chat" pill is exact everywhere; (2) the linked folder is one M picks, defaulting to the project's last-used checkout; (3) attached conversations become fully readable, no messaging; (4) a running chat gets the link through Paseo's resume request if the Part 1 check passes, else by continuing as a new chat.

Structural reason: links are a property of a workspace, so they are stored by workspace id and applied where Paseo lets a plugin set folders, the create hook. The hook cannot see the workspace id, so it resolves it from the folder, and the plugin's own chat creation passes it explicitly.

## Design

### Data

`knowledge/links.json`, same write pattern as `prefs.ts`:

```
{ version: 1, workspaces: { "<workspaceId>": [ { path: "/abs/real/path", repoKey: "github.com/acme/api" | null, addedAt: ISO } ] } }
```

Validation on add: path exists, is a folder, is stored as its real path, is not the workspace's own folder, not the home folder or `/`, at most 5 links per workspace. `repoKey` is the project key Contextualise already computes for that folder (null when it has none).

### Applying a link (create hook)

```
new chat ──> agent.create hook
               │ which workspace?
               ├─ env CONTEXTUALISE_LINK_WORKSPACE=W (set by our pill)  -> W            <-- new
               ├─ exactly one workspace whose real folder = real(cwd)   -> that one      <-- new
               └─ several share the folder                              -> none, note    <-- new
               │ links of W (read fresh from links.json)
               ├─ provider claude: additionalDirectories += paths       <-- new
               ├─ provider codex:  sandbox_workspace_write.writable_roots += paths   <-- new
               ├─ other providers: no folders, note says why
               ├─ systemPrompt: "Linked projects" section                <-- new
               └─ knowledge token: + workspace W                         <-- changed
```

- Folder options are built per provider and merged with what is already set (deduplicated). Nothing is added for a provider not named here, so Paseo's strict check cannot fail on our keys.
- Prompt section (inside the existing Contextualise section markers): each linked path and its project name; "Run git in a linked project with `git -C <path>`, and commit each project separately"; "Search a linked project's knowledge with `project: <key>`"; for Codex, that commits in a linked project need M's approval.
- Any failure while resolving links becomes one line in the section, as today. The provider-options shape is covered by tests against Paseo's schemas (copied into a test fixture from the installed Paseo, with the version noted).

### Knowledge of linked projects

- Token scope gains optional `workspace`. Tools `knowledge_search`, `knowledge_read`, `knowledge_outline`, `knowledge_history`, `knowledge_impact` gain optional `project` (a project key). Without it they act on the agent's own project, as today.
- With `project`, the server reads the workspace's links from `links.json` on every call and allows only a key linked there now. Unlinking stops knowledge access at once, though folder access stays for existing chats.

### Pill and running chats

- A composer pill "Linked" on every chat, showing the link count; its popover lists the workspace's links and offers: Add project (known projects with their last-used folder, or a typed folder path), Remove (per link), "New linked chat", "Add linked projects to this chat", and "Remove from this chat" when this chat has linked folders.
- "New linked chat": `paseo.workspaces.ref(W).agents.create({ config: { provider, model, modeId from this chat }, env: { CONTEXTUALISE_LINK_WORKSPACE: W } })`.
- Remove: removes the link from the workspace; new chats no longer get it, and the linked project's knowledge is refused at once for every chat in the workspace (checked live). It asks for confirmation and names the chats that still have the folder.
- "Remove from this chat": if the resume trial passes, resumes the chat with the linked folders removed from its folder options (only folders Contextualise added; anything else stays). If not, the button is not shown and the popover says the chat keeps the folder until it ends.
- "Add linked projects to this chat": if Part 1 shows resume-with-overrides works from the plugin, resume this chat with the folders added (after it is idle; refused while it runs). Otherwise: create a new chat in W with `parent` set to this chat and a first message holding this chat's conversation excerpt (the existing renderer), and say so on the button.

### Conversation reading

- New tool `conversation_read` on the knowledge server: pages one conversation's full timeline (`canonical`), tool calls with their input and output, newest first, 30,000 characters per call, with a cursor; output through the existing secret redaction.
- Scope: the agent attachment text gains a line "Read the whole conversation with conversation_read, grant `<grant>`". The grant is HMAC-signed `{agentId}` with the same secret; the tool reads only the conversation its grant names.
- Not auto-approved: the permission handler keeps approving only the five read-only knowledge tools.

### Attach option rename

`shared/knowledge.ts`: title "Project", picker title "Attach project". Text that names the option follows: `pack.ts:12` CLOSING, `README.md:147,152`, `OVERVIEW.md:5`. Ids stay `knowledge`.

### UI fixes (Project screen and settings)

From the research audit, each seen in code:

- A "Linked projects" section on the workspace panel: the workspace's links, Add project, Remove, and which running chats still have each folder.
- Fix the settings path that does not exist ("Settings > Contextualise > Conversation summaries") at `knowledge-screen.tsx:192`, `generate.ts:392`, `README.md:117,217`.
- One way to pick a project (the title); remove the duplicate menu item (`knowledge-screen.tsx:325`).
- "Add past conversations" once (keep the empty-state button, `:163`; drop the menu duplicate `:327`).
- "Summarise past conversations" disabled while summaries are off (`:328`).
- Typing a search shows a "Results" state and clears the tab highlight; clearing the search restores the tab (`:376-387`).
- Re-index and Add shown as buttons in the header, not only in the menu (`:324-329`).
- The Memorise note shown once, on the screen (drop `settings-screen.tsx:265-276`).

Contracts touched: new RPCs `knowledge.links.list/link/unlink`, `knowledge.links.new-chat`, `knowledge.links.add-to-chat`, `knowledge.links.unlink-from-chat`; new optional MCP tool argument `project`; new tool `conversation_read`; token payload field `workspace` (optional, old tokens still verify); new file `links.json`. Auth: every new RPC is called from the plugin's own client; tool access is checked by token (`mcp.ts:249`), grant (new), and the live links file.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| Wrong provider-options shape fails chat creation | low | every new chat in a linked workspace fails | built per provider; tests against Paseo's schemas; Part 1 trial on scratch agents | Part 1; Paseo error on create |
| Paseo changes the option schema in an update | medium | chats in linked workspaces fail to start | the schema fixture records the version; a link to an unknown provider adds no options | chat creation error names the key |
| Shared local folder gets the wrong workspace's link | none by design | link leaks | several matches give no link and a note | test |
| Commits in the wrong repo | medium | lost or misplaced work | prompt says `git -C <path>`, commit each project separately | M sees it in git |
| Codex cannot commit in a linked repo | high | approval prompt | prompt says so; not worked around | Codex approval prompt |
| BE's skills, commands, plugins load in FE chats (Claude) | certain | behaviour change in FE chats | shown in the pill: "Claude loads the linked project's skills and commands" | M |
| Unlink does not revoke folder access in existing chats | certain | stale access | knowledge access checked live; UI says so | UI text |
| Resume path is not public API | medium | "Add to this chat" breaks on a Paseo update | used only if Part 1 passes; falls back to a new chat | error toast, fallback |
| `conversation_read` leaks secrets | low | secret in another agent's context | grant per conversation; redaction; not auto-approved | permission prompt |
| Plugin SDK 0.13 lacks something Part 3/4 needs | low | part blocked | stop and report before upgrading the SDK | typecheck |

## Acceptance criteria

- Given workspace W (worktree) with a link to folder B, when M starts a Claude chat in W from Paseo's "+", then the chat's `providerOptions.additionalDirectories` includes B and its prompt names B.
- Given the same for Codex, then `sandbox_workspace_write.writable_roots` includes B.
- Given a local workspace W that shares its folder with W2, and W has a link, when M starts a chat from "+", then no folder is added and the prompt says to use "New linked chat"; when M uses "New linked chat" in W, then B is added.
- Given W2 of the same project without links, when a chat starts there, then nothing is added.
- Given a provider other than Claude or Codex, then no provider option is added and the note says why.
- Given existing `additionalDirectories`, then the link merges without duplicates.
- Given B linked to W and then unlinked, when a chat in W calls `knowledge_search` with `project: B`, then it is refused, and a new chat in W gets no B.
- Given a running chat with B (resume trial passed), when M picks "Remove from this chat", then the chat's folder options no longer include B and folders M set themselves are kept.
- Given an agent attachment, when the receiving agent calls `conversation_read` with its grant, then it gets the full timeline with tool calls, redacted; with a grant for another agent or none, it is refused.
- Given the Attach menu, then the option reads "Project" and its picker "Attach project".
- Each test above fails on the current code.

## Rollout and rollback

Ships as 0.23.0 (minor: new features). No migration: `links.json` is new, token field optional. Rollback: install 0.22.2; links are ignored, chats already created keep their saved folders.

## Parts

### Part 1: trial on throwaway agents (no code shipped)

- [ ] In a scratch folder with two scratch git repos, create scratch Claude and Codex agents (never M's agents, never `claude -p`) with the folder options; each edits one file in the second repo. Done: written result per provider, and per Codex mode.
- [ ] Try resume-with-overrides from a plugin-like Node script using `@getpaseo/client`, both adding and removing a folder. Done: works or not, written down; decides Part 5's add and unlink paths.
- [ ] Check whether `env` from the create hook reaches the Claude process (for the CLAUDE.md flag). Done: yes or no.
- Stop and report to M if any result contradicts the design.

### Part 2: rename the Attach option

- [ ] `shared/knowledge.ts`, `pack.ts`, README, OVERVIEW. Done: test on the source title; grep finds no "Attach > Project knowledge".

### Part 3: link store and RPCs

- [ ] `server/knowledge/links.ts` with validation; RPCs list/link/unlink. Done: tests for each validation rule and atomic writes.

### Part 4: apply links in the create hook, and linked knowledge

- [ ] Workspace resolution (env marker, single folder match, shared folder). Per-provider options merge. Prompt section. Token `workspace`, tool `project` checked against live links. Done: acceptance criteria 1-7 as tests, red on old code.

### Part 5: composer pill and running chats

- [ ] `client/link-pills.tsx`; Add and Remove; "New linked chat"; "Add linked projects to this chat" (resume or continue, per Part 1); "Remove from this chat" (resume only, per Part 1). Done: server tests for the RPCs; manual check in the app on a scratch workspace.

### Part 6: conversation reading

- [ ] Grant minting in agent attachments; `conversation_read` with paging and redaction; permission handler unchanged. Done: criterion 8 as tests.

### Part 7: UI fixes and Linked projects section

- [ ] The eight fixes listed under Design; settings copy test passes. Done: typecheck, tests, and a look at the screen in the app.

### Part 8: release

- [ ] CHANGELOG 0.23.0, version, README sections; full suite and typecheck; commit, merge, tag, push, GitHub release, reinstall. Done: Paseo shows 0.23.0 running.

## Standardized review

(pending)

## Changes made

- Part 1: resume-with-overrides is not reachable from a plugin (`PaseoApi` has no resume; the CLI cannot pass provider options; a separate authenticated daemon connection would be an unsupported path). Decision per the plan's fallback: "Add linked projects to this chat" continues as a new chat; "Remove from this chat" is dropped and the pill says a running chat keeps its folders until it ends. Folder access is tested on a branch install with scratch repos and agents before the release.

- Parts 2-7: built as planned, with the plan review's fixes (background workspaces included when matching a folder; the env marker trusted only on a folder match; links re-checked when used; Paseo's data folder never linkable; `conversation_read` kept off the auto-approve list; grants signed apart from tokens and limited to the attach time). Contracts live in `shared/linked-projects.ts` (`shared/links.ts` already held link-shortening code). Not done, on purpose: removing the Memorise card from Settings (it has a Copy command the screen lacks) and clearing the tab highlight while searching (the tab narrows the search).
- Part 8: trial on a background scratch workspace with two scratch repos: a Claude agent (acceptEdits) and a Codex agent (auto) each wrote to the linked folder without approval and saw the Linked projects section. Released 0.23.0 (merge 412d8ee, tag v0.23.0) and reinstalled.

## Open questions

None. M's answers to the research questions are recorded under Decision.
