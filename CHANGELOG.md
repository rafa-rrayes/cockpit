# Changelog

## Unreleased

## 0.1.1 - 2026-11-13

- Roadmap board: a new section with a lane for each release in `ROADMAP.md` plus a Backlog, and the columns
  Planned, In progress and Done. Cards can be dragged between columns and lanes, renamed, moved from their menu and
  deleted (after a confirmation); cards and releases can be added. Every edit changes only its own lines of
  `ROADMAP.md`, through the editor, so undo works. An edit is refused when the file changed underneath it.
- `ROADMAP.md` gains `- [~]` for work in progress and a `## Backlog` section. With no `ROADMAP.md`, the board
  offers to create one with the next minor version and a Backlog.
- The board follows `ROADMAP.md` when it is changed outside VS Code.
- Releases no longer lists the roadmap: it has its own section.

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
