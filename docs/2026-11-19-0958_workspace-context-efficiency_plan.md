# Workspace context on demand and lower redundant model input

- Date: 2026-11-19 09:58 IST
- Status: implementation complete and verified; git delivery pending at this document's commit snapshot. Full, because model-facing tools and stored progress change. M authorised finishing build, review, fixes, commit and push in chat on this date.
- Repos: contextualise. Folders: server/, shared/, client/, docs/. Exact files are in Parts.
- Subagents: independent plan check and independent code review, not parallel implementation.
- Research: [token-efficiency research](2026-11-19-0953_token-efficiency_research.md).

## Context and problem

M wants lower token consumption without removing the ability to answer questions about earlier work. M explicitly revised the earlier all-summaries-at-startup requirement: give the agent a tool that can search and get any amount of context from any chat in the same workspace, even when that chat is absent from its current prompt. M delegated design judgement and then authorised completing the build, review, fixes, commit and push (chat, 2026-11-19).

The required function is access to relevant complete recorded history, not automatic delivery of every summary. Bounded responses with unlimited continuation preserve access while keeping each model input small. "Complete" means what Paseo exposes after its own storage limits, secret redaction, and existing privacy exclusions, not provider reasoning or deleted content.

## Goals / Non-goals

- Startup workspace guidance is bounded independently of the number of chats while history tools are enabled.
- Every eligible other chat, archived included, is discoverable and searchable. A chat's oldest recorded eligible item remains accessible through continuation, independent of memory-cache limits.
- Search and retrieval include exact recorded user/assistant text and tool input/output; summaries are optional navigation aids, never the authority for exact details.
- Preserve same-workspace scoping, permission prompts, `/history off`, worker exclusions, reference warnings and redaction.
- Reduce repeated instructions/no-op results and avoid adding unrelated Contextualise tools or instructions to its own background workers.
- Success metric: workspace startup note <=1,024 UTF-8 bytes with history on, with 0, 1 and 100 chats; all deterministic access/parity fixtures pass. Record actual bytes, not fictional tokenizer counts.
- Guardrail: 0 skipped eligible history rows across a complete paginated synthetic traversal; 0 cross-workspace or opted-out chat disclosures in tests.
- Check date: 2026-11-19 at final verification. Real provider-token savings remain unverified without approved provider evaluations; no paid runs or live installation are part of this task.
- Non-goals: index rewrite, embeddings, provider/model changes, hook/SDK migration, changing other plugins, removing tool names, shrinking explicit attachments, auto-approving cross-chat reads, modifying live plugin data, installing or publishing a release. Do not spend part-time effort on these.

## What is true today

| Component and caller | Existing behaviour / assumptions | Evidence |
| --- | --- | --- |
| agent.create -> workspaceChatsFor -> workspaceChatsSection | Eagerly lists every non-archived chat summary when enabled; growth is unbounded by aggregate size | [verified: server/knowledge/plugin.ts:520-526,848-859; server/workspace-chats.ts:155-158] |
| agent.session_open -> workspaceHistoryTools | Existing search/load/read names share a cache-limited engine with attached history; all workspace chats but only newest retained rows are searched | [verified: server/knowledge/plugin.ts:511-515,683-690; server/attached-history.ts:46-66,112-137] |
| chatHistoryTools -> scope callback | Caller workspace comes from Paseo, not model arguments; `/history off` rechecked every call; cross-chat tools not auto-approved | [verified: server/attached-history.ts:140-175; server/knowledge/plugin.ts:579-586] |
| historyRow -> redaction | Retains full eligible recorded message/tool text, skips reasoning and recovery-tool calls | [verified: server/chat-history.ts:112-141] |
| timelineOf -> Paseo timeline | Supports tail/before/after and epoch/seq cursors; no proof of deployed provider storage beyond what timeline returns | [verified: server/history-tools.ts:85-91; server/chat-history.ts:52-66]. Deployed version remains unverified; do not adopt a newer SDK API. |
| workspace summary writer | Already incremental, anchored and daily capped, off by default | [verified: server/chat-summaries.ts:361-425; shared/contracts.ts:464-467] |
| task summary writer | Growth-gated but rereads selected newest transcript; task purpose differs from workspace summary | [verified: server/knowledge/generate.ts:171-220; server/knowledge/transcript.ts:40-66] |
| own workers -> hooks | Worker cwd identifiable; session-open and history-rule contribution do not exclude it | [verified: server/workers.ts:31-35; server/knowledge/plugin.ts:511-534] |
| attachmentUpdates -> SeenStore | Delivered whole items advance source; oversized item deliberately bypasses 16 KiB, state schema currently has no partial-item position | [verified: server/attachment-updates.ts:51-54,175-225] |
| project map -> MCP instructions | Same use guidance repeated; map body already capped at 4 KiB; definitions always loaded | [verified: server/knowledge/section.ts:88-95,134-138; server/knowledge/mcp.ts:27-38] |

