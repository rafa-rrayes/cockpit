# Changelog

## Unreleased

### Fixed

- A session file left by a Claude that crashed no longer counts as live when its pid is reused: the process's start
  time (ps) must match the file's `procStart`.
- A failed `gh` call keeps the last pull requests and CI runs instead of emptying them (the note says so), and a git
  timeout keeps the last Work board instead of hiding it.
- Sessions in a removed worktree stay in their project; sessions with no recorded folder get the folder their
  project directory is named after, never the extension host's own folder.
- A resumed session no longer shows the background subagents of its earlier process as running.
- A branch where a live Claude (or a running subagent) works is In progress, not Merged; a session in a repository
  nested in the main checkout is not attached to the default branch.
- Releases read the open worktree's version, ROADMAP and CHANGELOG; code fences and numbered section headings are
  no longer read as releases.
- Recent prompts fall back to the last prompt for transcripts too big to read back far enough.
- A cold read uses less memory, and resolves projects with at most 8 git processes at once; a failed one is asked
  again next time instead of being cached.
- Clean merged verifies each branch against the default branch (local or remote) before removing its worktree, then
  deletes it with `-D`, so a branch merged on GitHub but not pulled is no longer left without its worktree. It
  checks liveness and other windows' folders again after the dialog, skips locked and running agents' worktrees,
  and says that ignored files are deleted with a worktree.
- Opening a link or a folder from the webview only works for links and folders the State shows, and folders always
  open in a new window.

## 0.1.0 - 2026-11-13

- The Cockpit tab in the editor area, with five sections: Needs you, Claudes, Work, Releases and Activity. It is
  live: file watchers on Claude Code's sessions and on the git directory, and `gh` polling while the tab is visible.
- Opens at startup as the first, pinned tab (`cockpit.openOnStartup`). There is only ever one Cockpit tab.
- A status-bar item and an activity-bar icon, both showing how many things need you.
- Session actions: Resume (`claude --resume` in a new terminal), Focus terminal, Open worktree, Open transcript and
  Copy ID.
- Clean merged: lists the merged worktrees and branches and removes them only after you confirm, with
  `git worktree remove` and `git branch -d`.
- `dist/dump-state.js` prints the State for a folder, to check the data layer and preview the UI outside VS Code.
