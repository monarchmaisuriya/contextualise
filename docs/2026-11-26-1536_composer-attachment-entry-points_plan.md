# Workspace attachment in the composer menu and chat attachment in the Attached pill

- Date: 2026-11-26 15:36 IST
- Status: implemented; automated checks passed. Release authorized by M on 2026-11-26; rendered layout remains unverified.
- Repo: contextualise, version 0.38.0, base c057b768df3715e11f971353d94c36cc38af390d.
- Subagents: one independent plan check; no delegated implementation.
- Related decision: [workspace grants](adr/0002-workspace-attachment-grants.md).

## Context and problem

M requested two additions after supplying screenshots of the composer menu and Attached pill: Attach Workspace in the composer attachment menu, and Attach Chat in the pill popover (chat, 2026-11-26). M confirmed continuing after the distinction was explained: a chat is a message snapshot, while a workspace is a persistent workspace link. Existing entry points remain.

The user should reach either attachment type without remembering which of the two attachment controls contains it. Reuse existing attachment meaning and server validation rather than implement a second attachment system.

## Goals / Non-goals

- Composer attachment menu has one new Workspace source beside existing Chat and Project.
- Attached pill offers a Chats tab; picking a chat adds the existing Chat attachment to the exact current agent's draft, without sending the message or linking the source workspace.
- Workspace menu selection only prepares a removable attachment. Persistent access is not changed until submission and, for an existing workspace, explicit approval of the attachment tool.
- Existing Projects, Workspaces, Project files, New Chat and Fork Chat retain their behaviour.
- Success metric: both requested entry points appear once and each produces the same attachment outcome as its existing counterpart; checked at final local verification (target 2026-11-26 if implementation is approved today).
- Guardrails: zero workspace-link writes during picker search/selection; zero attachments inserted into an agent other than the popover target in two-agent fixtures; zero forged, expired or wrong-kind grants accepted.
- Non-goals: token/context refactor, visual redesign, persistent chat links, own-history policy changes, changes to Paseo core, removal of old tools/sources, daemon restart, release/install/commit/push or private live-chat tests unless separately requested.

## What is true today

| Owner / direct caller | Current rule and evidence |
| --- | --- |
| index.client -> attachment registry | Registers Chat, Project, Terminal and optional Tag, no Workspace. [verified: index.client.tsx:125-142; shared/contracts.ts:319-326] |
| followLinkPills -> LinkedProjects | Registers an agent-specific pill whose popover receives workspaceId and agentId. It can start a chat or fork and tracks persistent workspace links. [verified: client/link-pills.tsx:22-36,63-77] |
| LinkedProjects -> links.list/add/remove | Renders Projects/Workspaces and conditional Project files. Workspace choice calls links.add immediately; panel consumers share this component. [verified: client/linked-projects.tsx:43-89,116-145; client/attach-tabs.ts:4-19] |
| Chat source -> agents.search -> searchAgents | Search returns full existing attachment rows, with configured snapshot size, titles, redaction and conversation grant. Search RPC knows no destination composer. [verified: shared/contracts.ts:304-325; server/sources.ts:211-257] |
| links.add -> WorkspaceLinks | Refuses self/background/incompatible workspace references; worktrees link exact folders; local workspaces bring their recorded repositories. Persistent store limits combined links to five; writes serialized and atomic. [verified: server/knowledge/plugin.ts:1139-1164; server/knowledge/links.ts:123-179] |
| New workspace hooks -> project grants | Recognises only plugin attachment rows with project suffix and first-line signed grant; associates new workspace then waits before first chat. Existing project_attach gets receiver workspace from tool context, not model arguments, and is not automatically approved. [verified: server/knowledge/plugin.ts:427-438,466-513] |
| TokenAuthority | Kind-separated signed grants, expiry and project use ids; no workspace grant yet. [verified: server/knowledge/auth.ts:26-48,68-91] |
| Existing capabilities | Installed SDK 0.13.0 lacks composer APIs. Installed Paseo CLI is 0.17.4; the tagged v0.17.4 SDK has client.composers({agentId}) and composer.addAttachment({sourceId,item}). [verified: package.json:27; paseo --version; official tagged sources below] |

