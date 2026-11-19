# 0001. Retrieve workspace chat context on demand

- Status: accepted direction; implementation contract checked with the plan
- Date: 2026-11-19
- Decided by: M chose on-demand access and delegated design; contract awaiting plan check
- Supersedes: none (revises earlier untracked workspace-summary plan, not an ADR)
- Related records: ../2026-11-19-0958_workspace-context-efficiency_plan.md
- Owner: Contextualise maintainers
- Stakeholders: users of workspace history and summaries
- Review when: missing-context correctness regresses or repeated streaming scans show unacceptable latency

## Context

Workspace startup currently embeds every eligible chat summary without an aggregate bound. Workspace history tools exist but use cache-limited newest text. [verified: server/workspace-chats.ts:155-158; server/attached-history.ts:46-66]

M requested lower token use, then explicitly authorised on-demand tools that can search and retrieve any amount of context from any other chat in the same workspace (chat, 2026-11-19).

## Assumptions and unknowns

Actual provider-token savings and the running host's limits are unverified. Tests establish bounded emitted text and source traversal only, not provider answer quality. Source unavailable through Paseo cannot be reconstructed.

## Decision drivers

Complete access to recorded eligible context and privacy outrank shorter individual answers. Avoid automatically sending unrelated context. Reuse existing tool names, permission checks and timeline source. Bound timeline work and replies without a total traversal cap. Existing chat-metadata enumeration remains population-dependent; no bounded whole-call inventory claim is made. Traverse chats by stable id, not activity, so activity changes cannot skip chats. A new search includes chats created behind the current traversal position.

## Options considered

| Aspect | On-demand streaming | Eager summaries | Persistent vector index |
| --- | --- | --- | --- |
| How | Fixed note, discover/search/load/read pages | All summaries at startup | New embedding index |
| Benefit | Bounded startup, exact-source access | Immediate overview | Semantic retrieval |
| Gives up | Additional calls/permission prompts | Growing prompt, oldest raw rows still capped | Exact recall and simplicity |
| Cost/risk | Cursor and scope tests | Low code effort, fails new token goal | New storage/dependencies, unproven need |
| Fails when | Agent omits retrieval or source unavailable | Workspace grows | Relevant item not retrieved |
| Outcome | Chosen by M's direction | Rejected as default with history tools on | Rejected without evidence |

## Decision

The plugin will provide bounded, repeatable discovery/search and exact paged reads over same-workspace recorded chat history. Startup supplies fixed retrieval guidance, not every summary. No aggregate chat/history cap is introduced; each call can return continuation. Existing privacy exclusions and cross-chat permission prompts remain. History-off users who explicitly enable summaries retain their eager fallback.

## Consequences

- Good: automatic prompt content no longer scales with stored summary bodies; old eligible history remains reachable.
- Bad: answering cross-chat questions requires tool calls; repeated scans may be slower than an index; model retrieval behaviour still needs evaluation.
- Undo: restore eager renderer and earlier tool implementation without deleting summaries. Cursor formats are versioned and errors instruct restart. Optional update-delivery metadata is separate from this contract.

## Transition

Add tools/compatible optional inputs before changing new-chat guidance. Existing saved prompts are not rewritten; old tool calls remain supported on reopen. No live installation in this task. Local tests, full review, then authorised feature-branch commit/push. Rollback needs a separate source revert, not data deletion.

## How we will know it is followed

Startup <=1,024 bytes with history on; oldest-row traversal and direct reads work; all replies <=16 KiB; forged/moved/private chat references disclose nothing. Full plan provides exact acceptance cases and rollback.
