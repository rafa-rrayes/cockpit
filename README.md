# Cockpit

A VS Code extension that takes over the editor area with a live, interactive overview of the project and of every
Claude Code session on this machine:

- **Needs you**: Claudes waiting on a permission prompt or a question, a failed CI run on the default branch,
  pull requests with changes requested, and a Claude that stopped (idle or ended) with uncommitted files in its
  worktree. The count also shows on the status-bar item and the activity-bar icon.
- **Catch up** (top bar, with a count): what changed since you last closed it. Each Claude of this project that
  finished or is waiting, newest first, one per branch: its branch, how many commits ahead and the last subject, the
  uncommitted files, its pull request, its roadmap cards and its last answer (the report), with one next action:
  **Ship…**, **Resume**, **Focus terminal**, **Open #n** or **Details**. Then the pull requests whose checks passed or
  failed, or that merged (**Pull main**). Closing it counts all of it as seen, except a Claude whose
  branch is still to ship or whose uncommitted work is still to resume: those stay until it is done; the first time, it covers the last
  day. Under a report's "still open" list, **Add as card** puts an item in the session's lane.
- **Claudes**: one card per session (busy, waiting, idle, or ended in the last days), grouped by project with this
  window's project first. Each card shows the title, branch, last prompt, subagents and workflow runs. Click a card
  for the details: recent prompts, workflow phases, subagents, and the actions **Resume** (a new terminal running
  `claude --resume <id>` in the session's folder), **Focus terminal** (when it runs in a terminal of this window),
  **Open worktree**, **Open transcript** and **Copy ID**.
- **Work**: branches and worktrees as a board (In progress, Merged, Stale) with uncommitted files, ahead/behind,
  the pull request and its checks, and the Claudes working there. Below that, the latest CI runs.
  **Clean merged…** lists the merged worktrees and branches it would remove and does nothing until you confirm.
  It leaves out anything a live Claude or a running subagent works in, a locked worktree, and a folder open in
  any VS Code window. After you confirm it checks again, then for each branch verifies with
  `git merge-base --is-ancestor` that its commits are all in the default branch (local or `origin` copy), runs
  `git worktree remove` (never `--force`, so a worktree with uncommitted or untracked files is kept; ignored files
  such as `node_modules` go with it), and deletes the branch with `git branch -D`, which is safe once verified and
  works for a branch merged on GitHub but not pulled yet. Squash-merged branches are left to you: git cannot
  confirm them. It reports what it kept and why.
- **Roadmap**: a board you edit in place, with a lane for each planned release plus a Backlog, and the columns
  Planned, In progress and Done. Drag a card sideways to change its status, or to another lane to move it to
  another release. Each card's menu does the same without dragging, and also renames and deletes. **Add card**
  sits under each lane's Planned column, and **Release** adds a lane. `ROADMAP.md` in the open folder is the
  storage: every edit changes only its own lines in that file, through VS Code's editor, so undo works there and
  the file stays one you (and any Claude) can edit by hand. With no `ROADMAP.md`, the section offers to create one.
  **Start Claude…**, in a card's right-click menu, opens a terminal running `claude` on that card. Cmd-click
  (Ctrl-click) selects more cards, in any lane, to start one Claude on them as a batch. The launcher picks the model
  and the thinking effort (low to max); drag the thinking slider down, or click the handle under it, for a second
  slider with up to 8 subagents, and pull that one down for the model every subagent runs on (Auto leaves it to
  Claude Code; a model is forced with `CLAUDE_CODE_SUBAGENT_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`). The Claude gets a standard
  prompt (follow CLAUDE.md and the lessons, keep the change small, prove it with the tests, update the changelog,
  commit on its branch, don't push), runs in a worktree of its own unless you untick it, and its planned cards
  move to In progress. The worktree is named after the lane and the card (`1.5.0-welcome-link-lifetime`,
  `backlog-tablet-layout`), Claude Code makes its branch `worktree-<name>`, and the cards are linked to that branch:
  each shows the branch and its pull request.
- **Ship, release, tag** (see [Ship and release](#ship-and-release)): **Ship…** on a finished branch (in Work and
  Catch up) pushes it and opens its pull request; **Release X…** on a lane whose cards are all done opens the
  release pull request; once that merges, **Tag vX…** tags and pushes. Each asks first, in a dialog that shows what
  it will do.
- **Releases**: the current version, the latest tag and the commits since it, and the changelog's Unreleased
  lines.
- **Activity**: commits, session starts and ends, CI runs and pull requests, newest first.

Cockpit only reads, except when you act: **Clean merged…**; the roadmap board, which writes `ROADMAP.md`; and
**Ship…**, **Release…**, **Tag…** and **Pull**, which change git and GitHub only after a confirmation. One thing
happens by itself: when a linked branch's pull request (or a release pull request) has merged, the main checkout's
`ROADMAP.md` is updated to read as the merge has it (see below). **Start Claude…** only opens a terminal: the Claude
in it works under its own permission prompts. A Claude's last answer goes into a pull request's body only when you
Ship; otherwise transcripts never leave the machine. The network calls are `gh` commands, made with your existing
GitHub CLI login, and the `git fetch`/`push`/`pull` of those actions, to `origin`.

## Ship and release

These run from the main checkout (the folder whose `ROADMAP.md` the board shows) and go to `origin` and the
default branch. Each checks first and refuses with the reason; each shows its title and body (or its files) in a
confirmation dialog, and does nothing if you cancel. If a step fails, a dialog says what was already done.

- **Ship…** (a branch with a worktree of its own, commits ahead, no uncommitted files, no open pull request, no
  Claude busy on it): in the branch's worktree it fetches the default branch; if the default branch's `ROADMAP.md`
  changed since the branch started, it merges `origin/<default>` into the branch (and aborts the merge on a
  conflict). It commits `ROADMAP.md` as the board has it, with the branch's cards ticked and unlinked, pushes the
  branch and runs `gh pr create`. The title is the cards (or the last commit subject); the body lists the cards and
  the Claude's last answer as the report. So the board travels with the pull request, and the main checkout never
  commits.
- **Merged**: when a linked branch's pull request merged, its cards are made done and unlinked in the main
  checkout's `ROADMAP.md`; when a release pull request merged, its lane's `Status:` becomes `shipped`. That is the
  text the merge brought, so **Pull** afterwards leaves `ROADMAP.md` clean. It waits while `ROADMAP.md` has unsaved
  edits.
- **Pull main** (Catch up, on a merged pull request): `git pull --ff-only --autostash` on the main checkout, after
  the update above. A conflict when the stash is put back is reported.
- **Release X…** (a lane whose cards are all done): in a temporary worktree made from `origin/<default>` (this
  checkout is not touched), it bumps the version in `package.json` and the files in `cockpit.release.versionFiles`,
  dates `## Unreleased` in `CHANGELOG.md` as `## X - <today>` (leaving a new, empty `## Unreleased` above it), sets the lane's `Status: shipped`, commits on a new
  branch `release-X`, pushes it and opens the pull request. The temporary worktree is always removed.
- **Tag vX…** (the release pull request merged, or the lane says shipped, and no tag at or after X): finds the
  merge commit through `gh`, creates the annotated tag `vX` on it and pushes it. The dialog says that a pushed tag
  may start a deploy. If the push fails, the local tag is deleted again.

A card's link to its branch is an HTML comment at the end of its line in `ROADMAP.md`, which Markdown hides:

    - [~] Welcome link lifetime as an env var <!-- cockpit:worktree-1.5.0-welcome-link-lifetime -->

Branches keep their `worktree-` name when pushed, so the local and remote names match.

## Build and install

    npm install
    npm run typecheck   # extension host and webview
    npm test            # vitest: the data layer, compose, the action guards
    npm run build       # dist/extension.js, dist/webview.{js,css}, dist/dev.html, dist/dump-state.js
    npm run smoke       # starts a real VS Code (downloaded into .vscode-test/) with the extension
    npm run package     # cockpit-0.1.1.vsix

Install it with `code --install-extension cockpit-0.1.1.vsix`, then reload the window. VS Code 1.100 or newer is
required. `git` must be on the PATH. `gh` (logged in) is optional: without it, the PR and CI parts are left out and
a short note says why.

## Use

- **Cockpit: Open** (or the status-bar item, or the gauge icon in the activity bar) shows the Cockpit tab. There
  is only ever one: opening it again brings the same tab to the front.
- With `cockpit.openOnStartup` on, a new window opens Cockpit as the first, pinned tab. Files you had open stay
  open beside it. VS Code has no API to remove the editor area itself, so Cockpit is a tab: your files open in
  tabs next to it, and the status-bar item brings it back. Cockpit offers once to set `workbench.startupEditor`
  to `none`, so the Welcome page doesn't open as well.
- **Cockpit: Maximize** (⌃⌘M, Ctrl+Alt+M on Windows and Linux, or the button next to Refresh) brings the Cockpit
  tab to the front with the side bars and the panel closed; the activity bar, the tabs and the status bar stay. The
  same keys, the button again or Escape twice put the layout back as it was. It is VS Code's Zen mode: Cockpit
  changes Zen mode's defaults to no full screen, no centered layout, status and activity bars shown and
  notifications on. A `zenMode.*` setting of your own wins over these.
- **Cockpit: Refresh** reads everything again. Otherwise it updates by itself:
  - Claude sessions: when `~/.claude/sessions` changes, and every 15 s (60 s while the tab is hidden).
  - Git, the roadmap and the changelog: when the repository's refs, HEAD or worktrees change, when you save a
    file, when `ROADMAP.md` changes on disk (a Claude editing it in a terminal), and every 15 s. While the tab is
    hidden these wait, and Cockpit catches up when it is shown again.
  - GitHub: every `cockpit.githubPollSeconds` while the tab is visible, never while it's hidden.
- In a multi-root workspace, Cockpit shows the first folder.

## Settings

The sliders button at the end of the top bar opens a small settings popover with all of these; a change there is
written to your user settings, and **All settings…** opens them in VS Code's Settings.

| Setting | Default | |
|---|---|---|
| `cockpit.openOnStartup` | `true` | Open Cockpit as the first, pinned tab when a window starts. |
| `cockpit.endedSessionDays` | `7` | How many days of ended Claude sessions to show. |
| `cockpit.githubPollSeconds` | `60` | How often to ask GitHub (through `gh`) while Cockpit is visible. The minimum is 15. |
| `cockpit.hiddenSections` | `[]` | Sections to leave out: `needs`, `claudes`, `roadmap`, `work`, `releases`, `activity`. |
| `cockpit.launch.model` | `default` | The model **Start Claude…** opens with (`default`, `fable`, `opus`, `sonnet`, `haiku`). |
| `cockpit.launch.effort` | `high` | The thinking effort it opens with (`low` … `max`). |
| `cockpit.launch.subagents` | `0` | Up to how many subagents (0 … 8). |
| `cockpit.launch.subagentModel` | `auto` | The model the subagents run on. |
| `cockpit.launch.worktree` | `true` | Start the Claude in a worktree of its own. |
| `cockpit.launch.markDoing` | `true` | Move planned cards to In progress. |
| `cockpit.promptSteps` | `[]` | The steps of the prompt a Claude started from the board works by. Empty: the standard steps. The steps that follow from the launcher's options (worktree or main checkout, committing, subagents) are always added. |
| `cockpit.release.versionFiles` | `[]` | Files whose version **Release…** bumps besides the root `package.json`, as paths from the repository root (e.g. `pyproject.toml`). In each, the first `"version"` key (JSON) or the first standalone current version is replaced. `package-lock.json` is not bumped. |

The launcher opens with the options the last Claude was started with, until a default is changed in the popover.

Claude Code's directory is `$CLAUDE_CONFIG_DIR` when that is set (as Claude Code itself does), otherwise
`~/.claude`.

## What it reads

**Claude Code's own files, which are undocumented internals.** These are `~/.claude/sessions/<pid>.json` (live
sessions), `~/.claude/projects/<slug>/<sessionId>.jsonl` (transcripts, read from the end), and the subagent and
workflow files next to them. They can change in any Claude Code release. All of that parsing is in
`src/data/claude.ts`, which skips what it doesn't understand and shows "unknown" rather than failing. If a Claude
Code update breaks something, that file is the place to fix it. It was written against Claude Code 2.1.3xx.

The last assistant answer of each session (up to 20,000 characters) is kept as its report, for Catch up, the
session details and a shipped pull request's body.

**Git** commands only read: `worktree list`, `for-each-ref`, `status --porcelain` with `GIT_OPTIONAL_LOCKS=0` (so
they never take `index.lock` while a Claude commits), `log`, `tag`. Ship, Release, Tag and Pull (above) write.

**GitHub**: `gh repo view`, `gh pr list`, `gh run list`; and `gh pr create` when you Ship or Release.

**Release files** in the root of the folder that is open (a worktree's own files, when a worktree is open; tags
come from the repository):

- The version comes from the first file in this list that has one: `package.json`, `app.json` (`expo.version`),
  `app/app.json`, `pyproject.toml`, `Cargo.toml`.
- The latest tag is the newest `v*` tag.

`ROADMAP.md`, which the board reads and writes (`src/data/roadmap.ts`):

    ## 1.2.0 — Comunidade          a release: version (an optional "v" or [brackets]), "—", "-" or ":", an optional title
    Target: week of 2026-11-16     optional, free text
    Status: in progress            optional, free text (planned, in progress, shipped)
    - [ ] Comments                 planned (a plain "- Comments" too)
    - [~] Video feed               in progress (also "[/]" and "[-]")
    - [x] Seasons                  done
    - [~] Feed <!-- cockpit:worktree-1.2.0-feed -->   linked to a branch (Start Claude and Ship write this)

    ## Backlog                     work not yet in a release (also "Later", "Unscheduled", "Someday", "Ideas")
    - [ ] Tablet layout

Other headings (`## Notes`, or a numbered section such as `## 1. Foundations`: a version has a dot or a leading
`v`) are skipped with their items, and so is anything inside a code fence, in both files. The board leaves every
line it doesn't edit exactly as it was. A release's title, target and status are edited in the file (**Open
file**), and so is removing a release. If the file changed after the board last read it, so that an edit no
longer finds its line, the edit is refused and the board reloads; it never guesses.

`CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com) style):

    ## Unreleased                  also "## [Unreleased]"
    ## 1.2.0 - 2026-11-20          also "## [1.2.0] - 2026-11-20", "## v1.2.0 (2026-11-20)"
    ### Added                      sub-headings are skipped, their items kept
    - A line

Unreleased is shown first, then the newest four releases.

## Development

- `src/model.ts` is the contract: the `State` the extension host sends to the webview, and the messages the
  webview sends back.
- `src/data/*` are the adapters (Claude Code, git, GitHub, releases). `src/data/roadmap.ts` parses `ROADMAP.md`
  and applies the board's edits to its text; it is pure, so the browser preview runs the same code.
- `src/compose.ts` builds the State from them. It is pure and unit-tested.
- `src/store.ts` runs the refresh loop.
- `src/actions.ts` handles the webview's messages. The checks on them are in `src/guards.ts`.
- `src/catchup.ts` (what Catch up lists, whether a branch can ship) and `src/publish.ts` (pull request titles and
  bodies, version bumps, the dated changelog, the release steps) are pure. `src/ship.ts` runs the git commands and
  takes `gh` as a function, so the tests run it against a local bare remote and check the `gh` arguments.
- `src/extension.ts` handles the tab, the startup takeover, the status bar and the activity bar.
- `webview/` is the Preact UI.

To look at the UI with real data outside VS Code:

    npm run build
    node dist/dump-state.js /path/to/a/repo > dist/state.json     # --no-github to skip gh, --days N
    cd dist && python3 -m http.server 8000                         # then open
    # http://127.0.0.1:8000/dev.html?state=state.json  (add &theme=light for the light theme)

`dist/dev.html` with no `?state=` shows an invented sample State, with a roadmap board you can edit (the edits
stay in the page). `dist/state.json` contains your real prompts, so
delete it afterwards; `dist/` is not committed or packaged.