Actors and state: trusted human picker in client -> authenticated plugin RPC -> daemon-owned workspace inventory and signed grants -> message submission -> validated link mutation in host-local knowledge/links.json. Snapshot chat text stays in the draft until send. No new service or credential source.

Function assumptions: LinkedProjects currently assumes its mutations are persistent links; new chat picking must be a separate branch, not passed into that mutation. Popover target agentId is the composer identity. Attachment search cannot assume a destination workspace because its input is only query. Workspace source validation must re-read source inventory on redemption, not trust the selected title or path.

## Options considered

| Aspect | Duplicate pickers / clipboard | Reuse existing rows and composer API (recommended) |
| --- | --- | --- |
| Mechanism | New snapshot rendering or copied text to paste | Same agents.search rows, exact agent composer, existing workspace link owner |
| Fit | Repeats redaction/size/grant code | Preserves source identifiers and existing contracts |
| Cost | Superficially smaller; extra manual step and drift risk | Moderate scoped implementation; workspace grant needs validation tests |
| Gives up | Not a real composer attachment; may lose metadata | Requires composer-capable Paseo 0.17.4 for new Chats action |
| Failure | Wrong composer, paste errors, stale duplicated rules | Missing composer/capability must fail clearly without changing draft |
| Evidence | Existing file tab documents clipboard limitation on old hosts, client/linked-projects.tsx:168-170 | Tagged 0.17.4 composer/contracts source; agents.search output |
| Completeness | 4/10 | 9/10 pending host/client render verification |

RECOMMENDATION: reuse existing rows and composer commands because one owner should create each snapshot and persistent link.

## Decision

