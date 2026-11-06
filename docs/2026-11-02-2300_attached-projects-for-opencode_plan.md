# Attached projects: let OpenCode chats edit attached folders

- Date: 2026-11-02 23:00
- Status: done on branch feature/opencode-attached-folders (4ffcaa8), installed for M's test; not released
- Repos: contextualise   Files: `server/knowledge/links.ts`, `server/knowledge/links.test.ts`, `server/knowledge/plugin.test.ts`, `client/linked-projects.tsx`, `README.md`, `CHANGELOG.md`
- Subagents: one reviewer
- Follows: 0.24.0 (attached projects)

## Context and problem

M asked whether attached projects work with OpenCode. Today an OpenCode chat in a workspace with attached projects can search them, but cannot edit them: its prompt says the projects are "listed for reference; you may not be able to edit them".

## Goals / Non-goals

Goals: a new OpenCode chat in the workspace can read and edit each attached folder without asking, like Claude and Codex chats. The prompt and the popover say OpenCode is covered.

Non-goals: other providers (Copilot, Cursor, Pi, and so on); changing running chats (Paseo sets rules only when a chat starts or resumes).

## What is true today

- Folder options are given only to `claude` (`additionalDirectories`) and `codex` (`sandbox_workspace_write.writable_roots`); any other provider gets none, because Paseo checks options strictly and an unknown key fails the chat [verified: `server/knowledge/links.ts:124-135`]. The prompt then tells an OpenCode chat it "may not be able to edit" the attached projects [verified: `links.ts:175`].
- Search across attached projects works for every provider [verified: `plugin.ts`, `prepareKnowledge` adds the knowledge server without a provider check].
- Paseo accepts OpenCode options `{ permission: action | { …, edit, external_directory: action | { pattern: action } } }`, strictly [verified: installed Paseo 0.14.0 `agent/providers/opencode/options.js:9-38`].
- For OpenCode 2.x (M has 2.1.3) Paseo uses its v2 client [verified: `opencode/runtime-client.js:60-64`]. It turns the options into OpenCode's own rules `{action, resource, effect}` (renaming `bash` to `shell`) and sends them once, when the chat is created; a resumed chat keeps the rules it was created with [verified: `opencode/v2/configuration.js:13-35`, `v2/agent.js:63, 72`].
- OpenCode checks `external_directory` against `<folder holding the file>/*`; `*` matches across "/"; the last matching rule wins, agent rules first, then session rules; no match means ask [verified by review: strings in `~/.opencode/bin/opencode` v2.1.3]. Edits are also checked against `edit`; plan mode denies edits [verified by review: same binary].
- OpenCode 2.1.3's default agent appears to allow everything, `.env` reads aside, so an OpenCode chat may already be able to edit attached folders without asking [inferred by review from the default `Agent.Info`; not confirmed that Paseo's "build" agent uses it]. If so, the real defect is our prompt telling the agent it may not be able to.
- Plugin tools such as `project_attach` reach every provider through Paseo's own `paseo` tool server [verified: `agent/runtime-mcp-config.js:23-40`]; whether OpenCode lists it is not checked.

```
New OpenCode chat in a workspace with attached folder F
  agent.create hook --> linkedProviderOptions("opencode", …)          <-- changed: was null
      { permission: { external_directory: { …existing, "F/*": "allow" } } }
  Paseo v2 client --> session.create({ permissions: [ …, {external_directory, F/*, allow} ] })
  OpenCode edits F/src/x.ts --> external_directory "F/src/*" --> last match: allow --> edit rule --> allow
  prompt: "you can read and edit F"                                   <-- changed wording
```

## Options considered

| Aspect | A: allow rule per folder, plus prompt wording (recommended) | B: prompt wording only | C: leave OpenCode out |
| --- | --- | --- | --- |
| How | `F/*: allow` merged into the chat's rules; prompt says it can edit | Rely on OpenCode's default allow | Today |
| Works when M's OpenCode config asks for outside folders | Yes | No | No |
| Fails when | Plan mode or `edit` set to ask or deny (said in the prompt) | Any stricter config | Always |
| Completeness | 9/10 | 6/10 | 3/10 |

RECOMMENDATION: A, because the rule makes access hold whatever OpenCode's defaults or M's config become, and touches only the attached folders.

## Decision

A, after a live check (Part 0) shows what an OpenCode chat does today. Merge rules, never replace or widen M's explicit choices:

