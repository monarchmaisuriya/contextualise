# Changelog

All notable changes follow [semantic versioning](https://semver.org).

## 0.6.0 - 2026-10-27

### Added

- Fetch Jira, Sentry, Slack, and Notion items into a tag: `/tag-fetch <ref> <tag>` or **Fetch item** on the Tags screen. A hidden background Claude agent reads the item through the connectors Claude agents already have; the plugin holds no vendor credentials.
- The worker may use only the named read tools of that vendor's connector; every other tool request is denied, and every decision is written to the plugin log.
- **Fetched items** on each tag (status, Refresh, Remove); ready items are included in Attach > Tag, redacted like other attachment text.

### Changed

- `tags.json` is now version 3 (adds fetched items). Versions 1 and 2 are read and upgraded on the first change; older plugin versions refuse a version 3 file instead of dropping items.

## 0.5.0 - 2026-10-27

### Added

- `/untag` is back: `/untag auth-rewrite`, or several with `/untag auth, billing`. The pill's label confirms it; an `/untag` that changes nothing says "Not tagged".

## 0.4.0 - 2026-10-27

### Added

- `/tag` is back alongside the Tags pill: `/tag auth-rewrite`, or several with `/tag auth, billing`. The pill's label confirms it; a `/tag` that changes nothing says "Already tagged". Removing tags stays in the pill.

## 0.3.0 - 2026-10-27

### Added

- A **Tags** pill on every active agent's composer. Its label shows the agent's tags; pressing it opens a popover to remove tags, add new ones, add existing ones with one tap, or open the Tags screen.

### Removed

- `/tag`, `/untag`, and `/tags`. The Tags pill replaces them. `/tag-link` stays.
- Tagging no longer adds a confirmation row to the agent's timeline; the pill label shows the result. Rows added by 0.2.1 still display.

## 0.2.1 - 2026-10-27

### Fixed

- The plugin failed to load in the Paseo app ("Invalid timeline renderer kind: contextualise.receipt"): Paseo accepts only lower-case letters, digits, and hyphens in registered names. The confirmation row's kind is now `receipt`. A new test runs the real app-side registration against Paseo's naming rule, so a bad name fails the tests instead of the app.

## 0.2.0 - 2026-10-27

### Added

- **Agent conversation** attach source: any agent on the host, matched on title, provider, workspace, and folder. Clicking the attachment opens that agent.
- **Terminal output** attach source: the newest lines of any terminal on the host.
- Link tags: `/tag-link <url> <tag>` and **Add link** on the Tags screen. Links are listed in the tag attachment.
- `/tag` and `/untag` take several tags separated by commas.
- `/tags` and "Tag this agent..." open the Tags screen for one agent, with its tags as chips to remove and other tags as chips to add.
- One confirmation row in the agent's timeline after `/tag` and `/untag`, replaced on each use, with an "Open tags" link.
- **Preview** on each tag: exactly what Attach > Tag sends, with Copy.
- Filter box on the Tags screen.
- Setting: terminal lines to attach (default 200).

### Fixed

- One agent whose history cannot be read no longer breaks the whole Attach > Tag picker; that agent is shown with the reason and the rest attaches.
- Secret-shaped text in conversations and terminal output is replaced with `[removed: <kind>]` before it is attached.
- The attached tag pill no longer shows the tag name twice, and clicking it opens documentation instead of an unusable `paseo://` link.
- Error toasts show the plugin's message without transport details.
- Settings show the stored value after saving (`0` becomes the default).
- The picker reuses the agent and workspace list for 5 seconds instead of reading it on every keystroke.

### Changed

- `tags.json` is now version 2 (adds links). A version 1 file is read and upgraded on the first change; 0.1.0 refuses a version 2 file instead of dropping links.
- `/tag` on an already-tagged agent reports it in the confirmation row instead of as an error.

## 0.1.0 - 2026-10-27

- First release: `/tag`, `/untag`, Tags screen, Attach > Tag, merging tags with Paseo workspace labels.
