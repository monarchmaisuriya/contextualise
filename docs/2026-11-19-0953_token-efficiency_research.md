# Reduce Contextualise tokens without losing project or conversation knowledge

- Date: 2026-11-19 09:53 IST
- Status: handed to plan (M chose on-demand access and authorised the complete build in chat, 2026-11-19)
- Mode: explore options
- Repos: contextualise. Folders: server/, shared/, client/ (settings and attachment consumers inspected by reference), docs/.
- Question / problem: Which changes reduce model-facing context and helper-model input while retaining Contextualise's current capabilities and correctness?
- Constraints: M requested research and a plan first, not implementation (chat, this date). Preserve redaction, permissions, scope checks, freshness, restart recovery, exact-history access, and explicit attachment behaviour. Earlier recorded direction requires every eligible workspace chat's complete stored summary at startup, without a chat-count limit (prior plan, lines 11-20).
- Answered when: token-producing paths are mapped; structural opportunities and tradeoffs are evidenced; options and a proposed implementation sequence are available for M to choose before a detailed plan.
- Decision it feeds: strict delivery compatibility versus optional progressive loading. For: M and the implementer. Out of scope: implementation, live settings changes, provider replacement, index rewrite, deployment, paid model runs, and inspection of private live chat contents.

## Options: send less redundant context while keeping knowledge available and correct

- **Bottom line:** Start with compatibility-preserving optimisation and measurement (option A). Treat progressive workspace context (option B) as a separate, explicit product decision. Confidence: high in the source-level opportunities; medium in prioritisation; unverified for real token or bill savings until representative provider traces are measured.
- **Where we are:** source scan and synthetic output-size probes complete; official guidance and an independent research paper read. Next: M chooses scope, then a full implementation plan with a fresh-reader check.
- **Need from M:** choose A or B, and confirm that the goal covers both foreground context and background summary consumption.

### The problem, framed

- **What:** reduce unnecessary tokens emitted by Contextualise, not simply the size of its local index.
- **Why:** M wants lower token consumption with the same functionality (current chat).
- **Who:** interactive Claude, Codex and OpenCode chats, and the Claude/Codex workers launched by the plugin. The source explicitly creates those workers through provider selection. [verified: primary, `server/workers.ts:126-159`]
- **When:** startup, tool use, every-turn update polling, explicit attachments, and enabled background generation. No deadline was supplied (current chat).
- **Where:** context construction and tool-result boundaries; background worker prompt construction.
- **Which:** contextualise 0.33.0, installed plugin SDK 0.13.0, MCP SDK 1.32.1, TypeScript 5.9.3, Vitest 3.2.7; Node v24.22.1 in this shell. [verified: primary, `package.json:4,25-38`; installed package version probe and `node --version`]
- **How:** establish a per-surface baseline, remove redundant delivery at its owner, then compare complete workloads and correctness, not isolated response sizes.
- **How much:** proposed A is roughly 3-5 engineer-days, B roughly 5-8 including A, excluding paid evaluation scheduling. These are planning estimates, not observed historical productivity. No monetary saving is forecast.

### What must be true