- `permission` missing: `{ permission: { external_directory: { "F/*": "allow" } } }`.
- `permission` an object: keep every key. `external_directory` as a record: remove each folder key, then add it at the end, so it is the last match. As "ask" or "allow": becomes `{ "*": <that>, "F/*": "allow" }`. As "deny": left alone.
- `permission` a string: left alone.
- The chat counts as granted (prompt: read and edit) only when the folders end up allowed and edits are not blocked: not plan mode, `edit` not "ask"/"deny", and no string or "deny" left alone above. Otherwise the prompt says edits there may need approval or are blocked.
- Attaching or removing a folder reaches new OpenCode chats only (Paseo sends rules once); a running or resumed chat keeps what it started with, as for Claude and Codex.

## Design

- `linkedProviderOptions` gains `opencode`; returns options plus whether access is granted (mode from `config.modeId`).
- `linksSection` uses that; wording "Claude or Codex" becomes "Claude, Codex, or OpenCode" in the popover, README, and the other-provider prompt line.
- Folder patterns use the real path already stored; a folder name containing `*` or `?` would act as a wildcard (noted, not handled: rare).
- No stored data or contract change.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| OpenCode ignores the rule | low | prompts as today | Part 0 and Part 2 live checks | scratch agent is asked |
| Merge leaves a later `*: deny` winning | low | folder denied while prompt says granted | folder keys re-added last; unit test | test |
| Prompt claims edit access in plan mode | medium | agent tries and fails | granted depends on mode and `edit` | test |
| Strict schema rejects merged options | low | chat fails to start | test parses with Paseo's schema copy | test |

## Acceptance criteria

- Given an OpenCode chat in a workspace with attached folder F, then its options carry `external_directory` with `F/*` → allow as the last entry, other rules kept, passing Paseo's schema; its prompt says it can read and edit F.
- Given `external_directory: "deny"`, `permission: "ask"`, plan mode, or `edit: "deny"`, then nothing is widened and the prompt says so.
- Given a scratch OpenCode agent with the branch installed, when it edits `F/src/x.txt`, then the edit lands with no prompt; and it can see `project_attach`.
- Unit tests fail on 0.24.0.

## Rollout and rollback

Branch install for M's test, release on M's word (0.25.0). Rollback: reinstall v0.24.0.

## Parts

### Part 0: live check today (scratch only, needs M's OK)
- [ ] `paseo run --provider opencode` in a scratch folder asks it to edit a file in a second scratch folder. Done: we know whether 2.1.3 asks today. This adds a scratch project to Paseo's sidebar; it is archived and the folders deleted afterwards.

### Part 1: options and wording
- [ ] As in Decision and Design. Done: unit tests red on 0.24.0, green after; schema test passes.

### Part 2: live check with the branch (scratch only)
- [ ] Scratch workspace with a scratch folder attached; a scratch OpenCode agent edits a nested file and lists its Paseo tools. Done: edit lands with no prompt. Then archive and delete the scratch items. M's own agents are never prompted.

### Part 3: ship
- [ ] Full suite, typecheck, commit and push the branch, reinstall. Release only when M says.

## Standardized review

Independent review, 2026-11-02: 1 blocking, 3 must-verify, notes; all taken.

- Blocking: evidence came from Paseo's OpenCode 1.x client; 2.x uses `v2/*`, converts rules itself, and sends them only at creation. Rewritten above (checked: `runtime-client.js:60-64`, `v2/configuration.js:13-35`).
- Must-verify: 2.1.3 may already allow outside folders by default. Added Part 0 live check; the prompt wording is part of the fix either way.
- Must-verify: merging into a record kept an existing later `*: deny`. Folder keys are now removed and re-added last.
- Must-verify: an explicit `external_directory: "deny"` was overridden. Now left alone.
- Notes taken: `*` crosses "/", last match wins; edit is gated separately and plan mode denies it, so "granted" depends on mode and `edit`; OpenCode resolves paths without following symlinks (stored paths are already real; noted).

## Changes made

- Part 0 (OpenCode default model failed every turn with HTTP 400; rerun with opencode/beam-free on M's OK): with no rule, a scratch OpenCode 2.1.3 chat edited a file in an outside folder with its Write tool and no permission prompt [verified: agent 14ac2f9c log, providerOptions none]. So with M's current OpenCode config outside folders are already allowed; the fix M notices is the prompt, and the rule protects against a stricter config.
- Part 1: `linkedProviderOptions` for OpenCode with merge rules as in Decision; prompt by mode and edit rule; wording. 453 tests and both typechecks pass; the new tests fail on v0.24.0.
- Part 2: with the branch installed and a scratch folder attached, a scratch OpenCode chat got `external_directory: {"<api>/*": "allow"}` and "You can read and edit them" [verified: stored agent config], OpenCode accepted the session, and the chat edited `api/src/note.txt` with no prompt [verified: agent 6c9377bb log]. `project_attach` listing was not checked.
- Cleanup: both scratch workspaces archived (with their 4 agents), the scratch links entry removed, the folders deleted. Two scratch Paseo projects remain for M to delete.

## Open questions

None.
