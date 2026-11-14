# Cockpit

A VS Code extension that takes over the editor area with a live, interactive overview of the project and of every
Claude Code session on this machine:

- **Needs you**: Claudes waiting on a permission prompt or a question, a failed CI run on the default branch,
  pull requests with changes requested. The count also shows on the status-bar item and the activity-bar icon.
- **Claudes**: one card per session (busy, waiting, idle, or ended in the last days), grouped by project with this
  window's project first. Each card shows the title, branch, last prompt, subagents and workflow runs. Click a card
  for the details: recent prompts, workflow phases, subagents, and the actions **Resume** (a new terminal running
  `claude --resume <id>` in the session's folder), **Focus terminal** (when it runs in a terminal of this window),
  **Open worktree**, **Open transcript** and **Copy ID**.
- **Work**: branches and worktrees as a board (In progress, Merged, Stale) with uncommitted files, ahead/behind,
  the pull request and its checks, and the Claudes working there. Below that, the latest CI runs.
  **Clean merged…** lists the merged worktrees and branches it would remove and does nothing until you confirm.
  It runs `git worktree remove` (never `--force`) and `git branch -d` (never `-D`), and reports what git refused.
- **Releases**: the current version, the latest tag and the commits since it, the changelog's Unreleased lines,
  and the roadmap.
- **Activity**: commits, session starts and ends, CI runs and pull requests, newest first.

Cockpit only reads. It changes nothing except through those buttons. Transcripts never leave the machine, and the
only network calls are `gh` commands, made with your existing GitHub CLI login.

## Build and install

    npm install
    npm run typecheck   # extension host and webview
    npm test            # vitest: the data layer, compose, the action guards
    npm run build       # dist/extension.js, dist/webview.{js,css}, dist/dev.html, dist/dump-state.js
    npm run smoke       # starts a real VS Code (downloaded into .vscode-test/) with the extension
    npm run package     # cockpit-0.1.0.vsix

Install it with `code --install-extension cockpit-0.1.0.vsix`, then reload the window. VS Code 1.100 or newer is
required. `git` must be on the PATH. `gh` (logged in) is optional: without it, the PR and CI parts are left out and
a short note says why.

## Use

- **Cockpit: Open** (or the status-bar item, or the gauge icon in the activity bar) shows the Cockpit tab. There
  is only ever one: opening it again brings the same tab to the front.
- With `cockpit.openOnStartup` on, a new window opens Cockpit as the first, pinned tab. Files you had open stay
  open beside it. VS Code has no API to remove the editor area itself, so Cockpit is a tab: your files open in
  tabs next to it, and the status-bar item brings it back. Cockpit offers once to set `workbench.startupEditor`
  to `none`, so the Welcome page doesn't open as well.
- **Cockpit: Refresh** reads everything again. Otherwise it updates by itself:
  - Claude sessions: when `~/.claude/sessions` changes, and every 15 s (60 s while the tab is hidden).
  - Git: when the repository's refs, HEAD or worktrees change, when you save a file, and every 15 s while the tab
    is visible.
  - GitHub: every `cockpit.githubPollSeconds` while the tab is visible, never while it's hidden.
- In a multi-root workspace, Cockpit shows the first folder.

## Settings

| Setting | Default | |
|---|---|---|
| `cockpit.openOnStartup` | `true` | Open Cockpit as the first, pinned tab when a window starts. |
| `cockpit.endedSessionDays` | `7` | How many days of ended Claude sessions to show. |
| `cockpit.githubPollSeconds` | `60` | How often to ask GitHub (through `gh`) while Cockpit is visible. The minimum is 15. |

Claude Code's directory is `$CLAUDE_CONFIG_DIR` when that is set (as Claude Code itself does), otherwise
`~/.claude`.

## What it reads

**Claude Code's own files, which are undocumented internals.** These are `~/.claude/sessions/<pid>.json` (live
sessions), `~/.claude/projects/<slug>/<sessionId>.jsonl` (transcripts, read from the end), and the subagent and
workflow files next to them. They can change in any Claude Code release. All of that parsing is in
`src/data/claude.ts`, which skips what it doesn't understand and shows "unknown" rather than failing. If a Claude
Code update breaks something, that file is the place to fix it. It was written against Claude Code 2.1.3xx.

**Git** commands only read: `worktree list`, `for-each-ref`, `status --porcelain` with `GIT_OPTIONAL_LOCKS=0` (so
they never take `index.lock` while a Claude commits), `log`, `tag`.

**GitHub**: `gh repo view`, `gh pr list`, `gh run list`.

**Release files** in the repository root:

- The version comes from the first file in this list that has one: `package.json`, `app.json` (`expo.version`),
  `app/app.json`, `pyproject.toml`, `Cargo.toml`.
- The latest tag is the newest `v*` tag.

`ROADMAP.md`:

    ## 1.2.0 — Comunidade          version (an optional "v" or [brackets]), "—", "-" or ":", an optional title
    Target: week of 2026-11-16     optional, free text
    Status: in progress            optional, free text (planned, in progress, shipped)
    - [ ] Seasons                  not done
    - [x] Video feed               done
    - Comments                     a plain item counts as not done

Headings that don't start with a version (`## Later`) are skipped.

`CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com) style):

    ## Unreleased                  also "## [Unreleased]"
    ## 1.2.0 - 2026-11-20          also "## [1.2.0] - 2026-11-20", "## v1.2.0 (2026-11-20)"
    ### Added                      sub-headings are skipped, their items kept
    - A line

Unreleased is shown first, then the newest four releases.

## Development

- `src/model.ts` is the contract: the `State` the extension host sends to the webview, and the messages the
  webview sends back.
- `src/data/*` are the adapters (Claude Code, git, GitHub, releases).
- `src/compose.ts` builds the State from them. It is pure and unit-tested.
- `src/store.ts` runs the refresh loop.
- `src/actions.ts` handles the webview's messages. The checks on them are in `src/guards.ts`.
- `src/extension.ts` handles the tab, the startup takeover, the status bar and the activity bar.
- `webview/` is the Preact UI.

To look at the UI with real data outside VS Code:

    npm run build
    node dist/dump-state.js /path/to/a/repo > dist/state.json     # --no-github to skip gh, --days N
    cd dist && python3 -m http.server 8000                         # then open
    # http://127.0.0.1:8000/dev.html?state=state.json  (add &theme=light for the light theme)

`dist/dev.html` with no `?state=` shows an invented sample State. `dist/state.json` contains your real prompts, so
delete it afterwards; `dist/` is not committed or packaged.