State surviving restart: stored agent system prompts, JSON summaries, off-chat list, attachment progress, task logs and SQLite index. New raw workspace retrieval will be stateless and use the existing timeline as source, not another persistent index. Auth remains at the tool boundary on every request. No provider key is introduced.

```text
User's question
  -> short workspace history guidance                    <-- changed
  -> discover chat by title or stored summary             <-- new
  -> workspace_history_search(query, optional chatId)
  -> bounded timeline scan + continuation, any age         <-- changed
  -> workspace_history_load / read exact items             <-- changed
  -> answer grounded in the retrieved text
```

## Options considered

| Aspect | Eager summaries, tighten prose | On-demand streaming history (chosen) | New vector index |
| --- | --- | --- | --- |
| Mechanism | Keep all summary bodies in prompt | Fixed guidance, chat discovery, paginated timeline scan/direct reads | Embed and retrieve messages |
| Fit | Existing renderer | Reuses current tools, timeline and row rendering | New storage and dependencies |
| Gives up | Cannot bound startup growth | Extra retrieval calls and permission prompts | Exact lexical semantics and simple operation |
| Cost / risk | Low effort; weak worst-case saving | Moderate effort; cursor and discovery correctness | High effort and maintenance, no demonstrated need |
| Failure | Many chats fill prompt | Model neglects retrieval or cursor becomes stale; explicit guidance/errors required | Recall misses and stale embeddings |
| Evidence | workspace-chats.ts:155-158 | history-tools.ts:85-91; chat-history.ts:52-66,115-141 | No evidence requiring it |
| Completeness | 6/10 for M's new outcome | 9/10 pending tests; recorded source only | 4/10 without retrieval evidence |

RECOMMENDATION: on-demand streaming history because it reduces automatic payload while preserving an explicit route to all recorded eligible context.

## Decision

