# 0002. Apply composer workspace attachments through distinct signed grants

- Status: accepted
- Date: 2026-11-26
- Decided by: M, approval to continue implementation after the revised plan, 2026-11-26
- Supersedes: none
- Related records: ../2026-11-26-1536_composer-attachment-entry-points_plan.md
- Owner: Contextualise maintainers
- Stakeholders: users attaching workspaces and chats
- Review when: host API permits receiver-aware custom menu actions without a submitted grant, or submission/permission semantics change

## Context

The composer attachment search accepts query only, while links.add requires an existing receiver workspace. Project menu attachments already carry signed grants to bridge selection and submission; new workspace hooks recognise only this plugin's submitted rows. [verified: shared/contracts.ts:304; shared/linked-projects.ts:48; server/knowledge/plugin.ts:427-438]

M requested Attach Workspace in the composer menu. Workspace attachment retains persistent linking; Chat attachment remains a message snapshot (chat, 2026-11-26).

## Assumptions and unknowns

No inference from globally focused composer to destination is safe. Connected client version/rendering still needs verification; CLI 0.17.4 and tagged composer contract are verified, not all clients.

## Decision drivers

No persistent access on picker browsing or cancellation. Exact source and trusted receiver identity. Existing protected-folder and workspace-link policy. Compatible project/chat semantics. One owner for durable grant consumption and link addition.

## Options considered

| Aspect | Distinct signed workspace grant | Immediate mutation during search | Plain copied workspace reference |
| --- | --- | --- | --- |
| Mechanism | Selection creates reference; send authorises validated application | Guess destination and write while selecting | Put id/path into text |
| Gives up | Adds grant/tool and explicit approval | Safe cancellation and drafts before workspace exists | Verifiable human intent and reliable persistent linking |
| Cost | Schema/expiry/replay/identity tests | Small apparent change, unsafe semantics | Model must improvise authority |
| Failure | Source moved/expired; reject explicitly | Wrong receiver or cancelled selection grants access | Copied reference treated as permission |
| Result | Recommended | Rejected | Rejected |

## Decision

Create a separate signed workspace grant, binding source id, expected real folder/kind, one-hour expiry and random use id. Every application, including a new workspace's first chat, uses an approved workspace_attach call; receiver comes only from Paseo tool context. Do not extend folder/slug-based pending creation matching. Reuse the existing workspace-link validator and atomically persist link plus workspace-specific spent {id,expires} record. Retain all unexpired records without count eviction; leave capped project records unchanged. Do not broaden project grants or auto-approval lists.

## Consequences

- Good: no new access before send, no guessed receiver, same controls regardless of entry point.
- Bad: every application requires an agent tool call and approval; a selected row can expire and require repicking. The first process already started before approval needs New Chat/Fork Chat to obtain new folder grants. This avoids granting access to the wrong same-folder receiver.
- Undo: existing links remain readable and detachable; rollback code without deleting records. Old versions do not recognise new workspace grants; users must repick after upgrade.

## Transition

Add the grant and validated application first, then register source and guidance. Keep project/Chat ids unchanged. No live install or release in this task. Rollback is source reversal and explicit detach for applied links, not file deletion or secret rotation. Old links.json writers drop the optional workspace-spend ledger, so mixed old-writer deployment/downgrade must disable workspace redemption until outstanding grants expire (one hour); no count-based retention shortcut.

## How we will know it is followed

Tests prove zero selection/creation-hook writes, trusted exact receiver in concurrent same-folder cases, no forged/expired/wrong-kind/replayed acceptance (also after over 500 intervening project spends and reload), no spent grant after failed persistence, approved first-chat application with explicit new-chat guidance, and unchanged chat-snapshot semantics. The full plan carries scenarios and rollout.
