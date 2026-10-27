Contextualise lets you tag agents across workspaces and providers, find them again by tag, and attach a whole tag to a prompt.

## Tagging

In any agent, type `/tag auth-rewrite` to tag that agent, and `/untag auth-rewrite` to remove it. The Command Center has "Tag this agent..." and "Open tags".

Tags share names with Paseo's own workspace labels. A workspace labeled "Auth Rewrite" belongs to the tag `auth rewrite` with no extra step; names match regardless of case and spacing. Contextualise reads workspace labels but never changes them: manage those with Paseo's "Manage labels".

The Tags screen, in the sidebar footer, lists every tag with its labeled workspaces and tagged agents. Agents that were archived stay in their tags. Agents Paseo no longer has are shown as missing until you remove them. A tag with agents but no matching workspace label says so, which is how a renamed label shows up.

## Attaching a tag

In the composer, Attach > Tag lists matching tags. Each row says how many agents and workspaces the tag holds and which providers those agents use, for example "2 agents: claude, codex; 1 workspace". Picking one adds a single text attachment containing:

- the workspaces with that label (project, name, folder)
- for each tagged agent, its title, provider, and its most recent turns: your messages and the agent's replies. Tool calls and reasoning are left out.

The attachment starts with a note that it is reference material, not instructions.

## What it reads and sends

Attaching a tag copies other agents' conversations into the prompt you are writing, including conversations held by a different provider. Check the providers in the picker before you send. Nothing is sent until you send the prompt.

Tagged agents are stored on the daemon host in `plugin-data/contextualise/tags.json` under the Paseo home folder. Nothing leaves that host except what you attach and send.

## Settings

Settings > Contextualise:

- **Longest tag attachment**: default 40,000 characters (about 10,000 tokens), from 1,000 to 200,000. Each agent gets an equal share; older turns are dropped first and the attachment says how many.
- **Recent turns per agent**: default 6, from 1 to 50.

Invalid settings stop tag attachments with an error until they are fixed or reset.

Tags are per host. Requires Paseo 0.13.
