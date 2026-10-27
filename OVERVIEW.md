Contextualise lets you tag agents across workspaces and providers, find them again by tag, and attach context to a prompt: a whole tag, another agent's conversation, or terminal output.

## Tagging

In any agent, type `/tag auth-rewrite` to tag it (several at once: `/tag auth, billing`), `/untag auth-rewrite` to remove it, and `/tags` to see and edit its tags. `/tag-link https://example.com/spec auth-rewrite` adds a web link to a tag. After `/tag` or `/untag`, a small confirmation row in the agent's timeline says what changed; each new one replaces the last.

Tags share names with Paseo's own workspace labels. A workspace labeled "Auth Rewrite" belongs to the tag `auth rewrite` with no extra step; names match regardless of case and spacing. Contextualise reads workspace labels but never changes them: manage those with Paseo's "Manage labels".

The Tags screen, in the sidebar footer, lists every tag with its labeled workspaces, tagged agents, and links, with a filter box. Preview on a tag shows exactly what attaching it sends, with Copy. Archived agents stay in their tags; agents Paseo no longer has are shown as missing until you remove them.

## Attaching context

The composer's Attach menu gets three sources:

- **Tag**: the tag's workspaces, links, and each tagged agent's most recent turns.
- **Agent conversation**: one agent's most recent turns, from any workspace or provider. Clicking the attachment opens that agent.
- **Terminal output**: the newest lines of any terminal.

Each picker row says what is inside before you send, for example "2 agents: claude, codex; 1 workspace". Conversations include your messages and the agents' replies; tool calls and reasoning are left out. Secret-shaped text such as API keys, tokens, and `password=` assignments is replaced with `[removed: <kind>]`. Every attachment starts with a note that it is reference material, not instructions. An agent whose history cannot be read is listed with the reason, and the rest still attaches.

## What it reads and sends

Attaching copies other agents' conversations and terminal output into the prompt you are writing, including conversations held by a different provider. Check the picker row before you send. Nothing is sent until you send the prompt.

Tags and links are stored on the daemon host in `plugin-data/contextualise/tags.json` under the Paseo home folder. Nothing leaves that host except what you attach and send.

## Settings

Settings > Contextualise:

- **Longest attachment**: default 40,000 characters (about 10,000 tokens), from 1,000 to 200,000. In a tag, each agent gets an equal share; older turns are dropped first and the attachment says how many.
- **Recent turns per agent**: default 6, from 1 to 50.
- **Terminal lines to attach**: default 200, from 10 to 5,000.

Invalid settings stop attachments with an error until they are fixed or reset.

Tags are per host. Requires Paseo 0.13.
