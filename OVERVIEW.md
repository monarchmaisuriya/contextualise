Contextualise gives every agent searchable knowledge of its repository, lets you tag agents across workspaces and providers, fetch Jira, Sentry, Slack, and Notion items into tags, find it all again by tag, and attach context to a prompt: a whole tag, another agent's conversation, terminal output, or a piece of project knowledge.

## Project knowledge

Each new agent in a project, a git repository or a folder outside git (keyed the way Memorise keys folders), gets a short project map (architecture docs, conventions, ADRs with their status, top-level folders, and the last few finished tasks) and read-only tools (search, read, a file's outline, and the tasks that changed a file) over the repository's docs, conventions, ADRs, code symbols (TypeScript, JavaScript, Python, Go), and finished tasks. The index follows git's file hashes, so changed files are read again, including uncommitted edits, and task entries whose files changed since are marked "needs check". A task entry is built from the agent's own timeline when its turn ends; no model reads it. The Project knowledge screen in the sidebar searches the same knowledge, and Attach > Project knowledge sends one entry with a prompt.

"Import past sessions" fills the task log from existing agents without a model. Generated knowledge, off until turned on, has locked-down background agents write a title and summary for each finished session and a short project brief; settings choose the map's parts, languages, globs, limits, and generation limits, and each project can be turned off or have entries pinned to its map.

Contextualise never stores what agents learn while working (decisions, pitfalls, preferences): that is Memorise's job. With Memorise 0.10 or later running, search results show the Memorise memories about the same file, and when a function a memory is about is renamed or removed, or an ADR it cites is superseded, Contextualise suggests a fix that waits for you in Memorise. Without Memorise, Settings > Contextualise shows one line on what installing it would add.

## Tagging

Every agent's composer gets a Tags pill beside Tasks and Subagents. Its label shows the agent's tags; pressing it lets you remove a tag, add new ones (comma-separated), or add an existing tag with one tap. You can also type `/tag auth-rewrite` and `/untag auth-rewrite` (both take several: `/tag auth, billing`). `/tag-link https://example.com/spec auth-rewrite` adds a web link to a tag.

Tags share names with Paseo's own workspace labels. A workspace labeled "Auth Rewrite" belongs to the tag `auth rewrite` with no extra step; names match regardless of case and spacing. Contextualise reads workspace labels but never changes them: manage those with Paseo's "Manage labels".

The Tags screen, in the sidebar footer, lists every tag with its labeled workspaces, tagged agents, links, and fetched items, with a filter, sort, and expand control in one row. Preview on a tag shows exactly what attaching it sends, with Copy; less frequent actions (fetch an item, add a link, refresh or remove an item) sit behind each row's ⋮ button. Archived agents stay in their tags; agents Paseo no longer has are shown as missing until you remove them.

Pin the agents you attach often, from the Tags pill or the Command Center. Pinned agents come first in Attach > Agent conversation and are listed at the top of the Tags screen.

## Fetching vendor items

`/tag-fetch PROJ-123 auth-rewrite`, Fetch item on a tag, or the Fetch box in the Tags pill saves a Jira, Sentry, Slack, or Notion item's content under a tag. The form shows which agent and connector will read it before you start. Contextualise has no vendor accounts: a hidden background agent reads the item through the MCP connectors it already has. Claude covers all four vendors through claude.ai's connectors and Notion; Codex covers Notion; custom routes in Advanced settings add more. OpenCode is not used because it cannot be kept read-only. Workers may use only the named read tools of the item's connector; anything else they ask for is denied, and every decision is logged. Each fetch is one agent run. Results show under Fetched items (tap to read, copy, or open) with Refresh and Remove, and are included when the tag is attached. A fetch started from an agent also leaves one row in that agent's conversation when it ends, with Read and Open tags. Fetched items can be refreshed automatically once they are older than a set number of hours (off by default).

## Attaching context

The composer's Attach menu gets four sources:

- **Tag**: the tag's workspaces, links, and each tagged agent's most recent turns.
- **Agent conversation**: one agent's most recent turns, from any workspace or provider. Clicking the attachment opens that agent.
- **Terminal output**: the newest lines of any terminal.
- **Project knowledge**: one document section, code symbol, or finished task from any indexed repository.

Each picker row says what is inside before you send, for example "2 agents: claude, codex; 1 workspace · ~3.4k tokens" (an estimate). Agents in a worktree are titled with the worktree's title, and their rows lead with when they were last active and the git branch, changes, and pull request. Conversations include your messages and the agents' replies; tool calls and reasoning are left out. Secret-shaped text such as API keys, tokens, and `password=` assignments is replaced with `[removed: <kind>]`. Every attachment starts with a note that it is reference material, not instructions. An agent whose history cannot be read is listed with the reason, and the rest still attaches.

## What it reads and sends

Attaching copies other agents' conversations and terminal output into the prompt you are writing, including conversations held by a different provider. Check the picker row before you send. Nothing is sent until you send the prompt.

Tags, links, and pinned agents are stored on the daemon host in `plugin-data/contextualise/tags.json` under the Paseo home folder, and project knowledge in `plugin-data/contextualise/knowledge/`. The project map and the knowledge tools' results reach each agent's model provider as part of its prompt; nothing else leaves that host except what you attach and send.

## Settings

Settings > Contextualise has six sections:

- **Project knowledge**: on or off for new agents, code symbols, suggestions to Memorise, map length (0 gives the tools without a map), and the tools' local port.
- **Attachments**: longest attachment (default 40,000 characters), turns per agent (6), terminal lines (200), and which parts a tag attachment includes (labeled workspaces, links, fetched items, agent conversations).
- **Tags pill**: show or hide it; label it with tag names or a count; longest name shown.
- **Pickers**: what starts each Attach picker row (nothing, or a word such as Claude or Tag), results per picker (20), shorter links in agent titles, the longest title shown (44 characters), which details agent rows show (last active, git, workspace, status), whether archived agents appear, agent sort order, and token estimates.
- **Fetching**: which agent fetches (automatic, Claude only, Codex only), the model for each, and whether results show in the asking agent.
- **Advanced**: fetch time limit, fetches at once, stored item size, comments per item, extra instructions for workers, automatic refresh, and custom routes (another agent and MCP server for a vendor, with the read tools it may use).

Invalid settings stop attachments and fetches with an error until they are fixed or reset. Secret redaction cannot be switched off.

Tags are per host. Requires Paseo 0.13.