- Replace eager workspace summaries with fixed tool guidance when history tools are enabled. Retain legacy summary delivery when history tools are off and summaries are explicitly enabled; do not create an unusable tool-only mode. [decided: M, chat 2026-11-19; fallback proposed under delegated judgement]
- Preserve existing workspace_history_search/load/read names, add optional search continuation/chatId, and add workspace_history_chats for title/summary discovery. Attached-history and own-history behaviour stay unchanged. [proposed under M's delegated judgement]
- Search every chat via bounded scanning, not "load all then trim". Per response and per invocation limits are work bounds, not corpus bounds. [decided: M's "any chat, any amount"; mechanism proposed]
- Preserve cross-chat ask-each-call permission behaviour. No automatic trust widening. [proposed under delegated judgement]
- Do not silently reduce explicit attachment size, remove alwaysLoad, or change provider/model. [proposed under delegated judgement]
- Background task-summary incremental reuse is benchmark-gated: reuse existing current workspace summary only as additional navigation is insufficient for task-summary parity. Implement an incremental task-input path only if its correctness and migration can be established inside a separately reviewable part; otherwise record it as deferred, not pretend it shipped. [proposed under delegated judgement]
- Record the durable retrieval contract in docs/adr/0001-workspace-context-on-demand.md, proposed until final plan check. No prior ADR exists in this checkout (glob this session). The old untracked plan is not rewritten or committed.

## Cost and scope

Planning estimate: 4-7 engineer-days for all production validation, not a claim this session must consume that duration. No historical estimate calibration was inspected; estimate is an assumption. Work is ordered so complete retrieval and parity land before optional generator work. Cut optional generator optimisation first, not privacy or complete traversal. No new dependency or network destination.

Blast radius: same-workspace tools, new-chat guidance, own helper contributions, update result construction, related tests and documentation. Other workspaces' attached-history implementation and explicit attachments retain contracts. Main risks: skipped rows, stale cursors, disclosure through forged identifiers, duplicate/omitted update chunks and less reliable model retrieval. Local source changes are reversible; no live state is touched in this task.

## Design

### Same-workspace history contract

Create server/workspace-history.ts as the owning module for same-workspace traversal. Reuse historyRow, searchHistory/loadHistory/readHistory formatting where compatible, and timelineOf. Existing shared attached-history engine remains for attached workspaces, whose 20-chat policy is unchanged. Only timeline work and emitted replies are bounded per call: existing metadata enumeration still reads the agent/background-workspace directory and scales with population. No claim of bounded total inventory memory is made; a persistent inventory index is outside this change.

Traversal uses stable lexicographic chat-id order, not mutable activity order. A continuation carries the last chat id and resumes at that id or the next greater eligible id. Activity cannot reorder traversal. Chats created behind the traversal position are included by a new search, not retroactively in an existing traversal; document this live-inventory limitation. Selected-chat deletion or privacy change refuses continuation; global traversal can move past a removed chat without claiming it was searched. Discovery also uses stable id ordering, so activity does not invalidate offsets; inventory additions/removals may shift discovery pages and are stated as live listings.

- `workspace_history_chats({query?, offset?, limit?})`: list eligible other chats in stable chat-id order; match every query word against full redacted title and existing rendered stored summary; include id/title plus optional full stored summary within a 16 KiB response, coverage and stale/incomplete warning. Do not invoke a model to answer discovery. Defaults: offset 0, limit 10, maximum 20. The next offset accounts only for emitted rows. Caller may repeat from any offset after compaction. Preserve exact ids, shorten display titles only.
- `workspace_history_search({query?, tools?, files?, failed?, limit?, load?, chatId?, cursor?})`: existing filters and max 50 hits retained; default 8 hits. Search chats in stable id order and rows newest first within each chat, explicitly state that ordering rather than claim a global timestamp merge. Up to four timeline pages of 200 entries per call; no total pages/chats cap. Cursor version, selected chat id, timeline before-position and bound query/filter fingerprint are validated. Cursor is continuation, never authority: recheck current caller scope, target and history-off on every call. A continuation for a changed filter or stale epoch is rejected with restart instructions. A complete scan says complete; partial scan always returns continuation even with zero matches. Entries examined after the last emitted result must not be lost when a result limit is reached mid-page. Cursor before-position points immediately before the last examined seq, not merely the underlying page boundary. Self-contained cursor survives plugin restart; no raw history is stored in it. Impose input cursor length and shape bounds.
- `workspace_history_load({ids})`: existing maximum three qualified `<chatId>:<seq>@<epoch>` ids. Fetch directly around each requested row, not through a newest-only cache. Validate current scope before fetching; stale epoch or missing row returns an explicit error. Whole row if it fits, otherwise existing read handle.
- `workspace_history_read({id,offset?,limit?})`: existing character-offset paging, at most 16 KiB total including provenance/reference/continuation. Fetch the requested row directly each call; no aggregate history cap. Same-source epoch is required. Redact the whole row before paging so secrets cannot straddle page boundaries.
- Exclude current caller, private `/history off`, internal/background/helper chats. Archived chats remain reachable. Scope is derived from Paseo tool context, never model-supplied workspace or cursor. A chat moved out of scope is refused even with a valid old cursor/id. No cursor grants access to attached workspaces.
- Whole eligible source rows are processed, including UTF-8 text. Deduplicate the retrieval tools' own timeline calls to avoid recursive history growth.
- Failure of one source must be reported without claiming an exhaustive no-match. Return resumable progress for completed work; do not acknowledge unread work. No retry loops to hide failures.

### Startup and summaries

When history tools are enabled, add a fixed note: other workspace chats are not automatically included; discover with workspace_history_chats, search before answering a cross-chat question, load exact text, continue only as needed. No list call or summary generation is required for startup. Shared-folder ambiguity is immaterial to this note because tools get the actual workspace at call time. Existing saved prompts are not edited on disk. New/forked chats replace the old section; already running chats keep old text until recreated/forked, and tools remain compatible on reopen.

Retain workspace summary generation as optional searchable navigation. Rename UI copy to "Keep searchable summaries of workspace chats" and explain that they are loaded on demand. Keep setting keys/defaults and stored JSON format. Legacy attachment_updates(workspaceChats:true) remains an explicit request for summary pages for old chats; do not make new chats automatically drain it. Fixed note must not claim tools are guaranteed available when host injection is off.

### Redundant model input

- At the create/session-open ownership boundary, skip only this plugin's contributions for `isWorkerCwd(root,cwd)`. Preserve incoming config/tools, vendor MCP routes and lock-down options. Do not classify all background agents as our workers.
- Tighten duplicated tool and history-use prose, keeping source/permission/freshness/recovery information. Do not replace readable text with cryptic encoding or delete per-result reference warnings.
- No-change attachment updates return a short explicit status; retain refusals/errors/paused information. Keep polling every turn for now; no supported per-message transform exists in pinned SDK.
- Measure serialised metadata and fixed note sizes with deterministic tests. Keep character estimates explicitly approximate.

### Strict update response budget

Current oversized-item bypass is intentional completeness behaviour. Replace it with lossless parts, not truncation. State needed: receiver partial position `{subject, hash, offset}` (optional, backward-compatible JSON field). Hash redacted item text; offset is a character boundary. A long item sends labelled parts within 16 KiB including headers and notes; do not advance SubjectRead.seen past that item until its final part is returned. Persist partial and whole-item progress together through SeenStore's queued update. Serialise attachmentUpdates calls per receiver around read/advance so concurrent calls cannot skip chunks. On changed source hash, restart that item explicitly; no silent continuation into changed content. Do not persist raw chat text. Legacy readers may repeat an incomplete item after rollback but must not lose it. Test multi-byte boundaries, restart, concurrency and source mutation. Ordinary whole-item answers retain current text where possible.

### Checklist and quality scenarios

1. Safe defaults: existing defaults unchanged; new optional offsets default 0, limits default 8/10, reject invalid/negative/oversized values; 0 is not unlimited. Cursor authority never comes from its content.
2. Contracts: additive tool inputs/new tool; existing names and old argument calls retained. Update state gains optional metadata only; old readers ignore it and may replay an unfinished item. UI text changes meaning, not stored setting name.
3. Quality: 100 stored summaries produce <=1,024-byte startup guidance; 20,001+ row traversal still finds oldest target; every result <=16 KiB; model-dependent answer accuracy is not established by these checks.
4. Reliability: no live service rollout here. Deterministic tests require all fixture pages reachable; state writes use existing atomic queued storage. Do not claim a production 100% availability target.
5. Threat model: model args -> validated tool -> current caller workspace/off checks -> Paseo timeline -> whole-row redaction -> reference-marked bounded result. Threats: forged chat/epoch/filter cursor, opted-out/moved chats, prompt injection and secret splitting. Mitigations each have boundary tests.
6. Views: plugin subprocess is the only changed deployable; Paseo and provider own timeline storage and model requests. Diagram above names changed flow; no new service/database.
7. Observability: result reports scanned/partial/complete and continuation; no query/content logs. Existing errors remain explicit. Byte regression tests detect growth. Actual token-cost telemetry deferred without collecting private content.
8. UI/personal data: copy-only settings change, existing accessible SettingsSwitch preserved. Design references: orchestrator references/design/ADAPTATIONS.md, intent/articulate.md, impeccable/reference/clarify.md and craft-floor.md. New continuation stores metadata only; no extra raw-chat retention.
9. Experiments: deterministic matched fixture measurements, not a production A/B test. Paid provider benchmark requires separate permission and is not a ship claim.
10. Missing: deployed host/provider versions and representative usage remain unknown. No newer API is used; source contract + local tests are the implementation base, provider smoke test is an explicit remaining limitation.
11. Edge cases: no workspace/no caller/off/empty/no match, deleted/moved/private chat, stale id, malformed cursor, filters changed, page reset, one huge row, unicode, partial failure, concurrent calls and restart.
12. Leverage: exercise same-workspace discovery, global search continuation, selected-chat search, direct old-row load, oversized-row read, and shared-folder chat creation, plus outsider variants.
13. Margins: 16 KiB result includes all wrappers; reserve continuation before body selection; work scan cap is four 200-item pages, not historical truncation. More calls can always continue.
14. Growth: do not add persistent indexing without evidence that bounded streaming latency is unacceptable; future trigger is measured repeated expensive searches.

## Risks and mitigations

| Risk | Likelihood / impact | Mitigation / detection |
| --- | --- | --- |
| Agent does not retrieve unseen chat | Medium / wrong answer | Startup + tool guidance require search for cross-chat references; deterministic tool capability tests, provider evaluation limitation explicit |
| Scan cursor skips rows after a full result page | Medium / lost relevant evidence | Per-examined-row continuation; traverse fixtures with >one response of hits |
| Cursor/id bypasses current workspace/privacy | Low with checks / sensitive disclosure | Fresh scope checks each call; outsider, moved and opted-out tests |
| History changed mid-traversal | Medium / inconsistent evidence | Epoch mismatch rejects; no silent restart under same cursor |
| Long update parts skip/repeat | Medium / stale understanding | Partial offset + hash persisted atomically; per-chat serialization; restart/concurrency tests |
| Incremental task input loses old facts | Medium / inaccurate summaries | Optional part benchmark gate, do not merge incompatible summary purposes |
| Host transport clips recorded source | Existing / unavailable context | Document source-of-truth limit; never promise recovery of text not exposed by Paseo |

## Acceptance criteria

- Given history tools on and any number of workspace chats, when a new chat starts, then its workspace note is <=1,024 bytes and contains no stored summary bodies.
- Given an eligible same-workspace chat absent from the prompt, when discovered/searched and loaded, then the caller can recover its exact redacted recorded facts.
- Given a matching row older than existing cache limits, when search continues to completion, then it is returned and direct load/read can recover it.
- Given result limits, unicode, old rows or many chats, when all continuations are followed, then no eligible source item is silently skipped and each response stays <=16 KiB.
- Given a forged/stale cursor or a chat outside caller's current workspace or opted out, when queried, then no protected content is fetched/returned and recovery is explicit.
- Given history tools off and summaries on, when creating a chat, then legacy eager summaries remain available without a false tool promise.
- Given this plugin's worker, when create/session-open hooks run, then no unrelated Contextualise note/tool is added and existing vendor tools/config survive.
- Given a partial long attachment update, when restarted/concurrently continued, then all text remains reachable and source progress advances only after complete delivery.
- Given no attachment changes, when polled, then the answer is shorter and still explicitly says no changes; errors/refusals remain visible.

## Rollout and rollback

Local code/tests only, no running-plugin installation. Add retrieval first, then switch startup guidance, then tighten redundant context and update paging. Gate each on targeted tests. Full test suite/typecheck and fresh code review must pass before commit/push. M explicitly authorised those git operations; no merge to main or release tag is included.

Abort on any new privacy leak, missing continuation, skipped row, failed state write or failed proving test. Last known safe state is the base commit recorded before build. Rollback source through a separately approved revert; do not discard user work. New cursor is stateless; optional update partial fields can be ignored by old code, which replays rather than loses partial items. No data deletion/cleanup is necessary. Keep this plan/research unless M asks to delete.

## Parts

| Path | Action | Why |
| --- | --- | --- |
| server/workspace-history.ts, server/workspace-history.test.ts | create | Complete bounded same-workspace retrieval |
| server/knowledge/plugin.ts, server/knowledge/plugin.test.ts | change | Wire retrieval, bounded startup, worker exclusion |
| server/history-tools.ts, server/chat-history.ts | change | Compact guidance, shared matching/provenance reuse and tool self-exclusion |
| server/workspace-chats.ts, server/workspace-chats.test.ts | change | Fixed note with legacy fallback |
| server/attachment-updates.ts, server/attachment-updates.test.ts | change | Partial delivery and compact no-op |
| server/knowledge/mcp.ts, related tests | change | Tighter metadata without losing safety cues |
| client/settings-screen.tsx, client/settings-copy.test.ts | change | Accurate searchable-summary copy |
| README.md, CHANGELOG.md | change | New retrieval/limits/compatibility |
| docs/adr/0001-workspace-context-on-demand.md | create | Durable retrieval decision |
| this plan and research | change | Decisions, measurements and verification evidence |

### Complete workspace retrieval

- [x] Add discovery and bounded streaming search, preserve load/read names and direct old-item retrieval. Done: oldest matching fixture reachable and exact redacted data loads.
- [x] Add scope/cursor/filters/Unicode tests and continuation regression. Done: initial tools test red, then green module checks; further tests characterised implementation and the output-budget omission test was red before correction. Partial failure remains explicit and subject to independent review.
- [x] Wire without changing attached-history policy or auto-approval. Done: plugin tests assert tool presence and cross-chat permission unchanged.

### Bounded startup and helper context

- [x] Switch history-on startup to fixed note, preserve history-off fallback and explicit legacy summary paging. Done: fixed 696-byte note; fork replacement and shared-folder cases pass.
- [x] Skip own-worker contributions, preserve incoming tools and vendor lock-down. Done: worker/interactive fixtures prove both sides.
- [x] Tighten guidance/metadata and update settings/docs in same part. Done: semantic cues retained and byte measurements shrink.

### Lossless bounded updates

- [x] Add optional partial state, whole-row redaction, strict result budget and receiver serialization. Done: oversized update reconstructs exactly, restart/concurrent/source-change tests pass.
- [x] Compact no-change replies, preserve refusal/failure/paused behaviour. Done: reference header omitted only for no-content status; existing boundary cases pass.

### Background input evaluation

- [x] Compare existing task growth gate and incremental workspace-summary mechanism; optional rewrite deferred for lack of a fidelity benchmark. Recorded below; no generator optimisation claimed.

### Verification and review

- [x] Run targeted tests, full suite and both typechecks. Done: exact PASS evidence recorded after code edits; final integration assertion rerun before commit.
- [x] Independent code review, fix valid findings with regression tests. Done: three independently refuted findings stood and were fixed, two notes fixed, no unresolved blocking finding; fixes applied not re-checked by a fresh reviewer under the one-pass rule. All regression tests pass.
- [ ] Stage only scoped files, commit and push feature branch after read-only remote recheck. Done: recorded commit id and remote branch; no unrelated docs staged.

## Independent check

Pending before implementation.

Independent check completed: three blocking draft findings accepted and fixed at the design owner: narrow boundedness promise to timeline/results with metadata population cost explicit; stable chat-id traversal instead of activity ordering; final legacy summary/update response shares one bound by serving explicit legacy summary pages alone (updates are not advanced on that call and the response instructs a separate ordinary updates call). Summary pages admit only whole blocks that fit; bound titles and render wrappers, and reject a single impossible block rather than advancing. Fixes applied, not re-checked (one-pass limit). Pinned SDK timeline options subsequently read at node_modules/@getpaseo/client/dist/daemon-client.d.ts:364-371.

## Changes made

- 2026-11-19: direct timeline workspace tools, discovery, stable traversal, bounded startup with history-off fallback, worker contribution exclusion, shorter guidance, lossless update paging and copy/docs implemented. Added module to this plan's file list: server/workspace-history.ts and its test (new files, included in review even while untracked).
- Baseline: npm test -- --reporter=dot: 642 tests, 59 files, exit 0. After implementation: npm test -- --reporter=dot --silent=passed-only: 654 tests, 60 files, exit 0; npm run typecheck: exit 0. Base commit: 9ab5dbc169558dca55fa571381fd9067e2ae6291. No installation or live provider run.
- Background input evaluation: deferred the optional incremental task-summary input rewrite. Existing task summaries are already growth/daily-gated; reusing workspace summary output changes purpose/fidelity, and no approved provider benchmark proves parity. No generator or stored task-state migration shipped. This is a disclosed scope reduction, not a claimed optimisation.
- Plan clarification: metadata enumeration remains population-dependent; stable chat-id traversal replaces activity ordering. Legacy summary requests return separately from updates, which remain unadvanced on that call. Recovery tests include 20,002 rows, noncontiguous projected ids, Unicode, activity-order changes, off chats, stale epochs, 50 matches exceeding one response, partial update restart/concurrency/source mutation.
- Deterministic emitted-byte measurement: workspace startup note 696 UTF-8 bytes, independent of chat count; history instruction block 987 -> 779 bytes (208 bytes removed). Measured by loading the current TypeScript functions through an in-memory transpiler and comparing old HISTORY_RULE from git show 9ab5dbc:server/history-tools.ts. These are emitted-byte reductions, not tokenizer counts or measured provider savings. Optional summary generation still consumes model input when enabled.
- 2026-11-19 11:55 verification: full suite 654 passed, 60 files (18.08 seconds); both typechecks exit 0. git diff --check clean. Existing test fixture logs include an embedded-repository warning; no failing test remained. Interface verification was source/copy tests only; no rendered settings inspection or live provider smoke test was performed.
- Verification limits: initial tool-registration, plugin wiring/worker/startup, oversized-update and response-budget continuation regressions were observed red before their functional changes. Other new edge tests characterised implemented behaviour and were not individually observed red; no mutation-coverage claim is made.
- Independent focused code review: three blocking findings, independently confirmed: legacy summary calls dropped new grants; later source failures discarded completed search hits; oversized headings stalled delivery. All answered fix at the owning boundary, with red-before-green tests. Fixed two notes: discovery matches full title, and outdated contract comments corrected. No permission widening found. Fixes applied, not re-checked by a fresh reader (one-pass limit); reran full suite 659 pass/60 files and both typechecks exit 0 at 12:01. Remaining limitations: no live host/provider test or rendered settings inspection; optional task-input rewrite deferred.
- Final post-integration verification at 12:02: npm test -- --reporter=dot --silent=passed-only: 659 passed, 60 files, exit 0; npm run typecheck: exit 0; git diff --check clean. Real signed-grant integration assertion confirms legacy summary delivery remembers supplied grants without advancing attachment sources. Feature branch optimise-workspace-context; original 16 untracked docs excluded from staging. Exact commit/push result is reported in the final handoff because this document is part of that commit.

## Open questions

- No product decisions waiting on M; judgement delegated. Live provider validation and actual token savings remain unverified and will not be presented as completed.

## Release and live verification extension

- M requested merge, release, reinstall and live testing, then explicitly said "do it for me" after the everyday-installation and production-write exception was explained (chat, 2026-11-19). This authorises this scoped install/test exception only, not unrelated settings or existing-chat writes.
- Release 0.34.0: package.json and lockfile root identity updated without dependency changes; changelog dated from clock; README install ref and OVERVIEW updated. GitHub release, not npm publication or registry submission. Prior release is v0.33.0; prior running installed revision is 9ab5dbc169558dca55fa571381fd9067e2ae6291 (paseo plugin ls).
- Sequence: verify release metadata -> commit on feature branch -> switch main and merge feature -> push main -> annotated v0.34.0 tag and GitHub release -> install exact tag -> require running/no error -> synthetic same-workspace retrieval and outsider refusal checks. Preserve all existing chats/data. Disposable test chats use synthetic facts only; no private history is needed.
- Rollback: reinstall exact prior revision if new plugin cannot run. Never rewrite/delete release history automatically; any discovered product defect receives a new patch release. Stop on unexpected installation failure.
- Verification before publication: npm test -- --reporter=dot --silent=passed-only: 659 passed/60 files; npm run typecheck exit 0 (2026-11-19 12:09). CLI Paseo 0.16.1 and gh 2.104.0; installed CLI help and official publishing/SDK docs checked. Git fetch: origin/main is ancestor, one feature commit ahead, no divergence. Existing untracked docs are untouched.