| Input | Classification | Evidence / check |
| --- | --- | --- |
| No implementation before approval | Hard constraint | M's current request: "give me a plan first" |
| Every eligible workspace chat contributes its whole stored summary | Existing recorded requirement | [verified: primary, `docs/2026-11-11-1215_new-chat-gets-workspace-chats_plan.md:11-20`; current renderer `server/workspace-chats.ts:155-158`] |
| Raw history remains recoverable under existing bounds | Hard constraint | Existing search/load/read tools and scope checks. [verified: primary, `server/chat-history.ts:313-394`; `server/attached-history.ts:140-175`] |
| Token estimates are not billed usage | Hard distinction | Existing estimate divides characters by four; provider docs offer model-specific counting. [verified: primary, `shared/tokens.ts:1-8`; source S3] |
| Main and helper model usage both count toward optimisation | Proposed scope | [unverified: M to confirm; foreground and background may have different priorities] |
| Current daemon and provider versions | Unknown | [unverified: inspect the daemon and installed provider versions before any provider-dependent implementation; installed development SDK is not proof of deployed versions] |
| Actual enabled settings and real cost distribution | Unknown | [unverified: obtain a redacted representative usage export or run an explicitly approved local evaluation; repository defaults do not prove M's settings] |

### What the code sends today

```text
Interactive chat creation
  -> project map (40-line default, capped body assembly)
  -> attached-project notes and provider directory access
  -> history + every-turn update rule
  -> all eligible workspace summaries, when enabled  <-- scales with chat count
  -> provider-owned request construction

Agent tool calls
  -> knowledge search/read/outline/history/impact + conversation_read
  -> own/workspace/attached history search/load/read
  -> attachment_updates                            <-- a single large item bypasses budget

Turn completion, optional generation
  -> task summary: selected transcript reread at refresh points
  -> workspace summary: previous summary + only new units
  -> serialized helper runs and separate daily caps
```

The composition is in `server/knowledge/plugin.ts:511-569`; task refresh in `server/knowledge/generate.ts:177-220`; incremental workspace summary in `server/chat-summaries.ts:361-425`. These are source-level flows, not observed provider request traces. [verified: primary]

| Surface | Current behaviour | Consequence for optimisation | Evidence and strength |
| --- | --- | --- | --- |
| Project map | 40-line default and 4 KiB assembly cap; static use guidance also appears in MCP server instructions | Already bounded; shorten duplication carefully, do not prioritise an index rewrite | [verified: primary, `shared/contracts.ts:440`; `server/knowledge/section.ts:78-138`; `server/knowledge/mcp.ts:27-30`], strong. Default constant is declared in shared/contracts.ts |
| Knowledge definitions | MCP configuration uses `alwaysLoad: true`; six definitions when conversation reader is installed | Investigate schema overhead, but preserve first-turn discovery until provider-specific trials justify change | [verified: primary, `server/knowledge/mcp.ts:35-38,138-269`], strong for configuration, not its deployed interpretation |
| Paseo tool registration | 4 own-history + 3 attached-history + 3 workspace-history + updates when history is on; project_attach independently | 12 contributed definitions with history on; descriptions can be tightened without merging permissions or tools | [verified: primary, `server/knowledge/plugin.ts:511-515`; `server/history-tools.ts:121-158`; `server/attached-history.ts:181-232`], strong |
| Knowledge reads | Ordinary Markdown chunks are at most 4,000 characters; task text and complete file outlines do not have equivalent response budgets | Target oversized task/outline cases, not a false claim that every document read is unbounded | [verified: primary, `server/knowledge/sources.ts:62-99`; `server/knowledge/service.ts:52-58,180-198`; `server/knowledge/mcp.ts:180-206`], strong |
| Workspace startup summaries | Every eligible chat's stored summary, each at most 2,000 rendered characters, no aggregate limit; feature defaults off | Potentially large only when enabled and populated; lazy loading changes an explicit earlier requirement | [verified: primary, `server/chat-summaries.ts:20,424`; `server/workspace-chats.ts:155-158`; `shared/contracts.ts:464`], strong |
| Attachment updates | Called every turn by instruction, returns 198 characters even with no attachments in probe; nominal 16 KiB response budget, but one oversized item sent whole | Shorter no-op answers are compatible; strict paging changes delivery but can retain all text | [verified: primary, `server/history-tools.ts:23`; `server/attachment-updates.ts:175-225`; probe below], strong |
| Explicit attachments | Default snapshots up to 40,000 characters; whole-project pack up to 60,000 characters, before surrounding grant text | These are deliberate user-selected content; do not silently shrink or replace with summaries | [verified: primary, `server/sources.ts:232,274`; `server/knowledge/pack.ts:6-7,27-80`; README settings], strong |
| Task generation | Fresh task summary uses newest selected transcript (40 KiB, per-message clipping), when user-message growth doubles or daily refresh permits | Repeated transcript input is an opportunity, but existing growth gate already prevents per-turn full summarisation | [verified: primary, `server/knowledge/generate.ts:171-203`; `server/knowledge/transcript.ts:4-5,40-66`], strong |
| Workspace generation | Already incremental, anchored, resumable, daily-capped and quiet-period scheduled | Keep these mechanisms; optimise prompt/retry evidence rather than claiming incremental summaries are new | [verified: primary, `server/chat-summaries.ts:219-239,361-425`; `server/workspace-chats.ts:50-88`], strong |
| Worker context | Own worker directory is detectable, but create-hook history injection and session-open tools have no own-worker exclusion | Restricting Contextualise's own unrelated contributions is a testable saving, without changing fetch connector permissions | [inferred: primary, `server/workers.ts:31-35,126-134`; `server/knowledge/plugin.ts:511-534`], moderate: needs captured helper launch test |
| Usage records | Counts maps, unique hashed callers and calls, but not emitted size or token usage | Cannot rank actual consumption from current usage records alone | [verified: primary, `server/knowledge/usage.ts:13-19,34-57`], strong |

### Measured probes, not a production benchmark

One local deterministic run invoked the existing TypeScript functions through TypeScript's in-memory transpiler. No provider calls, installs, implementation changes, or user chat reads occurred. Synthetic ASCII summaries rendered to 1,946 characters each. Values divided by four below are the plugin's rough display convention, NOT tokenizer counts: repeated letters are especially unsuitable for estimating real tokens. [verified: local probe; `shared/tokens.ts:1-8`]

| Probe | Emitted characters / bytes for ASCII | Characters divided by four | Meaning |
| --- | ---: | ---: | --- |
| Startup with 1 other chat | 2,425 | 606 | Includes wrappers |
| Startup with 10 other chats | 20,713 | 5,178 | Linear growth |
| Startup with 50 other chats | 102,033 | 25,508 | No aggregate bound |
| Startup with 100 other chats | 203,683 | 50,921 | Demonstrates scaling, not M's usage |
| History startup rule | 987 | 247 | Static guidance only |
| Update answer, zero attachments | 198 | 50 | Excludes tool-call and model costs |
| One 100,000-character update | 100,149 | 25,037 | Exceeds nominal 16 KiB by design |

The oversize behaviour is intentional and tested: `server/attachment-updates.test.ts:85-90`. It is not characterised here as a newly discovered bug. [verified: primary, strong]

### Options

| Aspect | A: preserve current delivery, optimise redundancy | B: A plus optional progressive context | C: settings-only reduction |
| --- | --- | --- | --- |
| How it works | Measure, shorten repeated guidance/no-op responses, isolate own workers, then evaluate incremental task input | Add a compact workspace directory, selective complete-summary retrieval, strict recoverable paging | Lower map/snapshot settings or turn off summary features |
| Codebase fit | Reuses existing renderers, worker predicate, summary anchors and tests | Reuses stored summaries and history but needs a summary-discovery/retrieval contract | Uses existing settings |
| What it gives up | Retains all eager summaries, so cannot bound their growth | Some details require retrieval rather than being present immediately; extra tool calls and approval design | Loses supplied context or automation; conflicts with same functionality |
| Effort / money / risk | Estimated 3-5 days; evaluation spend requires approval; low-to-medium semantic regression risk | Estimated 5-8 days including A; model evaluations; medium discovery/continuity and delivery-state risk | Small effort, but no evidence of required functional parity |
| Blast radius / undo | Model-facing text and helper prompt composition; avoid stored schema changes initially; rollback code without rewriting historical records | Startup contract, retrieval tools, paging state and compatibility with saved chats; keep legacy mode | Settings reversible, but saved chats retain earlier instructions |
| When it fails | If savings are dominated by intentional full context, A yields only modest reduction | If agents fail to retrieve important older chats, or fetching all pages erases the saving | When missing context causes rereads or incorrect work |
| Evidence / strength | Above verified emission paths, S1/S2; moderate forecast until model trials | Existing page renderer and exact history, S1/S2/S5; moderate feasibility, unverified parity | Settings exist, but functional loss follows disabling them; strong |
| Completeness against unchanged delivery | 9/10: representative model evidence still needed | 7/10 until M accepts changed delivery and parity trials pass | 3/10: defers the real problem |

RECOMMENDATION: A first because it respects M's recorded completeness requirement and establishes evidence before changing context delivery. B is a separately approved extension, not a hidden prerequisite. C is not recommended because disabling features is not optimisation with the same functionality.

### Proposed implementation sequence after M chooses

This is a research roadmap, not an approved implementation plan. A detailed full plan follows M's option choice.

1. **Baseline and parity harness.** Capture generated startup sections, actual serialised tool definitions, output bytes/characters and helper prompt inputs with synthetic/redacted fixtures. Add representative 0/1/10/50-chat workloads, long task/outline/update cases, repeated queries and non-English text. Measure whole-task consumption and retrieval success; distinguish exact provider usage from estimates. No API key or new outbound service in the product.
2. **Remove redundant delivery.** Keep all tool names and permission boundaries. Shorten descriptions and duplicate prose while preserving use triggers, reference warnings, unknown/incomplete states, identifiers and next-page instructions. Return a terse explicit no-change answer. Exclude this plugin's own workers from its unrelated history/attachment/startup additions, using `isWorkerCwd` at the contribution owner. Never strip another plugin's tools or configured vendor connector. Tests must prove interactive chats and vendor fetch lockdown are unchanged.
3. **Reduce background rereads where supported.** Benchmark current growth-gated task summarisation against previous-summary + new-units input. Reuse existing anchoring primitives, not a second cursor implementation. Preserve task-summary purpose (not the workspace summary's broader decisions/facts contract), provider choice, caps and manual refresh. This needs a separate stored-state compatibility and rollback design in the full plan. If fidelity cannot match, keep the current generator and report measured cost.
4. **Optional B only: progressive workspace context and bounded recoverable results.** Never silently omit a chat or cut a summary. Every eligible chat remains discoverable; complete summaries can be explicitly retrieved without granting raw cross-chat history access. Keep full eager mode for `historyTools: false` and existing behaviour unless M approves a replacement. Do not instruct the agent to drain every page each turn, which would remove the intended saving. Oversized update text requires lossless continuation with scope checks, versioning, concurrent-call semantics, restart recovery and delivered-only progress. The exact tool/state design requires M's approval in the full plan.
5. **Evaluation and rollout.** Run existing relevant tests, typechecks, new budget/parity tests, and approved provider smoke tests. Compare matched full workloads over multiple runs with token, latency, tool-call and outcome metrics. Ship only portions with measured benefit and no failed guardrail; update README/CHANGELOG with any changed delivery, and preserve rollback.

Expected files for A: `server/history-tools.ts`, `server/knowledge/mcp.ts`, `server/knowledge/plugin.ts`, `server/attachment-updates.ts`, `server/workers.test.ts`, `server/knowledge/plugin.test.ts`, related renderer tests, a focused evaluation fixture/test, README/CHANGELOG. Task-input changes additionally involve `server/knowledge/generate.ts`, its tests and task-record schema only if the later plan justifies persistence. B additionally involves `server/workspace-chats.ts`, its tests and an approved optional retrieval contract. These are candidate files, not final write scope.

### Guardrails and acceptance criteria for the later plan

- **Same knowledge:** pinned entries, all eligible eager summaries under A, exact paths/ids, stale-source warnings, source provenance, decisions and unresolved work must survive the change.
- **Same security boundaries:** redaction before output/splitting, reference-not-instructions warnings, grant verification, attachment ownership/expiry, history-off exclusions, detach checks and existing approvals remain. Test these, do not merely compare string snapshots.
- **Same continuity:** no skipped or prematurely acknowledged update; no repeated whole-history worker input when the source is unchanged; restart/fork/reload recovery stays explicit.
- **No arbitrary percentage promise:** establish baseline first. Proposed deterministic gate: changed boilerplate fixtures are smaller; unchanged-content fixtures lose no semantic fields. Proposed model gate: no observed reduction in correctness on an agreed fixture set and lower total measured tokens including added retrieval calls. Finite trials are evidence, not a proof of identical model behaviour.
- **Size budgets are not enough:** measure generated content, actual provider usage when exposed, cache reads/writes and output separately. Do not count cheaper cached tokens as tokens removed. [verified: primary, S3/S4; current size-only estimate `shared/tokens.ts`]
- **No paid runs or live writes in this research.** Existing unit tests and typechecks were not run; no claim that the suite is green.

### Dropped approaches

- **Embeddings/vector database or index rewrite:** no retrieval-quality evidence justifies new infrastructure; existing lexical search and chunking already support selective reading. [verified: primary, `server/knowledge/store.ts:45-59,71-83`; `server/knowledge/sources.ts:87-99`]
- **Simply reducing limits or summarising explicit attachments:** breaks the intent of sending selected exact context, and repeats a previously rejected partial-preview approach. [verified: primary, prior plan lines 11-20,48-50]
- **Cheaper model as the main answer:** may change cost, not necessarily tokens or fidelity; no matched evaluation supports it here.
- **Prompt caching as the token-reduction solution:** it reuses prefixes to reduce processing/cost; it does not remove those tokens from context. Product-specific request controls belong to the provider, not these text renderers. [verified: primary, S4; inferred ownership from `server/workers.ts:133` and plugin config injection]
- **Remove alwaysLoad immediately:** current tests intentionally assert it and the map relies on reliable first-turn use. The deployed provider versions and measured benefit are unverified; keep this out of the first implementation scope. [verified: primary, `server/knowledge/plugin.test.ts:171`; `server/knowledge/mcp.ts:35-38`]
- **Replace per-turn polling with a new message hook:** the installed SDK has turn notifications but no request-transforming per-message hook. Current public hooks documentation describes newer APIs, not an approved SDK migration. [verified: primary, installed SDK `dist/server/lifecycle.d.ts:44-98`; S6]
- **Merge task and workspace summary products:** their fidelity, scope and refresh contracts differ. Reuse parsing/anchor primitives only if proven useful. [verified: primary, `server/knowledge/generate.ts:88-93,171-203`; `server/chat-summaries.ts:335-344`]

### Confidence and gaps

| Claim | Confidence / strength | What would change the call |
| --- | --- | --- |
| Workspace eager output grows with chat count | High / strong source + deterministic probe | A deployed version with another limiter would change applicability |
| The largest saving for M is workspace loading | Unverified | Actual settings and usage could show summaries off or tiny workspaces |
| A retains current delivery requirements | High at design level / moderate until tests | Shortening changes tool-use behaviour, helper exclusion removes required connector context, or incremental task summaries lose facts |
| B can preserve access while reducing startup size | Medium / moderate | Missing summary-discovery tools or agents that eagerly reload everything |
| A or B reduces actual billed usage by a specific amount | Unverified | Only matched provider measurements can establish this |

Independent long-context research (S5) supports testing relevance and recall rather than equating context capacity with quality; its 2023 models are not a benchmark for M's 2026 providers. Anthropic engineering guidance (S1/S2) is vendor-authored and its reported success rates are not used as savings forecasts. No success/failure population for Contextualise is available, so no generalisation from external success stories is made.

### Sources

- **S1, primary engineering guidance:** Anthropic, Effective context engineering for AI agents, 2025-09-29, unversioned article. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents . Supports: lightweight references and just-in-time loading; warns aggressive compaction loses critical detail. Cross-check: existing search/read architecture and S5.
- **S2, primary engineering guidance:** Anthropic, Writing effective tools for agents, 2025-09-11, unversioned article. https://www.anthropic.com/engineering/writing-tools-for-agents . Supports: concise/detailed responses, pagination and evaluation of total tokens, calls and outcomes. Cross-check: existing history pagination and local size probes. No vendor benchmark percentage is adopted.
- **S3, primary official docs:** Claude token counting, live unversioned documentation accessed this date. https://platform.claude.com/docs/en/build-with-claude/token-counting . Supports model-specific counts and the distinction between estimates and actual usage. The installed model/provider runtime is not established; API integration is NOT proposed for the plugin.
- **S4, primary official docs:** Claude prompt caching, live unversioned documentation accessed this date. https://platform.claude.com/docs/en/build-with-claude/prompt-caching . Supports prefix reuse and separate cache-read/write/input usage. No cache price or specific model saving is assumed.
- **S5, independent primary research:** Liu et al., Lost in the Middle: How Language Models Use Long Contexts, arXiv:2307.03172v3, 2023-11-20. https://arxiv.org/abs/2307.03172 . Supports: tested models' retrieval depends on context position. Not evidence of a current Contextualise saving or all current models' accuracy.
- **S6, primary official docs:** Paseo plugin hooks, live unversioned docs accessed this date. https://paseo.sh/docs/plugins/hooks.md . Describes newer addHook APIs and old-name compatibility. Installed SDK 0.13.0 declarations are the version-specific anchor here; no newer API is silently substituted.
- **S7, primary official docs:** Paseo plugin reference, live unversioned docs accessed this date. https://paseo.sh/docs/plugins/reference.md . Documents host-supplied runtime modules and version requirements; reinforces why development SDK and running host versions must not be conflated.
- **Local primary sources:** paths and lines cited inline. Earlier M direction is cited as a recorded requirement in an existing plan, not revalidated live configuration or a claim that every historical plan status is current.

## Method

- **Known first:** repository identity, features and emission paths from README, package manifest, then implementation. Unknown: enabled settings, deployed versions, actual provider requests and cost. These unknowns prevented a savings forecast.
- **Minimum:** at least five credible sources, at least one primary. Seven external primary sources were read, including one independent research paper, plus local implementation/tests. Unlike source kinds: provider engineering experience, official contracts, independent academic research, and local deterministic probes.
- **Search scope:** server/shared emission paths, tests for preserved semantics, README and earlier workspace-summary plan. Not an exhaustive line-by-line review of UI, grammars, dependency code or every test. No security scan was requested or performed.
- **Search terms:** knowledge map, systemPrompt, alwaysLoad, historyTools, workspaceSummaries, ANSWER_MAX_BYTES, snippet, budget, oversized, workers, usage. Web queries for context engineering, tool search and Paseo plugin hooks returned no search results; official pages were fetched directly rather than inferring that no documentation exists.
- **Budget:** 20-minute search budget beginning at 09:50 IST; stopped gathering once the remaining uncertainty was product intent and live usage rather than lack of structural alternatives. No claimed measured elapsed duration beyond the recorded clock readings.
- **Trials:** Node v24.22.1, TypeScript 5.9.3, local source loaded using `ts.transpileModule` to CommonJS through an in-memory `.ts` require hook. One deterministic size probe, no warm-up or timing, no repetitions or variance claim. Dataset: synthetic ASCII repeated-letter summaries and an oversized single update, not real conversations. These measurements establish character growth and budget behaviour only.
- **Reproduction:** register a `.ts` require hook using `ts.transpileModule` with CommonJS, ES2022 and esModuleInterop; import `workspaceChatsSection`, `summaryText`, `withHistoryRule`, `attachmentUpdates`. Use summary `{goal:'g'.repeat(300),done:['d'.repeat(500)],decisions:['c'.repeat(400)],open:['o'.repeat(300)],facts:['f'.repeat(400)]}`. Create N chats with id `chat-i`, title `Task i`, updatedAt `2026-11-18T23:00:00Z`, status idle. For each, entry `{summary,messages:42,coveredTo:updatedAt,updatedAt,complete:true}`. Call `workspaceChatsSection(chats, entries, true, Date.parse('2026-11-19T00:00:00Z'))` for N=1,10,50,100 and measure `.length` and `Buffer.byteLength`. Call `withHistoryRule(undefined)`. For updates use an in-memory store implementing redeem/get/advance with no grants and subjects=[]; then one subject returning one `{text:'x'.repeat(100000)}`. Measure returned text size. No disk writes or provider calls are required.
- **Separate source-description probe:** AST-counted description literal source lengths across four files: 3,985 characters before evaluating template expressions and excluding schemas. Not a serialised schema/token benchmark, not used for a savings estimate. Attached-history definitions are instantiated twice, so source-literal totals are not a tool-payload total.

## Independent check

Independent: present as is. No blocking or must-verify findings. Criteria 1-10 passed; criterion 11 had one note, answered fix: exact update fixture supplied below. Applied, not re-checked (note only).

The scope recommendation above records the earlier completeness constraint, not the final choice. M subsequently approved option B: on-demand search and complete paged retrieval from any eligible same-workspace chat. The implementation plan is `2026-11-19-0958_workspace-context-efficiency_plan.md`.

Exact update probe fixture: `store = {redeem:async()=>({refused:[]}),get:async()=>({grants:[],redeemed:{},seen:{}}),advance:async()=>{}}`. Call `attachmentUpdates('synthetic',[],{store,verify:()=>null,subjects:async()=>[]})`; the oversized variant uses `subjects:async()=>[{key:'synthetic',read:async()=>({title:'synthetic',items:[{text:'x'.repeat(100000)}],seen:()=>null})}]`. These produce 198 and 100,149 ASCII bytes respectively in the pre-change code.