- Add Workspace as a normal declarative attachment source. It returns a short reference and a workspace grant, not a full copy of all workspace chats. [proposed]
- A source-workspace link is a persistent capability: every submission, including a newly created workspace, uses workspace_attach with normal human approval and receiver identity from the calling chat. No new automatic creation-hook grant path. Existing project creation behaviour remains unchanged. [proposed; revised after source inspection showed folder-based creation correlation is ambiguous]
- Keep chat attachment message-scoped and workspace attachment persistent. [decided: M's screenshots/request and continuation after clarification, chat 2026-11-26]
- Do not upgrade all SDK imports or install new runtime dependencies. Use a minimal local structural type for documented client.composers; call it only after a capability check. Raise manifest minimum to >=0.17.4 and clearly document the requirement; missing client capability hides Chats rather than exposing a button that silently copies text. Existing panels do not receive Chats. [proposed]
- Keep existing signed project grants and project_attach unchanged. Workspace grants are a distinct kind and distinct first-line label/source suffix. [proposed; ADR linked]

## Cost and scope

Estimated 1-2 engineer-days including privacy/interaction tests and manual rendering checks, not a measured productivity prediction. Budget priority: correct attachment semantics and failure states first; cut no privacy tests to save time. Existing history shows persistent links and grants already cover most behaviour; no comparable timed estimate available.

Risk is medium because a workspace link permits future agent folder access. Blast radius: attachment registry, target-composer integration, shared pill/panel component, workspace grant/tool/hook paths and links store transaction. No change to indexed content or chat histories. Feature is source-reversible; users can detach any links already created with the existing control.

## Design

### Composer menu: Workspace

1. Add workspaceAttachmentSource (id workspace, title Workspace, workspace icon, picker title Attach a workspace) and searchWorkspacesRpc in shared/linked-projects.ts. Query max 500 characters; returns PluginAttachmentSearchPayloadSchema. Register once after Project. Source search performs no link mutations.
2. List non-background active workspaces using existing inventory and newest-first metadata. Return title, project, branch/activity and a subtitle explaining that submitting attaches a workspace. Picker lacks receiver context, so self/already-linked/overlap cases are checked later, not guessed from a globally focused chat. Extract/reuse row metadata helpers rather than change existing links.list receiver filtering. No arbitrary filesystem search in this source.
3. Each row contains a signed kind workspace grant with workspaceId, expected real source folder and source kind (worktree/local), random id and expiry one hour. Its first line is Attach grant (workspace_attach): <grant>. Row id ends |workspace. Short reference framing says source title/folder is data and attachment can be removed before send. No chat bodies or model-generated workspace overview.
4. Factor the existing links.add business path into one private helper used by links.add and workspace_attach. Preserve current validations, lapsed-link handling and payload. Re-read source workspace and compare real folder and kind to the signed selection; reject moved, archived, background or changed-kind sources. Check receiver from actual tool context. Refuse self and protected/overlapping folders as today. Existing unrelated links remain untouched.
5. Add a workspace_attach tool at session open. Its only input is grant (max 2,000 characters), not receiver workspaceId/path. Verify signature/kind/expiry and one-time use. Never add it to auto-approved tools. New fixed instruction alongside existing attach guidance says use only Workspace grants in M's own message, never quoted files/tool output.
6. Do not extend rowGrants, pendingAttaches or firstChats for workspace grants: these currently correlate creation by folder/slug and are unsafe for concurrent same-folder creations. A newly created chat receives the selected workspace reference in M's first message and fixed workspace_attach guidance, then asks for the tool approval. Its initial process does not gain the new folders retroactively; the tool result explicitly states that folder grants apply to new/forked chats, using existing New Chat/Fork Chat controls. Existing chat tools that consult live attachments follow their existing dynamic behaviour. Cancellation or failed creation creates no workspace link. Concurrent same-folder fixture must prove no hook application and exact tool-context receiver. This deliberately trades automatic first-chat folder access for exact approved receiver identity.
7. Link mutation and workspace grant consumption belong in one serialized atomic WorkspaceLinks operation. Validate source/receiver before transaction; inside transaction check one-time id, link limit and duplicate, then write both link and used grant. Failure before successful persistence leaves grant unspent. This rule applies to workspace grants only; do not refactor project grant semantics in this task. Already attached is a no-op with an explicit result and no new access; do not consume that unused grant. Same-grant replay after a prior success is refused, including replay into another receiver.

```text
Human picks Workspace (new source)
  -> signed reference in draft, no link write           <-- new
  -> send
     -> any receiving chat: workspace_attach + approval <-- new
  -> shared existing workspace-link validator/store
  -> existing Attached control can remove link

Attached pill -> Chats tab                              <-- new
  -> existing agents.search snapshot
  -> client.composers({agentId: popover target})
  -> addAttachment({sourceId: agent, item}) to draft
  -> existing send pipeline, no persistent link write
```

### Attached pill: Chats

- Extend AttachTab with chats; keep Projects/Workspaces and conditional Project files ordering, insert Chats after Workspaces. Chat mode is available only when LinkedProjects gets an explicit attachChat callback from the pill. Workspace knowledge panels retain existing tabs and never acquire a draft-targeting action.
- In followLinkPills capture exact agentId/workspaceId at popover construction. Supply a callback that resolves client.composers({agentId}) at click time, not focused composer. Require exactly one matching composer in agent context; absent/closed/unknown target shows actionable error, does not pick another chat. Add the agents.search row under sourceId agent; preserve complete item metadata/text/grants. Avoid duplicates by checking existing sourceId/item.id before adding, and show success/already attached feedback. Keep popover open for selecting another chat, not navigation to source chat.
- Chats tab has its own lazy query: searchAgentsRpc, keyed by host installation, receiver workspace/agent and query. Fetch only while Chats is mounted, so opening Projects does not read histories. Exclude receiver agent row from displayed results. Use existing search rules for pinned/archived/provider/title/size; no new formatter or grant scheme. Selecting the result attaches the snapshot already shown in its row; follow current snapshot freshness semantics, do not invent a live-feed promise.
- Render loading, searching, empty and error with retry, disabled selection during submit, long-name ellipsis and readable subtitle. Query failure never leaves previous query's rows selectable as if current. Switching workspace/agent drops target-specific pending selection.
- Use current theme tokens, ListRow, SearchField, ScrollView and Segmented. Make tabs wrap/scroll safely at compact width rather than squeeze five unreadable labels into one line. Preserve New Chat/Fork Chat footer. Accessible role/label for search, tab selection and attachment action; copy differentiates attach-to-message from workspace access.

### Compatibility, privacy and failure checklist

- Safe defaults: no new setting, no off/unlimited magic values. Query empty lists current selectable sources; invalid/over-limit input rejected by schema. grants expire at one hour, no 0/empty expiry. Source id/label is not authority.
- Contracts: additive source, RPC, tool and grant kind; old sources/tool calls unaffected. Add optional spentWorkspaceGrants records {id, expires} to links.json version 1, separate from capped project usedGrants. Retain every unexpired workspace spend; prune only expired records inside the atomic transaction, never evict by count. Validate record shapes. Test more than 500 intervening project spends, reload, then workspace replay before expiry. Existing old writers drop unknown fields, so rollback/mixed old-writer deployment requires disabling workspace-grant redemption until the maximum outstanding grant expiry has passed (one hour); never claim downgrade preserves the replay ledger. Persisted actual links remain readable by old code. Draft grants need current release/new chats for tool instructions. Minimum >=0.17.4 covers composer capability.
- Quality: 100 candidates use existing paged rendering, not a new whole-history aggregation. Search uses existing snapshot limits; no automatic attachment or send. Verify exactly one registered new source and one insertion per user selection.
- Reliability: no live deployment here; test store-write failure leaves no consumed grant or half-link. Never silently swallow invalid grant as success. Replay/duplicate/source lapse is explicit. Dependency timeout yields recoverable error, not permission bypass.
- Threat model: human draft -> untrusted model/tool argument -> daemon signature/kind/expiry check -> receiver from trusted context -> current source/real-folder/protected-folder check -> atomic link write. Risks: forged/replayed grant, copied grant from retrieved text, wrong composer, source path reused after archive, grant spending on failed link. Mitigations above each require tests. Reference warnings are not a substitute for daemon validation.
- UI/personal data: no new credentials, raw history store or telemetry. Chat snapshots reach model only on send as today; history-off policy is preserved, not expanded. Target WCAG 2.2 AA using existing components; keyboard, focus, compact width, empty/error/loading and both themes checked when a test client is available.
- Design references: orchestrator references/design.md, design/ADAPTATIONS.md, design/impeccable/WORKFLOW.md and reference/shape.md; craft-floor read immediately before UI implementation. No downloaded design tooling or side design documents.
- Observability: existing handler/tool errors identify attachment failure; no grants or chat text in logs. UI reports added/already selected/error. Roll back on any wrong-composer insertion or unintended workspace grant.
- Experiments: no production A/B test. No provider run or private conversation inspection required to prove draft insertion.
- Missing access: renderer/host UI verification requires a supported staging/local test client; do not install into everyday Paseo without separate permission. Exact scope of a future live install is not inherited from earlier tasks.
- Edge cases: new workspace, new chat draft, existing chat, shared source folder, source archive/move/kind change, no knowledge index, knowledge disabled, two composer targets, unknown composer, repeat pick, expired/wrong-kind/forged/replayed grant, full link limit, failed save, loading/offline query, Unicode/long names, mobile tabs.
- Growth: reuse current limits and helpers; no new indexing, permission mode or new raw-history cache. Extend only if observed picker latency requires it.

## Risks and mitigations

| Risk | Likelihood / impact | Mitigation / detection |
| --- | --- | --- |
| Draft selection grants access early | Medium / high | Search/selection tests assert no store write; apply only submitted grant/tool |
| Wrong composer gets chat | Medium / high | Exact agent selector at click; two-agent fixture; never focused fallback |
| Grant accepted after workspace identity changes | Low / high | Source folder+kind binding and live lookup; archive/reuse tests |
| Partial grant consumption | Medium / medium | One atomic store write; forced persistence failure test |
| Unsupported old client | Medium / failed UI | Manifest >=0.17.4; guarded capability; no dead Chats tab |
| Shared panel acquires chat action without composer | Medium / confusion | Explicit callback controls visibility; panel fallback tests |
| Extra tabs unusable on narrow view | Medium / medium | Responsive tab strip and compact/manual render checks |

## Acceptance criteria

- Given the composer attachment menu, when opened, then Workspace appears once beside existing sources.
- Given a workspace picker row, when selected then removed before send, then links are unchanged.
- Given a submitted valid workspace grant, when used in an existing workspace with approval, then exactly that source is persistently attached using existing validations and undo controls.
- Given a new workspace with the plugin's Workspace attachment, when its first chat starts, then it receives the reference and approval guidance, with no automatic link; approved workspace_attach uses the actual receiver and explains New Chat/Fork Chat for new folder access.
- Given a forged/expired/project-kind/replayed grant, when used by workspace_attach, then no protected link is created. Workspace grants are ignored by existing creation hooks.
- Given a full link store or failed save, when grant application fails, then grant is not consumed and existing records are intact.
- Given the Attached pill's Chats tab for agent A while B is focused, when a row is picked, then only A's draft gets the existing Chat item; no message is sent and no workspace link is created.
- Given the same chat already selected, when clicked again, then no duplicate attachment is added and feedback is explicit.
- Given a panel or unsupported/missing composer, then no incorrectly targeted chat action appears; existing attachment tabs remain usable.
- Given loading, no result, error, Unicode, long names and compact layout, then states remain readable/actionable and failure does not select stale rows.

## Rollout and rollback

Source-only feature branch after M approves and chooses worktree/current checkout. Do not write code on main. Plan remains here. No commit, push, release, install or daemon restart included. Add contracts/store tests first, then server wiring, then UI integration. Full suite/typechecks and any available local host render check before done. Abort on wrong target, early grant or ignored privacy validation. Rollback source and remove newly introduced pending draft attachments; already persisted links use existing detach, never delete whole data files. No grant secret rotation or raw-account cleanup.

## Parts

| File | Action | Why |
| --- | --- | --- |
| shared/linked-projects.ts | change | New Workspace source/search contract |
| server/knowledge/auth.ts | change | Kind-separated bounded workspace grant |
| server/knowledge/links.ts + links.test.ts | change | Atomic workspace application plus used grant |
| server/knowledge/plugin.ts + plugin.test.ts | change | Reuse link owner, source search and tool; test creation hooks ignore workspace grants |
| server/knowledge/section.ts + section.test.ts | change | Workspace grant guidance |
| index.client.tsx + client/registrations.test.ts | change | Register Workspace once in desired order |
| client/link-pills.tsx | change | Exact-agent composer callback |
| client/linked-projects.tsx, client/attach-tabs.ts + attach-tabs.test.ts | change | Pill-only Chats and responsive tab handling |
| client/chat-attachments.tsx + chat-attachments.test.tsx | new | Reused Chat source search and user-selection behaviour |
| client/composer-attachments.ts + composer-attachments.test.ts | new | Narrow documented composer capability and insertion/duplicate guards |
| shared/contracts.test.ts, server/knowledge/mcp.test.ts as relevant | change only if required | Grant/source registration boundary coverage |
| paseo-plugin.json | change | Supported minimum >=0.17.4 |
| README.md, OVERVIEW.md, CHANGELOG.md | change | Two entry points, persistent versus message scope, compatibility |

### Contracts and workspace application

- [ ] Add grant/schema and atomic consumption/application; done: forged/expired/wrong-kind/replay and write-failure cases fail red before implementation, then pass.
- [ ] Extract existing workspace-link business operation without changing its existing users; done: old links.add tests pass unchanged plus source identity tests.
- [ ] Add picker, workspace_attach and first-message guidance; done: picker/creation hooks write nothing, tool takes trusted receiver, concurrent same-folder and invalid-grant visibility tests pass. Ledger retains unexpired workspace spends beyond 500 project spends and across reload.

### Composer entry points

- [ ] Register Workspace source; done: real contribution registration test asserts source ids/order/cleanup.
- [ ] Add exact-target composer adapter with local structural types matched to tagged source; done: two-target, missing-target, duplicate and source metadata tests pass.
- [ ] Add lazy Chats panel only inside pill; done: interactive component tests cover selection, error/retry, loading and existing panel/tab fallback. UI layout checked on available wide and compact test host, or explicitly reported unverified.

### Verification and handoff

- [ ] Update README/overview/changelog in same change; done: scope and minimum-version claims match code.
- [ ] Run full npm test and npm run typecheck; done: exact observed PASS lines after final code edits.
- [ ] Read diff for scope/formatting/user-work preservation and offer fresh-reader code check; done: no unrelated files or managed installations changed.

## Independent check

Independent check: two blocking findings accepted and fixed in the plan, applied not re-checked (one-pass limit). Exact agent composer insertion feasible in tagged Paseo 0.17.4. Plan and ADR criteria otherwise passed. Finding 1: inherited folder/slug creation matching can misroute grants; fix: no automatic workspace-grant creation path, approval in actual receiving chat only. Finding 2: capped shared spent-id list permits live grant eviction; fix: expiry-retained workspace-specific ledger, plus downgrade one-hour guard. No contests or unresolved blocking findings. Product tradeoff (new/forked chat for newly granted folders) explicitly surfaced for M's approval.

## Changes made

- 2026-11-26: implemented Workspace source, kind-separated signed grant, approved receiver-context tool and atomic expiry-retained spending. Added pill-only Chats using exact-agent composer insertion and existing snapshots. Documented Paseo >=0.17.4; build SDK unchanged.
- Verification: 721 tests across 68 files passed, client/server typechecks passed and git diff --check passed. Rendering/contrast/focus not verified. No local installation changed.
- Test evidence limits: additional boundary cases were added after implementation and have not all received mutation probes. No forced filesystem persistence-failure test or concurrent same-folder creation fixture was added. These are remaining coverage gaps, not proven acceptance criteria.
- M explicitly requested commit, PR push, merge and release. Release metadata prepared as 0.39.0. This supersedes the original no-release scope; local installation remains excluded.

## Open questions

- M approved implementation and chose current checkout; branch feat/composer-attachment-entry-points. Existing untracked docs preserved. M subsequently authorized commit, push PR, merge and release.
- Implementer: exact tagged composer contracts verified online for 0.17.4; runtime panel rendering must be checked before calling UI verified. No claim that installed CLI alone proves every connected client version.

## Baseline evidence

- npm test -- --reporter=dot --silent=passed-only: PASS, exit 0, 709 tests in 66 files (15.73 seconds), before code changes.
- git fetch origin and git rev-list --left-right --count HEAD...origin/main: 0 0, no branch divergence. Existing untracked docs left untouched.
- Local client/parts/controls.tsx:87-116: Segmented already scrolls on compact when stretch=false. Use that existing mode for the extra tabs; do not refactor shared styling.
- Official API cross-check: https://raw.githubusercontent.com/getpaseo/paseo/v0.17.4/packages/plugin/src/client/composer.tsx and contracts.ts confirm exact-agent client.composers and addAttachment. Public https://paseo.sh/docs/plugins/reference.md describes the same API. Pinned development SDK remains 0.13.0, hence explicit narrow adapter and compatibility floor rather than a dependency upgrade.
