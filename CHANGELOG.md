# Changelog

## Unreleased

## 0.2.2 - 2026-11-14

- The Cockpit page fills the whole width of its tab, so a maximized Cockpit on a wide screen no longer sits in a
  centred column with empty margins.

## 0.2.1 - 2026-11-14

- Maximize: a button next to Refresh and **Cockpit: Maximize** (⌃⌘M, Ctrl+Alt+M on Windows and Linux) close the
  side bars, the panel and the other editor groups around the Cockpit tab, with VS Code's own commands; no setting
  changes. VS Code's usual keys bring each one back.
- The top bar is one compact row: the name (with the path as its tooltip), the section links, the session counts,
  Refresh and Maximize.
- Start Claude from the roadmap: right-click a card (Cmd/Ctrl-click to select several, in any lane, as one batch)
  and pick **Start Claude…**. Choose the model and the thinking effort; pull the thinking slider down for a
  second slider with up to 8 subagents, and that one down again to pick the model the subagents run on. A new terminal runs `claude` with a standard prompt, in a worktree of its own,
  and the planned cards move to In progress. The launcher remembers the last choices.
- Settings: a sliders button at the end of the top bar opens a small popover with every Cockpit setting: opening on
  startup, how many days of ended sessions, how often to ask GitHub, which sections to show, what **Start Claude…**
  opens with (model, thinking, subagents and their model, worktree, mark in progress), and the steps of its prompt,
  one per line. Changes go to your user settings; **All settings…** opens them in VS Code.
- Settings have two tabs: **All projects** (your user settings) and **This project** (the workspace's
  `.vscode/settings.json`). The prompt steps and the files Release bumps belong to a project: they are read from
  the workspace's settings only, so a value set for one project never applies to another.
- Claudes: **Show all active projects**. Off, the section shows only this window's Claudes, as cards without the
  project heading, and its counts are this project's. The choice is yours for every window.
- Cards link to branches: **Start Claude…** records the branch it starts on (`worktree-<name>`) on each card, as an
  HTML comment at the end of the card's line in `ROADMAP.md`. A linked card shows its branch and its pull request.
- Worktree names start with the lane: `1.5.0-welcome-link-lifetime`, `backlog-tablet-layout`.
- Catch up: a button in the top bar, with a count, opens what changed since you last closed it: the Claudes that
  finished or are waiting, with their branch, commits, uncommitted files, pull request, cards and last answer, each
  with its next action; and the pull requests whose checks passed or failed or that merged. A Claude's last answer
  also shows in the session details, and each item of its "still open" list has **Add as card** into its lane.
- Ship…: pushes a finished branch and opens its pull request through `gh`, after a dialog showing the title and the
  body (the cards and the Claude's report). `ROADMAP.md`, with the branch's cards done, is committed on the branch,
  so the board travels with the merge.
- When a linked pull request merges, the board shows its cards done (a merged release shipped) without touching
  `ROADMAP.md`, so a plain `git pull` still runs; **Pull main** (in Catch up) writes it first and leaves it clean.
- Release…: on a lane whose cards are all done, opens a `release-X` pull request that bumps the version, dates the
  changelog and marks the lane shipped, made in a temporary worktree from `origin`. Once it merges, **Tag vX…** tags
  the merge commit and pushes the tag, after a dialog that says a tag may deploy.
- A new setting, `cockpit.release.versionFiles` (also in the Settings popover): files whose version Release bumps
  besides `package.json`.
- Needs you lists a Claude that stopped with uncommitted files in its worktree.
- Ship's dialog lists the other board changes the commit carries besides the branch's own cards.
- Tag makes an annotated tag (tagger, date, message), so `git describe` and `git push --follow-tags` see it.
- Roadmap: a lane that is shipped and tagged folds to one line, below the Backlog, newest first; click it to open
  its cards. A lane that says shipped but has no tag yet stays open, with its Tag button.

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
