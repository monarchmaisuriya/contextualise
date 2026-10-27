# contextualise

A [Paseo](https://paseo.sh) plugin that tags agents across workspaces and providers, fetches Jira, Sentry, Slack, and Notion items into tags, and attaches context to a prompt: a whole tag, another agent's conversation, or terminal output.

Requires Paseo 0.13.

## Install

```bash
paseo plugin install git:monarchmaisuriya/contextualise --ref v0.9.0
```

## Tags

Every agent's composer has a **Tags** pill next to Tasks and Subagents. Its label shows the agent's tags ("Tag" when it has none, "auth rewrite +2" when it has three). Press it to:

- remove a tag (tap its chip),
- add new tags (type names, separated by commas),
- add an existing tag (tap its chip),
- open the Tags screen.

`/tag auth-rewrite` tags the current agent from the message box and `/untag auth-rewrite` removes it (both take several: `/tag auth, billing`). `/tag-link https://example.com/spec auth-rewrite` adds a web link to a tag.

Tags share names with Paseo's workspace labels. A workspace labeled "Auth Rewrite" belongs to the tag `auth rewrite` automatically; case and spacing do not matter. Contextualise reads workspace labels and never changes them.

The **Tags** screen (sidebar footer, or "Open tags" in the Command Center) lists every tag with its labeled workspaces, tagged agents, and links. Each tag has **Preview**, which shows exactly what Attach > Tag sends (with a Copy button), and **Add link**. "Tag this agent..." in the Command Center opens it for one agent, with the same chips as the pill.

## Fetching Jira, Sentry, Slack, and Notion items

`/tag-fetch PROJ-123 auth-rewrite`, **Fetch item** on a tag in the Tags screen, or the Fetch box in the Tags pill saves an item's content under a tag. A reference is a Jira key (`PROJ-123`), a Jira (`*.atlassian.net`), Sentry (`*.sentry.io`), Slack (`*.slack.com/archives/...`), or Notion link, or free text with a prefix: `jira: the issue assigned to me updated most recently`. Before you press Fetch, the form says which agent and connector will read it, or why none can.

Contextualise has no vendor accounts of its own. A hidden background agent reads the item through the MCP connectors that agent already has:

| Agent | Vendors (built in) | How it is kept read-only |
| --- | --- | --- |
| Claude | Jira, Sentry, Slack (claude.ai connectors), Notion | Every MCP tool call asks first; the plugin allows only the route's named read tools |
| Codex | Notion | Read-only sandbox, no web search; every tool its server does not mark read-only asks first, and only the route's named tools are allowed |
| OpenCode | not used | It ran shell commands without asking in testing, so it cannot be kept read-only |

"Fetch with" in Settings chooses the agent (automatic tries Claude, then Codex); the form can override it per item. Custom routes in Advanced settings add other agent and server pairs, for example Codex reading Jira through a Jira MCP server you configured for it. Every allow or deny decision is written to the plugin log. One fetch is one agent run.

The item shows under **Fetched items** on the tag ("fetching", then "ready" or "failed" with the reason) with the agent that fetched it, **Refresh** (or **Retry**), and **Remove**; tap a ready item to read it, copy it, or open its link. Attach > Tag includes ready items.

## Attaching context

In the composer, Attach offers three sources:

| Source | Sends |
| --- | --- |
| **Tag** | The tag's workspaces (project, name, folder), its links, its fetched items, and each tagged agent's most recent turns |
| **Agent conversation** | One agent's most recent turns, from any workspace or provider on this host |
| **Terminal output** | The newest lines of any terminal on this host |

Each picker row says what is inside before you send it: providers and member counts for a tag, provider and workspace for an agent, workspace and length for a terminal. Clicking an attached agent opens that agent; clicking a tag or terminal opens this page.

Conversations contain your messages and the agents' replies; tool calls and reasoning are left out. Secret-shaped text (private keys, AWS, GitHub, Slack and Google keys, `sk-` API keys, JSON web tokens, `password=`-style assignments) is replaced with `[removed: <kind>]` in conversations and terminal output. Every attachment starts with a note that it is reference material, not instructions.

If an agent's history cannot be read, the attachment says so for that agent and the rest still attaches.

## What it reads and stores

Attaching copies other agents' conversations and terminal output into the prompt you are writing, including conversations held by a different provider. Nothing is sent until you send the prompt.

Tags are stored on the daemon host in `<PASEO_HOME>/plugin-data/contextualise/tags.json` (version 2; a version 1 file from 0.1.0 is upgraded on the first change). Nothing else is written.

## Settings

Settings > Contextualise:

| Section | Setting | Default |
| --- | --- | --- |
| Attachments | Longest attachment (characters) | 40,000 (1,000 to 200,000) |
| | Recent turns per agent | 6 (1 to 50) |
| | Terminal lines to attach | 200 (10 to 5,000) |
| | Results in the Attach pickers | 20 (5 to 50) |
| | Include labeled workspaces, links, fetched items, agent conversations | all on |
| Tags pill | Show the pill; label as tag names or a count | on; names |
| Fetching | Fetch with: automatic, Claude only, Codex only | automatic |
| | Claude model; Codex model (empty means the agent's default) | claude-sonnet-5-5; default |
| Advanced | Fetch time limit (seconds) | 180 (30 to 900) |
| | Fetches at once | 2 (1 to 5) |
| | Stored item size (characters) | 8,000 (1,000 to 20,000) |
| | Comments or replies per item | 10 (0 to 50) |
| | Extra instructions for workers | empty (up to 1,000 characters) |
| | Custom routes (JSON) | none (up to 20) |

`0` means the default for the counts that allow it. Out-of-range values are refused; invalid stored settings stop attachments and fetches with an error until they are fixed or reset. Secret redaction cannot be switched off.

A custom route: `{"vendor":"jira","provider":"codex","server":"my-jira","tools":["get_issue","search_issues"]}`. List only tools that read.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
```

Versions follow [semantic versioning](https://semver.org). See [CHANGELOG.md](CHANGELOG.md).
