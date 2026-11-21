# 0002. Observe owned context without a second transcript archive

- Status: accepted under M's approved implementation direction
- Date: 2026-11-21
- Decided by: M approved the checked plan and delegated implementation judgment, 2026-11-21
- Supersedes: none
- Related records: 0001-workspace-context-on-demand.md; ../2026-11-21_context-workspace-verification.md
- Owner: Contextualise maintainers
- Stakeholders: users of attachments, retrieval and Past work
- Review when: durable diagnostic retention is requested or optional task fields cannot preserve recorded lineage

## Context

Current usage records daily counters without queries or paths. Task schema is shared by client data and persisted task parsing; optional delegation fields are not present. Attachments return prepared text without provider-delivery confirmation. [verified: server/knowledge/usage.ts:13-25; shared/knowledge.ts:52-70; server/knowledge/store.ts:21-24; node_modules/@getpaseo/plugin/dist/attachments.d.ts:5-24]

## Assumptions and unknowns

Runtime UI/coexistence remains unverified. Exact model prompt inclusion cannot be established by producer observation. Child native session references may not be navigable Paseo agent ids; validate before linking. Detailed executable design is in the related plan, not an assumed public provider contract.

## Decision drivers

Privacy and honest provenance outrank durable charts. Preserve existing history authorization and old task readability. Instrument owned producers rather than reverse-engineer flattened logs. No new dependencies or network destinations.

## Options considered

| Aspect | Memory-only metadata (proposed) | Durable diagnostic archive | Keep counters only |
| --- | --- | --- | --- |
| How | Explicit recording, bounded metadata, optional lineage in existing task records | Persist source/call observations | Existing UsageLog |
| Drivers | No new transcript archive; owned provenance | Survives restarts, broader personal data | Lowest collection, misses requested visibility |
| Gives up | Historical diagnostics after restart | Small privacy/maintenance surface | Receipts and retrieval investigation |
| Cost/risk | Moderate boundary instrumentation | New migration/retention/access policy | Low cost, incomplete goal |
| Fails when | Mislabels preparation as delivery | Retains sensitive inputs or stale access | Cannot explain large/failed retrieval |
| Outcome | Recommended | Rejected for this release | Retain for baseline counts, not full solution |

## Decision

Propose one bounded explicit in-memory diagnostic session. Retained events have closed enum/numeric fields and opaque project handles, no raw query/output/paths, source-derived labels, error strings or grants. Only the bounded existing-project routing map holds project keys; it holds no project top/file paths. Source-derived omission details stay in the current preparation response. Observe prepared/configured/returned output only; do not claim provider acknowledgement. Event visibility expires at 30 minutes; a nearest-expiry timer cleans idle state, including after Stop, on the first runnable event-loop turn. Suspension or event-loop blocking can delay physical cleanup and is explicitly disclosed.

Persist optional parent/subtask facts with captured pre-read observation timestamps in existing task records. Atomic store merge preserves absent fields, terminal status over running and newer observations within the same status class; serialized writes append the merged record to JSONL. A partial snapshot never removes unobserved children. Deterministic maximum 100 children and truncation flag apply. Older task JSON stays valid. Final project-payload assembly owns grant/framing budgets and whole-item admission; boundary omissions may change to enforce the final envelope. M has requested the four features; these exact contracts await plan approval.

## Consequences

- Good: privacy scope remains narrow and measurements have an identifiable owner; delegation stays with the task it describes.
- Bad: diagnostics disappear on restart/expiry; scheduled physical cleanup can be delayed while the process is blocked/suspended; optional lineage can be dropped if an older writer rewrites the record; no exact model billing or prompt reconstruction. Size-bound enforcement can omit a near-limit document previously admitted before grant accounting.
- Can it be undone: yes, remove instrumentation/UI without deleting user data. Older versions ignore optional JSON fields, but do not promise preservation after an older writer changes the task. Reconsider if persistence is a confirmed user need.

## Transition

Add compatible optional fields and new RPCs; old records remain readable. Default recording off. Validate old/new task round trips and unchanged retrieval before release. Roll back source/package version without deleting indexes/logs. Unknown/live installations are read-only for automation.

## How we will know it is followed

Tests inspect diagnostic state for ordinary path/prose and secret/grant sentinels, prove default-off/bounds/idle expiry and exact final payload counts, load old task logs and exercise every task writer. A controlled stale summary finishing after live child completion must preserve completed lineage in both SQLite and JSONL recovery. Review checks no permission widening, fabricated lineage or delivery claims. Runtime verification is separately recorded.
