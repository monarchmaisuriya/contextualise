# contextualise

A [Paseo](https://paseo.sh) plugin that tags agents across workspaces and providers, fetches Jira, Sentry, Slack, and Notion items into tags, and attaches context to a prompt: a whole tag, another agent's conversation, or terminal output.

Requires Paseo 0.13.

## Install

```bash
paseo plugin install git:monarchmaisuriya/contextualise --ref v0.6.0
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

`/tag-fetch PROJ-123 auth-rewrite`, or **Fetch item** on a tag in the Tags screen, saves an item's content under a tag. A reference is a Jira key (`PROJ-123`), a Jira (`*.atlassian.net`), Sentry (`*.sentry.io`), Slack (`*.slack.com/archives/...`), or Notion link, or free text with a prefix: `jira: the issue assigned to me updated most recently`.

Contextualise has no vendor accounts of its own. It starts a hidden background Claude agent, which reads the item through the connectors your Claude agents already have (claude.ai's Atlassian, Sentry, and Slack connectors, and a Notion MCP server). The worker may use only that vendor's read tools: every tool it asks for is checked against a fixed list and anything else is denied, and every decision is written to the plugin log. The worker is archived when it finishes; one fetch is one Sonnet run.

The item shows under **Fetched items** on the tag ("fetching", then "ready" or "failed" with the reason), with **Refresh** and **Remove**. Attach > Tag includes ready items. Each stored item is capped at 8,000 characters; at most two fetches run at once, each for up to 3 minutes.

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

| Setting | Default | Range |
| --- | --- | --- |
| Longest attachment (characters) | 40,000 | 1,000 to 200,000 |
| Recent turns per agent | 6 | 1 to 50 |
| Terminal lines to attach | 200 | 10 to 5,000 |

`0` means the default. Out-of-range values are refused; invalid stored settings stop attachments with an error until they are fixed or reset. In a tag, each agent gets an equal share of the character budget and older turns are dropped first; the attachment says how many.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
```

Versions follow [semantic versioning](https://semver.org). See [CHANGELOG.md](CHANGELOG.md).
