# Changelog

All notable changes follow [semantic versioning](https://semver.org).

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
