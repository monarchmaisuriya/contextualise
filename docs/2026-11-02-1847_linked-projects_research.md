# Linked projects, full conversation access, and the "Project" screen

- Date: 2026-11-02 18:47
- Status: handed to plan
- Mode: explore options
- Repos: contextualise   Folders: `server/`, `server/knowledge/`, `client/`, `shared/`
- Question / problem: how can an agent in one project (a frontend) read and edit a second project (a backend) and work in both at once, the way Conductor links workspaces, within what a Paseo plugin is allowed to do?

## Options: give agents a second project they can edit, set up once per workspace, since Paseo cannot add one to an agent that is already running

- **Bottom line:** recommend **Option A, linked projects**. M links the backend to one frontend *workspace*. Every new chat or tab in that workspace then starts with the backend as a second folder it can read and edit, plus a note naming it and its knowledge. Other workspaces of the same project are not affected (M, 2026-11-02: "only for that workspace (all new chats/tabs) not every new workspace"). An agent already running gets it through a "Continue with linked projects" button, which starts a new agent carrying the conversation, because Paseo has no way to add a folder to a running agent.
- **Where we are:** framing done; 3 research tracks (Conductor and agent CLIs on the web, Paseo's plugin API from its own source, a Contextualise UI audit); about 30 sources read. Next step is the plan.
- **Need from M:** pick an option, and answer the questions at the end.

### The problem, framed

- **What:** "Attach BE in FE" should let the FE agent change BE files and work across both, and "Project knowledge" should be called "Project".
- **Why:** M works on features that span a frontend and a backend; today an agent in one repo can only read the other as pasted text.
- **Who:** M, and every chat M starts in a workspace that has links.
- **Whom:** M.
- **When:** no deadline given.
- **Where:** the agent-create hook (`server/knowledge/plugin.ts:199`), the Attach picker (`plugin.ts:405`), the conversation attachment (`server/sources.ts`, `server/snapshot.ts`), the Project screen (`client/knowledge-screen.tsx`).
- **Which:** Claude Code's `additionalDirectories` and Codex's `writable_roots`, passed through Paseo's `providerOptions`.
- **How:** decide the link once, apply it when each agent is created, tell the agent about it, give it tools for the other project.
- **How much:** medium to large; touches agent creation, so a bug could affect every new agent. Mitigated by the existing rule that the hook never stops an agent being created.

Refocused: the Attach picker cannot grant access (below), so access must be granted where Paseo allows it, at agent creation, and the picker becomes a way to *read* a project, not to link it.

### What must be true

Hard constraints:

- A plugin can set a new agent's extra folders. Claude: `providerOptions.additionalDirectories` [verified: Paseo source `server/agent/providers/claude/options.js:45`]. Codex: `providerOptions.sandbox_workspace_write.writable_roots` [verified: `server/agent/providers/codex/options.js:40`]. Both are saved with the agent and restored when it resumes [verified by the API track: `agent/agent-storage.js:14`].
- A plugin cannot change an agent's main folder: "agent.create hooks cannot change the workspace directory" [verified: `server/plugins/lifecycle/index.js:125-126`].
- A plugin cannot change a running agent's folders or prompt. `session_open` may change only env, tools, and MCP servers [verified: `lifecycle/index.js:119`], and the SDK exposes no other update [verified by the API track: `client/dist/index.d.ts:265-309`].
- The Attach picker does not know which agent it serves: its search gets only `{query}`, and nothing fires when an item is picked or sent [verified by the API track: app bundle `searchPluginAttachments`; `lifecycle/index.js:18` lists only three hooks].
- The agent-create hook sees `config` and `env`, not the prompt, its attachments, or the workspace id [verified: `lifecycle/index.js:20`; `agent-manager.js:756-762` passes only `config` and `env`, and `workspaceId` is used only after the hook, at `:770`; `AgentSessionConfig` has no workspace field, `protocol/dist/agent-types.d.ts:451-472`]. It knows the folder (`config.cwd`).
- A plugin can list workspaces with their folders (`paseo.workspaces.list`, `workspaceDirectory`) [verified: `client/dist/index.d.ts:136-146`; `protocol/dist/messages.d.ts:9074`]. So the hook finds the workspace whose folder is `config.cwd`.
- That match is exact for worktree workspaces, which each have their own folder, and ambiguous for local workspaces that share one folder. On M's machine: 65 workspaces, 50 worktree and 15 local; 12 local workspaces share 3 folders (`~/Develop` 4, `~/Debug` 5, `~/Experiment` 3) [verified: `paseo workspace ls --json`]. `PASEO_WORKSPACE_ID` is set for terminals and scripts, not agents [verified: app bundle, terminal spawn and script runner only].
- A composer pill and a slash command do know the agent and workspace [verified by the API track: plugin skill, "Composer pills" and "Slash commands"]; `addComposerPill` and `addSlashCommand` exist in the SDK Contextualise pins, 0.13 [verified: `node_modules/@getpaseo/plugin/dist/client/contracts.d.ts:160-162`].
- A plugin can create agents (`paseo.agents.create` with `config`, `cwd`, `prompt`, `parent`) and workspaces, including a git worktree of another repo [verified by the API track: `client/dist/index.d.ts:146,169-190,319`].
- A plugin can read another agent's full timeline, tool calls included (`timeline.refetch`, projection `canonical`) [verified by the API track: `protocol/dist/messages.d.ts:12545`].

- Paseo checks `providerOptions` against a strict per-provider schema after the hook, while creating the session, outside the plugin's error handling; an unknown key fails agent creation [verified by review: `agent/provider-options.js`, `agent-manager.js:757-781`]. Paseo also ships other providers (opencode, pi, omp) [verified by review: app bundle file list]. So the link is applied only to Claude and Codex, merged with any existing options; other providers get a prompt note instead.
- Paseo's resume request accepts config overrides, including `providerOptions` [verified: `protocol/dist/messages.js:1515-1520`; `client/dist/daemon-client.d.ts:931`]. So a running chat could be resumed with the linked folder added, keeping its real session. It is not on the plugin API (`PaseoApi`), so the plugin would call the daemon client or CLI itself [verified by review: `client/dist/index.d.ts:265-309`].
- Codex applies `writable_roots` only in `workspace-write` mode, and an already-resolved sandbox policy wins over them [verified by review: `codex-app-server-agent.js:1615-1631, 3192-3205`].

Conventions:

- Knowledge enriches an agent and must never stop one being created (`plugin.ts:197`).
- Contracts that agents or stored data depend on keep their names: RPCs `knowledge.*`, tool names `knowledge_*`, path `/mcp/knowledge`, settings keys `knowledge*`, the data folder, ids `"knowledge"` [verified by the UI audit].

Open checks:

- Resume with overrides adds a folder to a running Claude chat and keeps its history. Check: a scratch Claude agent, `resumeAgent(handle, {providerOptions: {additionalDirectories: [B]}})`, then ask it to edit a file in B.
- Codex honours `writable_roots` in each mode Paseo offers. Check: one scratch Codex agent per mode writes a file in B.

- Whether Codex can commit in a linked repo. Codex keeps `.git` read-only inside writable roots [verified, tier 1: [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)], so commits there should prompt or fail [inferred]. Check: a scratch Codex agent with a writable root runs `git -C <root> commit`.
- Whether an edit outside an agent's folders reaches Paseo as a permission request (needed only for Option C). Check: a scratch Claude and a scratch Codex agent each write one file outside their folders.
- Whether CLAUDE.md in the linked project loads. It loads only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` [verified, tier 1: [Claude Code permissions](https://code.claude.com/docs/en/permissions)]; whether Paseo passes `env` to the Claude process from the create hook [unverified: check with a scratch agent].

### How others do it

- Conductor: in a workspace, `/add-dir` picks other Conductor workspaces, or since v0.44.0 any folder; agents "can access files and code from the linked workspaces" [verified, tier 1: [Conductor docs](https://www.conductor.build/docs/guides/repositories/linking-multiple-directories), [0.44.0](https://www.conductor.build/changelog/0.44.0-new-sidebar-rebuilt-composer-codex-checkpoints)]. Each workspace is a git worktree [verified, tier 1: [Git worktrees](https://conductor.build/docs/concepts/git-worktrees)], so a linked workspace is the other repo's own worktree [inferred]. The mechanism underneath is not documented [unverified].
- Claude Code: `--add-dir`, `/add-dir`, `additionalDirectories`; added folders get the same read and edit rules as the main one [verified, tier 1: [permissions](https://code.claude.com/docs/en/permissions)]. Running git after `cd` into another folder prompts, because that folder's hooks could run [verified, tier 1: same page].
- Codex: `--add-dir` and `writable_roots` grant write access [verified, tier 1: [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)].
- Cursor 3.2: a named, reusable multi-folder workspace for an agent session [verified, tier 1: [changelog](https://cursor.com/changelog/04-24-26)]; users report agents writing only to the first folder [unverified, tier 3: [forum](https://forum.cursor.com/t/git-graph-agent-multi-root-workspace-uses-first-folder-only/163262)].
- Known failure: commits made from the session's folder while the edits were in another repo [unverified, tier 3: [issue 58531 mirror](https://claudeissues.com/issue/58531-commit-commands-plugin-uses-session-working-directory-instead-of-the-git-repo-wh)]. Defence: tell the agent to use `git -C <repo>` for each repo [inferred].

### Options

| Aspect | A: Linked projects (recommended) | B: A, with each link in its own worktree | C: A, plus live grant to running agents | D: Attach as text only (today, renamed) |
| --- | --- | --- | --- | --- |
| How it works | M links BE to one FE workspace (a composer pill, which knows the workspace, or the Project screen). The create hook finds the workspace by folder and adds BE to every new agent's folders there, a prompt note naming BE and saying "use `git -C`", and BE's knowledge tools. A running agent gets a "Continue with linked projects" action: a new agent in the same workspace, both folders, handed the conversation. | Same, but linking creates a Paseo worktree of BE and grants that folder, like Conductor. | Same as A, and Contextualise auto-approves a running agent's edit requests under BE. | Picker attaches BE's docs as text; no edits in BE. |
| Codebase fit | Extends the existing create hook (`plugin.ts:199`) and token scope; links stored like project prefs (`prefs.ts`). | Adds workspace creation and cleanup of worktrees. | Extends the existing permission handler (`plugin.ts:244-249`). | Already built. |
| Cost / blast radius | Medium. Every new chat in a linked workspace changes. A failure while *preparing* the link is one line in the prompt; but a wrongly shaped folder option fails agent creation (Paseo checks it after the hook), so options are built per provider and only for Claude and Codex. | Larger: branches and worktrees multiply; M must merge BE's branch separately. | Medium, plus approving file writes automatically, which is a permission decision. | None. |
| Fails when | A local workspace shares its folder with others: the hook cannot tell which one a chat started from Paseo's own "+" is in. Chats started from Contextualise's "New linked chat" pill carry the workspace id in their environment, so they are exact. Two agents edit BE's main checkout at once. Codex cannot commit in BE without approval. A running agent must be continued, not upgraded. | A worktree is left behind; BE work sits on a branch M forgets. | Rests on unverified behaviour (whether outside edits reach Paseo as requests); Codex `.git` stays blocked. | Does not meet the goal. |
| Evidence | Constraints above, all verified. | Conductor docs. | Two open checks unverified. | UI audit. |
| Completeness | 8/10 | 9/10 for parallel safety, 6/10 for simplicity | 7/10, flagged: rests on an unverified check | 3/10, flagged |

RECOMMENDATION: A, because it uses the only verified way Paseo lets a plugin give an agent a second editable folder, and it matches Conductor's model of a link M sets once. B can be a per-link choice later; C waits for its check.

### Flow of the recommended option

```
M links BE to FE workspace W (composer pill knows W)          <-- new: link list per workspace
          |
new chat in W -> create hook -> find W by folder (config.cwd)  <-- new; shared local folder: no link, says why
                                 -> folders: FE + BE           <-- new: additionalDirectories / writable_roots
                                 -> prompt: "BE is linked at <path>; use git -C"   <-- new
                                 -> knowledge tools for FE and BE                  <-- changed: token covers both
running agent in FE -> pill "Continue with linked projects"
                    -> new agent, same workspace, FE + BE, conversation handed over  <-- new
```

### Revised recommendation after review

Option A, applied in three places:

1. **New chat from Paseo's "+":** the create hook matches `config.cwd` (real paths) to the workspace list; exact for worktree workspaces.
2. **New chat from Contextualise's pill ("New linked chat"):** the plugin creates the chat in workspace W with the folder options and an env marker naming W; exact for every workspace, including local ones that share a folder.
3. **A chat already running:** "Add linked projects to this chat" resumes it with the folder added (if the open check passes), else continues it as a new chat with the conversation handed over.

Access for agents created before an unlink stays (folders are saved with the agent); the UI says so, and BE's knowledge tools check the current links on every call.

### Full access to an attached conversation

Today the attachment is the last 6 turns, user and assistant text only, at most 40,000 characters; tool calls and reasoning are dropped [verified: `server/snapshot.ts:35-47`, `shared/contracts.ts:361-362`]. The text is frozen when attached [inferred: the picker returns text at search time].

Proposal: keep the excerpt, and add a tool to the existing knowledge server, `conversation_read`, which pages the full timeline (`canonical`, tool calls included) on demand. Scope (after review): the attachment carries a signed grant for that one conversation, and the tool reads only conversations whose grant it is given; output goes through the existing secret redaction; the tool is not auto-approved like the knowledge tools. Without this, any agent could read any other agent's file contents and command output [verified by review: today's token scope is one project, `server/knowledge/auth.ts:11-15`]. Optional, off by default: `conversation_send(agentId, text)` to message the other agent (an action on another agent, so it needs M's say).

### The rename and the UI

- Rename what users and agents read from "Project knowledge" to "Project": about 40 strings (screen, sidebar, panel, Command Center, Attach source, settings, prompt heading, tool descriptions, README) [verified by the UI audit]. Keep the contract names listed above, and keep the README anchor `#project-knowledge` or move `DOCS_URL` with it (`plugin.ts:37`).
- UI problems seen in code, to fix in the same plan:
  - a settings path that does not exist, "Settings > Contextualise > Conversation summaries" (`knowledge-screen.tsx:192`, `generate.ts:392`, README :117, :217);
  - two ways to pick a project (`knowledge-screen.tsx:343`, `:325`), "Add past conversations" in two places (`:163`, `:327`);
  - "Summarise" enabled while summaries are off (`:328`);
  - typing a search hides the selected tab but the tab still looks selected (`:387`);
  - main actions only in the ⋯ menu (`:324-329`);
  - the Memorise note shown twice (`:423-428`, `settings-screen.tsx:265-276`);
  - very long components (`KnowledgeView` about 190 lines, settings about 300).
- New: a "Linked projects" section on the Project screen (add, remove, see which agents have them).

### Sources

- [Conductor: Linking multiple directories](https://www.conductor.build/docs/guides/repositories/linking-multiple-directories) (tier 1)
- [Conductor: Using multiple repos](https://www.conductor.build/docs/tips/using-multiple-repos) (tier 1)
- [Conductor: Git worktrees](https://conductor.build/docs/concepts/git-worktrees) (tier 1)
- [Conductor changelog 0.44.0](https://www.conductor.build/changelog/0.44.0-new-sidebar-rebuilt-composer-codex-checkpoints) (tier 1)
- [Claude Code: permissions, working directories](https://code.claude.com/docs/en/permissions) (tier 1)
- [Claude Agent SDK, TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) (tier 1)
- [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) (tier 1)
- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) (tier 1)
- [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security) (tier 1)
- [Cursor 3.2 changelog](https://cursor.com/changelog/04-24-26) (tier 1)
- [Cursor forum: first folder only](https://forum.cursor.com/t/git-graph-agent-multi-root-workspace-uses-first-folder-only/163262) (tier 3)
- [Claude Code issue 58531, mirror](https://claudeissues.com/issue/58531-commit-commands-plugin-uses-session-working-directory-instead-of-the-git-repo-wh) (tier 3)
- Paseo 0.14.0 daemon source, extracted read-only from `/Applications/Paseo.app/Contents/Resources/app.asar` (primary)
- Contextualise source, this repo (primary)

## Open questions

1. Decided by M: a link is per workspace. Open: for a local workspace that shares its folder with other workspaces, apply the link to none (recommended, fails closed and says why), or to all workspaces on that folder?
2. Link BE's main checkout, or a folder M picks (could be a worktree)? Recommendation: a folder M picks, defaulting to BE's last-seen checkout.
3. Is `conversation_send` (one agent messaging another) wanted, or reading only? Recommendation: reading only for now.
4. For a running chat, may Contextualise use Paseo's resume request, which is not part of the plugin API? Recommendation: yes, once the open check passes; it keeps the chat's real history.
5. Is a "New linked chat" pill acceptable for local workspaces that share a folder (the only exact way there)? Recommendation: yes.

## Standardized review

Independent review, 2026-11-02, of the per-workspace revision. Partial: no separate refuter pass.

- Bottom line: present after fixing 2 blocking; 3 must-verify, 2 notes. All fixed in this file or carried as open checks.
- Blocking 1: "never a failed agent" was false for folder options; fixed (constraint and Cost row).
- Blocking 2: `conversation_read` had no scope; fixed (signed per-conversation grant, redaction, no auto-approve).
- Must-verify 3: resume with overrides may add a folder to a running chat; added as constraint, open check, question 4.
- Must-verify 4: exact per-workspace links via plugin-created chats with an env marker; added (revised recommendation, question 5).
- Must-verify 5: Codex `writable_roots` only in workspace-write; added as constraint and open check.
- Note 6: a link also loads BE's skills and commands in Claude, and unlinking does not revoke existing agents; added to the revised recommendation.
- Note 7: per-project wording; fixed.
- Coverage: question, method, sources, evidence, proportionality, reproducibility pass; the others passed after the fixes above. The rename and UI audit items were not reviewed.
