# Changelog

## Unreleased

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
